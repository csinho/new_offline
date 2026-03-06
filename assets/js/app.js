import { idbGet, idbSet, idbClear, idbDel, idbGetAllKeys } from "./idb.js";
import { 
  API_CONFIG, 
  UF_MAP, 
  UF_LIST,
  RACAS_LIST,
  FINALIDADE_LIST,
  CATEGORIA_LIST,
  SEXO_LIST,
  TIPO_ANIMAL_LIST,
  CONDICAO_PAGAMENTO_LIST,
  MOVIMENTACAO_SAIDA_ANIMAL_LIST,
  MOVIMENTACAO_SAIDA_TO_ENTRADA,
  CAUSA_MORTE_LIST,
  TIPO_PESAGEM_LIST,
  PIPELINE_STEPS,
  SYNC_CONFIG,
  OFFLINE_OPS,
  SAIDA_TIPO_TO_OFFLINE_OP,
  DEFAULT_ABA_CAMPOS_KEYS,
} from "./config.js";

const $ = (sel) => document.querySelector(sel);

// Conjunto auxiliar: todas as operações de saída de animais (venda/morte/etc.) usadas na fila offline
const SAIDA_OFFLINE_OP_SET = new Set(Object.values(SAIDA_TIPO_TO_OFFLINE_OP));

// teste

const state = {
  // Lista de módulos habilitados (chaves simples) e configuração rica vinda do GET_MODULOS
  modules: [],
  moduleConfigs: [], // [{ modulo, abas: [{ aba/titulo, campos: [{ key, value, type }] }] }]
  activeKey: null,
  activeFormRoot: null,
  advanced: false,
  ctx: { fazendaId: "", ownerId: "" },
  bootstrapReady: false,
  view: null, // "dashboard" | "module" | "pipeline" (linha de produção)

  // Controle de view do módulo animais
  animalView: "list", // "list" | "form"
  animalEditingId: null, // _id do animal em edição (ou null = criando)
  // Chart.js
  chartSex: null,
  chartSexDesktop: null,
  chartPesoLote: null,
  chartPesoLoteDesktop: null,

  // Linha de produção (frente de caixa / curral): animal em fluxo e passo atual
  pipelineAnimal: null,
  pipelineStepIndex: 0,
  pipelineCreateCallback: null,
  pipelineFromCreate: false,
  pipelineCreatedAnimalId: null,
  pipelineRestoreDraft: false,   // após cancelar criação, reabrir form com rascunho
};

/** Plugin Chart.js: desenha Total no centro do doughnut. Opções em chart.options.plugins.centerText: valueFontSize, labelFontSize */
const chartCenterTextPlugin = {
  id: "centerText",
  afterDraw(chart) {
    const { ctx } = chart;
    const meta = chart.getDatasetMeta(0);
    if (!meta || !meta.data || !meta.data[0]) return;
    const opts = chart.options?.plugins?.centerText || {};
    const valueFontSize = opts.valueFontSize ?? 26;
    const labelFontSize = opts.labelFontSize ?? 12;
    const total = (chart.data.datasets[0].data || []).reduce((a, b) => a + b, 0);
    const { x, y } = meta.data[0];
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#111827";
    ctx.font = `700 ${valueFontSize}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
    ctx.fillText(String(total), x, y - 6);
    ctx.fillStyle = "#6b7280";
    ctx.font = `500 ${labelFontSize}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
    ctx.fillText("Total", x, y + (valueFontSize * 0.4));
    ctx.restore();
  }
};

/** Timer do polling de status da sincronização (id_response). */
let syncPollTimerId = null;
/** True quando esta sessão de polling já finalizou (sucesso ou falha); evita novas buscas. */
let syncPollDone = false;

// ---------------- Navigation State Persistence ----------------

async function saveNavigationState() {
  try {
    const navState = {
      view: state.view || "dashboard",
      activeKey: state.activeKey || null,
      animalView: state.animalView || "list",
      animalEditingId: state.animalEditingId || null,
      timestamp: Date.now()
    };
    await idbSet("meta", "navigationState", navState);
  } catch (e) {
    console.error("[saveNavigationState] Erro ao salvar:", e);
  }
}

async function restoreNavigationState() {
  try {
    const saved = await idbGet("meta", "navigationState");
    if (!saved) return false;

    // Restaura apenas se o estado foi salvo recentemente (últimas 24h)
    const maxAge = 24 * 60 * 60 * 1000; // 24 horas
    if (Date.now() - saved.timestamp > maxAge) {
      return false;
    }

    // Restaura o estado
    if (saved.view) state.view = saved.view;
    if (saved.activeKey) state.activeKey = saved.activeKey;
    if (saved.animalView) state.animalView = saved.animalView;
    if (saved.animalEditingId) state.animalEditingId = saved.animalEditingId;

    return true;
  } catch (e) {
    console.error("[restoreNavigationState] Erro ao restaurar:", e);
    return false;
  }
}

// ---------------- UI helpers ----------------

function safeJsonify(obj) {
  // Remove undefined e garante serializável
  return JSON.parse(JSON.stringify(obj, (k, v) => (v === undefined ? null : v)));
}

function toCloneable(obj) {
  // Tenta structuredClone (melhor) e cai pra JSON sanitize
  try {
    return structuredClone(obj);
  } catch {
    return safeJsonify(obj);
  }
}

function toast(msg) {
  const wrap = $("#toast");
  if (!wrap) return;
  const el = document.createElement("div");
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function setNetBadge() {
  const online = navigator.onLine;
  // Avatar no topo direito do dashboard (desktop e mobile)
  [ $("#dashUserAvatar"), $("#dashUserAvatarMobile") ].filter(Boolean).forEach(el => {
    if (online) el.classList.remove("offline");
    else el.classList.add("offline");
  });
}

function showBoot(msg, hint = "") {
  const o = $("#bootOverlay");
  if (!o) return;
  o.style.display = "flex";
  const sub = $("#bootSub");
  const h = $("#bootHint");
  if (sub) sub.textContent = msg || "Sincronizando dados…";
  if (h) h.textContent = hint || "";
}

const BOOT_MIN_SHOW_MS = 600;

function hideBoot() {
  const o = $("#bootOverlay");
  if (!o) return;
  const start = typeof window.__bootStart === "number" ? window.__bootStart : Date.now();
  const elapsed = Date.now() - start;
  const delay = Math.max(0, BOOT_MIN_SHOW_MS - elapsed);
  if (delay > 0) {
    setTimeout(() => { o.style.display = "none"; }, delay);
  } else {
    o.style.display = "none";
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Normaliza nomes de abas (remove acentos, deixa minúsculo)
function normalizeAbaKeyName(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15) >> 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function prettifyKey(k) {
  return String(k || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function setPageHeadVisible(visible) {
  const head = $("#pageHead");
  if (!head) return;
  head.classList.toggle("hidden", !visible);
}

function setPageHeadTexts(title, sub) {
  const t = $("#pageTitle");
  const s = $("#pageSub");
  if (t) t.textContent = title || "";
  if (s) s.textContent = sub || "";
}

// ---------------- URL / modules ------------

const MODULE_CATALOG = {
  animal: {
    key: "animal",
    label: "Animais",
    icon: "🐮",
    pageTitle: "Animais",
    pageSub: "Gerencie todos os seus animais com facilidade",
    storageKey: "animais",
  },
  vaccine: {
    key: "vaccine",
    label: "Vacinação",
    icon: "💉",
    pageTitle: "Vacinação",
    pageSub: "Registre vacinas offline",
    storageKey: "vacinacao",
  },
  movimentacao: {
    key: "movimentacao",
    label: "Movimentações",
    icon: "📦",
    pageTitle: "Movimentações",
    pageSub: "Entre lotes, pastos e fazendas",
    storageKey: "lotes",
  },
  saida_animais: {
    key: "saida_animais",
    label: "Saída de Animais",
    icon: "🚪",
    pageTitle: "Saída de Animais",
    pageSub: "Venda, morte, empréstimo, ajuste e doação",
    storageKey: "saida_animais",
  },
  manejo: {
    key: "manejo",
    label: "Manejo",
    icon: "🛠️",
    pageTitle: "Manejo",
    pageSub: "Registros de manejo",
    storageKey: "manejo",
  },
  organizacao: {
    key: "organizacao",
    label: "Organização",
    icon: "🏢",
    pageTitle: "Organização",
    pageSub: "Dados da organização",
    storageKey: "organizacao",
  },
  fazenda: {
    key: "fazenda",
    label: "Fazenda",
    icon: "🏡",
    pageTitle: "Fazenda",
    pageSub: "Dados da fazenda",
    storageKey: "fazenda",
  },
  colaboradores: {
    key: "colaboradores",
    label: "Colaboradores",
    icon: "👥",
    pageTitle: "Colaboradores",
    pageSub: "Gestão de colaboradores",
    storageKey: "colaboradores",
  },
  // Aliases / Extras
  vacinacao: {
    key: "vacinacao",
    label: "Vacinação",
    icon: "💉",
    pageTitle: "Vacinação",
    pageSub: "Controle sanitário",
    storageKey: "vacinacao"
  },
  sanidade: {
    key: "sanidade",
    label: "Sanidade",
    icon: "⚕️",
    pageTitle: "Sanidade",
    pageSub: "Controle sanitário",
    storageKey: "sanidade"
  },
  reproducao: {
    key: "reproducao",
    label: "Reprodução",
    icon: "🧬",
    pageTitle: "Reprodução",
    pageSub: "Controle reprodutivo",
    storageKey: "reproducao"
  },
  nutricao: {
    key: "nutricao",
    label: "Nutrição",
    icon: "🌽",
    pageTitle: "Nutrição",
    pageSub: "Controle alimentar",
    storageKey: "nutricao"
  },
  financeiro: {
    key: "financeiro",
    label: "Financeiro",
    icon: "💰",
    pageTitle: "Financeiro",
    pageSub: "Gestão financeira",
    storageKey: "financeiro"
  }
};

async function parseFromURL() {
  const u = new URL(location.href);
  const idParam = (u.searchParams.get("id") || "").trim();
  
  // Novo fluxo: se existe parâmetro "id", busca módulos via API
  if (idParam) {
    try {
      const modulosUrl = API_CONFIG.getModulosUrl(idParam);
      const response = await fetch(modulosUrl);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: Falha ao buscar módulos`);
      }
      
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        console.error("[parseFromURL] JSON inválido na resposta get_modulos:", parseErr);
        console.error("[parseFromURL] Resposta (início):", text.slice(0, 500));
        showBoot(
          "Resposta inválida",
          "A API get_modulos retornou JSON inválido. Verifique o backend (chaves entre aspas duplas, um único objeto/array na raiz)."
        );
        return {
          modules: ["animal"],
          moduleConfigs: [],
          fazendaId: "",
          ownerId: "",
        };
      }
      // Debug: estrutura completa retornada pelo GET_MODULOS
      console.log("[get_modulos] payload bruto:", data);
      
      // Extrai fazenda, user e modules da resposta (mantém compat com owner antigo)
      const fazendaId = String(data?.fazenda || "").trim();
      const colaborador = data?.colaborador;
      const ownerId = typeof colaborador === "object" && colaborador !== null
        ? String(colaborador._id || "").trim()
        : String(colaborador || "").trim();
      // modules pode vir como array ou como um único objeto; normaliza para array
      let rawModules = [];
      if (Array.isArray(data?.modules)) {
        rawModules = data.modules;
      } else if (data?.modules && typeof data.modules === "object") {
        rawModules = [data.modules];
      }
      // Novo modelo: modules é um array de objetos { modulo, abas:[{ aba/titulo, campos:[{key,value,type}]}] }
      const moduleConfigs = rawModules.map((m) => {
        if (typeof m === "string") return { modulo: m };
        if (m && typeof m === "object") return { ...m, abas: Array.isArray(m.abas) ? m.abas.map((a) => ({ ...a })) : [] };
        return null;
      }).filter(Boolean);
      ensureAbasCampos(moduleConfigs);
      const moduleKeys = moduleConfigs.length > 0
        ? moduleConfigs.map((m) => String(m.modulo || m.key || "").trim()).filter(Boolean)
        : ["animal"];
      
      return {
        modules: moduleKeys,
        moduleConfigs,
        fazendaId,
        ownerId,
        initialSyncId: idParam,
      };
    } catch (error) {
      console.error("[parseFromURL] Erro ao buscar módulos:", error);
      showBoot(
        "Erro ao buscar configuração",
        `Não foi possível buscar os módulos. Verifique sua conexão e tente novamente.`
      );
      // Retorna valores vazios para não prosseguir sem dados válidos
      return {
        modules: ["animal"],
        moduleConfigs: [],
        fazendaId: "",
        ownerId: "",
      };
    }
  }
  
  // Fluxo antigo (compatibilidade): lê parâmetros diretamente da URL
  const rawModules = (u.searchParams.get("modules") || "").trim();
  const modules = rawModules.split(",").map((s) => s.trim()).filter(Boolean);
  const fazendaId = (u.searchParams.get("fazenda") || "").trim();
  // Aceita ?user= (novo) ou ?owner= (antigo)
  const ownerId = (u.searchParams.get("colaborador") || u.searchParams.get("user") || u.searchParams.get("owner") || "").trim();

  return {
    modules: modules.length ? modules : ["animal"],
    moduleConfigs: (modules.length ? modules : ["animal"]).map((m) => ({ modulo: m })),
    fazendaId,
    ownerId,
  };
}

function buildModules(keys) {
  return keys.map((k) => MODULE_CATALOG[k] || {
    key: k,
    label: prettifyKey(k),
    pageTitle: prettifyKey(k),
    pageSub: "",
    storageKey: k
  });
}

// Retorna a configuração de módulo/aba vinda do GET_MODULOS (se existir)
function getModuleConfig(moduloKey) {
  if (!Array.isArray(state.moduleConfigs)) return null;
  return state.moduleConfigs.find((m) => String(m.modulo || m.key || "").trim() === String(moduloKey).trim()) || null;
}

/**
 * Garante que cada aba dos módulos tenha "campos" preenchido com todos os atributos conhecidos.
 * - Se "campos" vier vazio ou ausente: insere todos os keys padrão daquele módulo/aba (value: "", type: "OS").
 * - Se "campos" vier com itens: mantém os que o backend enviou (pré-preenchimento key/value/type) e adiciona
 *   os keys padrão que faltarem (value: "", type: "OS").
 * Assim o backend usa "campos" apenas para dizer quais campos nascem com value "X"; o script completa o resto.
 */
function ensureAbasCampos(moduleConfigs) {
  if (!Array.isArray(moduleConfigs)) return;
  for (const config of moduleConfigs) {
    const modulo = String(config.modulo || config.key || "").trim().toLowerCase();
    const abas = Array.isArray(config.abas) ? config.abas : (Array.isArray(config.aba) ? config.aba : []);
    const byModulo = DEFAULT_ABA_CAMPOS_KEYS[modulo];
    if (!byModulo) continue;
    for (const aba of abas) {
      const titulo = (aba.titulo || aba.aba || "").toString().trim();
      const abaKeyNorm = normalizeAbaKeyName(titulo);
      let knownKeys = byModulo[abaKeyNorm];
      if (!knownKeys && modulo === "saida_animais") knownKeys = byModulo.venda;
      if (!Array.isArray(knownKeys) || knownKeys.length === 0) continue;
      const existing = Array.isArray(aba.campos) ? aba.campos : [];
      const existingKeys = new Set(existing.map((c) => String(c.key || "").trim()).filter(Boolean));
      if (existing.length === 0) {
        aba.campos = knownKeys.map((key) => ({ key, value: "", type: "OS" }));
        continue;
      }
      for (const key of knownKeys) {
        if (existingKeys.has(key)) continue;
        existing.push({ key, value: "", type: "OS" });
        existingKeys.add(key);
      }
      aba.campos = existing;
    }
  }
}

// Retorna valor pré-definido de campo para um módulo/aba.
// Para "saida_animais" usamos nome da aba (ex.: "Venda").
// Para "movimentacao" usamos título da aba (ex.: "lotes", "pastos", "fazendas").
function getPrefilledField(moduloKey, abaKey, fieldKey) {
  const cfg = getModuleConfig(moduloKey);
  if (!cfg) return null;
  const abasRaw = Array.isArray(cfg.abas) ? cfg.abas : (Array.isArray(cfg.aba) ? cfg.aba : []);
  if (!abasRaw.length) return null;
  const aba = abasRaw.find((a) => {
    const name = (a.aba || a.titulo || "").toString().trim().toLowerCase();
    return name === String(abaKey || "").toLowerCase();
  });
  if (!aba || !Array.isArray(aba.campos)) return null;
  return aba.campos.find((c) => String(c.key || "").trim() === String(fieldKey || "").trim()) || null;
}

/**
 * Mapeamento key (get_modulos.campos[].key) → id do elemento no DOM.
 * Única fonte de verdade: o script aplica ao formulário qualquer campo que chegar em
 * get_modulos (modules[].abas[].campos[]) cuja key exista neste mapa. Não há regras fixas
 * por key no código — tudo é dinâmico. Ver KEYS_LINHA_DE_PRODUCAO.md para alinhar com o backend.
 */
const FORM_FIELD_IDS = {
  saida_animais: {
    venda: {
      animal: "vendaAnimalBrinco",
      proprietario_destino: "vendaProprietarioDestino",
      fazenda_destino: "vendaFazendaDestino",
      valor: "vendaValor",
      peso_saida: "vendaPeso",
      condicao_pagamento: "vendaCondicaoPagamento",
      movimentacao_saida_animal: "vendaMovimentacaoSaida",
      data_aquisicao: "vendaData",
      nota_fiscal: "vendaNotaFiscal",
      numero_gta: "vendaNumeroGTA",
      data_emissao_gta: "vendaDataEmissaoGTA",
      data_validade_gta: "vendaDataValidadeGTA",
      serie_gta: "vendaSerie",
      uf_gta: "vendaUF",
    },
    emprestimo: {
      // Empréstimo usa apenas estes campos na UI (print): proprietário, fazenda, data, nota e peso.
      proprietario_destino: "vendaProprietarioDestino",
      fazenda_destino: "vendaFazendaDestino",
      data_aquisicao: "vendaData",
      nota_fiscal: "vendaNotaFiscal",
      peso_saida: "vendaPeso",
    },
    doacao: {
      // Doação compartilha o mesmo layout enxuto de Empréstimo/Ajuste.
      proprietario_destino: "vendaProprietarioDestino",
      fazenda_destino: "vendaFazendaDestino",
      data_aquisicao: "vendaData",
      nota_fiscal: "vendaNotaFiscal",
      peso_saida: "vendaPeso",
    },
    "ajuste inventário": {
      // Ajuste inventário compartilha o mesmo layout de Empréstimo.
      proprietario_destino: "vendaProprietarioDestino",
      fazenda_destino: "vendaFazendaDestino",
      data_aquisicao: "vendaData",
      nota_fiscal: "vendaNotaFiscal",
      peso_saida: "vendaPeso",
    },
    morte: {
      causa_morte: "morteCausaMorte",
      detalhes_observacoes: "morteDetalhesObservacoes",
      responsavel: "morteResponsavel",
      data_morte: "morteDataMorte",
      imagem_brinco_animal: "morteImagemBrinco",
      movimentacao_saida_animal: "morteMovimentacaoSaida",
    },
  },
  pesagem: {
    pesagem: {
      colaborador: "pesoColaboradorSelect",
      tipo_pesagem: "pesoTipoPesagem",
      peso: "pesoValorKg",
      data_pesagem: "pesoDataPesagem",
    },
  },
  movimentacao: {
    lotes: { lote: "pipelineMovLoteDestino" },
    pastos: { pasto: "pipelineMovPastoDestino" },
    fazendas: { fazenda_destino: "pipelineMovFazendaDestino", lote: "pipelineMovLoteDestinoFazenda", pasto: "pipelineMovPastoDestinoFazenda" },
  },
};

/**
 * Aplica ao container os valores de campos vindos do get_modulos (totalmente dinâmico).
 * Lê modules[].abas[].campos[] e, para cada item, se a key existir em FORM_FIELD_IDS
 * para esse módulo/aba, define o valor no elemento correspondente. Não há lógica por key
 * no código — apenas key → elementId.
 * moduleKey: ex. "saida_animais" | "movimentacao"
 * abaKey: ex. "Venda" | "lotes" (comparado em lowercase com abas[].titulo)
 */
function applyModulePrefillToContainer(container, moduleKey, abaKey) {
  if (!container || !moduleKey || !abaKey) return;
  const cfg = getModuleConfig(moduleKey);
  if (!cfg) return;
  const abasRaw = Array.isArray(cfg.abas) ? cfg.abas : (Array.isArray(cfg.aba) ? cfg.aba : []);
  const aba = abasRaw.find((a) => {
    const name = normalizeAbaKeyName(a.aba || a.titulo || "");
    return name === normalizeAbaKeyName(abaKey);
  });
  if (!aba || !Array.isArray(aba.campos) || !aba.campos.length) return;
  const abaNorm = normalizeAbaKeyName(abaKey);
  const mapping = FORM_FIELD_IDS[moduleKey]?.[abaNorm];
  if (!mapping) return;
  for (const campo of aba.campos) {
    const key = String(campo.key || "").trim();
    const elementId = mapping[key];
    if (!key || !elementId) continue;
    const el = container.querySelector(`#${elementId}`);
    if (!el) continue;
    const val = campo.value != null ? String(campo.value).trim() : "";

    // Sempre aplica o valor vindo do backend ao elemento (para uso no payload),
    // mas se o valor vier pré-definido (não vazio), o campo fica oculto na UI
    // para o usuário não ver nem editar.
    if (el.tagName === "SELECT") {
      el.value = val;
    } else {
      el.value = val;
      if (el.classList.contains("saVendaInputCurrency") && el.dataset) {
        el.dataset.raw = val;
      }
    }

    // Quando há valor pré-definido, escondemos o campo visualmente.
    if (val !== "") {
      el.dataset.prefillLocked = "1";
      const wrapper =
        el.closest(".saVendaField") ||
        el.closest(".saMovField") ||
        el.closest(".field");
      if (wrapper) {
        wrapper.style.display = "none";
        wrapper.setAttribute("data-prefill-hidden", "1");
      } else {
        el.style.display = "none";
      }
    }
  }
}

// ---------------- Bootstrap Bubble data ----------------
/** Fazenda atual do usuário (management_fazenda). Exibição de dados deve ser sempre relativa a ela. */
function getCurrentFazendaId() {
  return String(state.ctx?.fazendaId || "").trim();
}

/** Filtra lista (animais, lotes, pastos, etc.) pela fazenda atual do usuário. */
function filterByCurrentFazenda(list, fazendaKey = "fazenda") {
  const id = getCurrentFazendaId();
  if (!id || !Array.isArray(list)) return list || [];
  return list.filter((item) => String(item?.[fazendaKey] || "") === id);
}

function getEndpointUrl({ fazendaId, ownerId }) {
  return API_CONFIG.getBootstrapUrl(fazendaId, ownerId);
}

/**
 * Sanitiza números vindos estranhos:
 * - null/undefined/"": -> 0 (quando for campo numérico)
 * - "22,5" -> 22.5
 * - NaN -> 0
 */
function toNumberOrZero(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).trim();
  if (!s) return 0;
  const n = Number(s.replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function normalizeAnimal(a = {}) {
  const out = { ...a };
  // garante ids/strings
  out._id = String(out._id || "");
  out.brinco_padrao = String(out.brinco_padrao || "");
  out.nome_completo = String(out.nome_completo || "");
  out.raca = String(out.raca || "");
  out.sexo = String(out.sexo || "");
  out.categoria = String(out.categoria || "");
  // Limpa data_nascimento: remove "NaN", valores inválidos, e normaliza
  const dataNasc = out.data_nascimento;
  if (!dataNasc || String(dataNasc).toLowerCase() === "nan" || String(dataNasc).trim() === "") {
    out.data_nascimento = "";
  } else {
    const dataStr = String(dataNasc).trim();
    // Se for ISO string válida ou formato YYYY-MM-DD, mantém
    if (/^\d{4}-\d{2}-\d{2}/.test(dataStr) || /^\d{4}-\d{2}-\d{2}T/.test(dataStr)) {
      out.data_nascimento = dataStr;
    } else {
      // Tenta validar como data
      const testDate = new Date(dataStr);
      if (!Number.isNaN(testDate.getTime()) && testDate.getTime()) {
        out.data_nascimento = dataStr;
      } else {
        out.data_nascimento = "";
      }
    }
  }


  // flags
  out.deleted = !!out.deleted;
  out.ativo = out.ativo !== false;
  out.morto = !!out.morto;

  // Preserva flags de sincronização local
  if (a._local !== undefined) out._local = a._local;
  if (a._sync !== undefined) out._sync = String(a._sync || "");

  // Preserva data_modificacao (vinda do servidor) para uso na sync
  if (a.data_modificacao !== undefined) out.data_modificacao = a.data_modificacao;

  // números
  out.peso_atual_kg = toNumberOrZero(out.peso_atual_kg);
  out.peso_nascimento = toNumberOrZero(out.peso_nascimento);
  out.valor_animal = toNumberOrZero(out.valor_animal);

  // listas (list_lotes pode vir com IDs ou objetos { _id } do servidor)
  if (!Array.isArray(out.list_lotes)) out.list_lotes = out.lote ? [out.lote] : [];
  const toLoteId = (id) => (id && typeof id === "object" && id._id != null) ? String(id._id) : String(id || "");
  out.list_lotes = out.list_lotes.map(toLoteId).filter(Boolean);
  out.lote = out.list_lotes.length > 0 ? out.list_lotes[0] : (out.lote ? toLoteId(out.lote) : "");
  // animal 1:1 pasto (id único)
  out.pasto = String(out.pasto || "");
  // Preserva animal_peso (objeto de pesagem: animal, data_pesagem, peso_atual_kg, tipo_equipamento, momento_pesagem, user)
  if (a.animal_peso !== undefined && a.animal_peso !== null) out.animal_peso = a.animal_peso;
  return out;
}

function normalizeLote(l = {}) {
  const out = { ...l };
  out._id = String(out._id || "");
  out.nome_lote = String(out.nome_lote || "");
  out.status = String(out.status || "");
  out.categoria_lote = String(out.categoria_lote || "");
  out.tipo_lote = String(out.tipo_lote || "");

  out.qtd_animais = toNumberOrZero(out.qtd_animais);
  out.peso_medio = toNumberOrZero(out.peso_medio);

  if (l.data_modificacao !== undefined) out.data_modificacao = l.data_modificacao;

  return out;
}

function normalizePasto(p = {}) {
  const out = { ...p };
  out._id = String(out._id || "");
  out.nome = String(out.nome || "");
  out.fazenda = String(out.fazenda || "");

  if (p.data_modificacao !== undefined) out.data_modificacao = p.data_modificacao;

  return out;
}

/** Normaliza item de list_vacinacao preservando data_modificacao do servidor. */
function normalizeVacinacaoItem(v = {}) {
  const out = { ...v };
  out._id = String(out._id || "");
  if (v.data_modificacao !== undefined) out.data_modificacao = v.data_modificacao;
  return out;
}

async function bootstrapData() {
  const { fazendaId, ownerId } = state.ctx;

  // Se não veio param, tenta usar último contexto salvo
  if (!fazendaId || !ownerId) {
    const last = await idbGet("meta", "lastCtx");
    if (last?.fazendaId && last?.ownerId) {
      state.ctx = { fazendaId: last.fazendaId, ownerId: last.ownerId };
    }
  }

  if (!state.ctx.fazendaId || !state.ctx.ownerId) {
    showBoot(
      "Faltam parâmetros na URL",
      "Use: ?id=<id> ou ?modules=animal&fazenda=<id>&user=<id>"
    );
    state.bootstrapReady = false;
    return;
  }

  const cachedCtxKey = `ctx:${state.ctx.fazendaId}:${state.ctx.ownerId}`;
  const cachedOk = await idbGet("meta", cachedCtxKey);

  // OFFLINE: só entra se houver cache
  if (!navigator.onLine) {
    if (!cachedOk) {
      showBoot(
        "Offline sem cache",
        "Abra uma vez com internet para baixar os dados e ativar o modo offline."
      );
      state.bootstrapReady = false;
      return;
    }
    state.bootstrapReady = true;
    hideBoot();
    return;
  }

  // ONLINE: sincroniza
  showBoot("Sincronizando dados…", "Buscando dados do servidor e preparando modo offline.");

  let data;
  let url;

  try {
    url = getEndpointUrl(state.ctx);

    const controller = new AbortController();
    const timeoutMs = 30000; // 30s — get_dados pode demorar com muitos dados
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Lê como texto e faz parse para poder exibir trecho em caso de JSON inválido (erro vem do servidor)
    const rawText = await res.text();
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      const msg = e?.message || String(e);
      const posMatch = msg.match(/position\s+(\d+)/i);
      let detail = msg;
      if (posMatch && rawText.length > 0) {
        const pos = Math.min(Number(posMatch[1]), rawText.length);
        const start = Math.max(0, pos - 60);
        const end = Math.min(rawText.length, pos + 60);
        const snippet = rawText.slice(start, end).replace(/\n/g, " ").replace(/\r/g, "");
        detail = `${msg} Trecho próximo ao erro: "...${snippet}..."`;
      }
      throw new Error(`Falha ao ler JSON: ${detail}`);
    }

    // get_dados: organizacao { _id, colaborador { _id, nome, management_fazenda } }; colaboradores []; list_fazendas [ { fazenda: {...} } ]
    let organizacaoRaw = null;
    let listFazendaObjects = [];
    let fazendaCurrentRaw = null;
    let ownerRaw = null;

    if (data?.organizacao) {
      organizacaoRaw = data.organizacao;
      ownerRaw = data.organizacao.colaborador ?? null;
      if (ownerRaw?.management_fazenda) {
        const mgmtId = String(ownerRaw.management_fazenda).trim();
        if (!state.ctx.fazendaId) state.ctx = { ...state.ctx, fazendaId: mgmtId };
      }
      const listFazendas = Array.isArray(data.list_fazendas) ? data.list_fazendas : [];
      listFazendaObjects = listFazendas.map((item) => item?.fazenda).filter(Boolean);
      const fazendaIdCtx = String(state.ctx.fazendaId || "").trim();
      const userMgmtFazenda = ownerRaw && String(ownerRaw.management_fazenda || "").trim();
      fazendaCurrentRaw = listFazendaObjects.find(
        (f) => String(f?._id || "") === fazendaIdCtx || String(f?._id || "") === userMgmtFazenda
      ) ?? listFazendaObjects[0] ?? null;
    } else {
      fazendaCurrentRaw = data?.fazenda || null;
      const col = data?.colaborador ?? data?.user ?? data?.owner ?? null;
      ownerRaw = typeof col === "object" && col !== null ? col : (col ? { _id: String(col) } : null);
      if (fazendaCurrentRaw) listFazendaObjects = [fazendaCurrentRaw];
    }

    // Listas agregadas: TODOS os itens de TODAS as fazendas
    const allAnimaisRaw = listFazendaObjects.reduce((acc, f) => acc.concat(Array.isArray(f?.list_animais) ? f.list_animais : []), []);
    const allLotesRaw = listFazendaObjects.reduce((acc, f) => acc.concat(Array.isArray(f?.list_lotes) ? f.list_lotes : []), []);
    const allPastosRaw = listFazendaObjects.reduce((acc, f) => acc.concat(Array.isArray(f?.list_pasto) ? f.list_pasto : []), []);
    const allVacinacaoRaw = listFazendaObjects.reduce((acc, f) => acc.concat(Array.isArray(f?.list_vacinacao) ? f.list_vacinacao : []), []);

    // Fazenda leve: não persiste listas duplicadas (animais/lotes/pastos/vacinacao já estão em tabelas próprias com atributo fazenda)
    function fazendaSemListas(f) {
      if (!f || typeof f !== "object") return f;
      const out = { ...f };
      delete out.list_animais;
      delete out.list_lotes;
      delete out.list_pasto;
      delete out.list_vacinacao;
      return out;
    }
    const owner = toCloneable(ownerRaw);
    const fazendaCurrent = toCloneable(fazendaSemListas(fazendaCurrentRaw));
    const organizacao = organizacaoRaw ? toCloneable(organizacaoRaw) : null;
    const listFazendasClone = listFazendaObjects.map((f) => toCloneable(fazendaSemListas(f)));
    const colaboradores = toCloneable(Array.isArray(data?.colaboradores) ? data.colaboradores : []);

    const animaisServidor = toCloneable(allAnimaisRaw.map(normalizeAnimal));
    
    // Preserva animais locais que ainda não foram sincronizados
    // IMPORTANTE: Não normaliza aqui, pois pode perder propriedades _local e _sync
    const animaisLocaisExistentesRaw = (await idbGet("animais", "list")) || [];
    
    
    // Filtra animais locais pendentes ANTES de normalizar
    // Um animal é considerado local/pendente se:
    // 1. Tem _local === true OU _id começa com "local:" (case insensitive)
    // 2. Tem _sync === "pending"
    const animaisLocaisPendentes = Array.isArray(animaisLocaisExistentesRaw) 
      ? animaisLocaisExistentesRaw.filter(a => {
          if (!a || typeof a !== 'object') return false;
          
          const id = String(a._id || "").toLowerCase();
          const idLocal = id.startsWith("local:");
          const localFlag = a._local === true;
          const syncPending = String(a._sync || "").toLowerCase() === "pending";
          
          const isLocal = localFlag || idLocal;
          const isPending = syncPending;
          const resultado = isLocal && isPending;
          
          return resultado;
        })
      : [];
    
    // Todos os animais do servidor (de todas as fazendas), sem remover duplicatas; depois os locais pendentes
    const locaisNormalizados = animaisLocaisPendentes.map((a) =>
      normalizeAnimal({ ...a, _local: true, _sync: "pending" })
    );
    const animaisFinal = [...animaisServidor, ...locaisNormalizados];

    const animaisFinalNormalizados = animaisFinal.map(a => {
      // Se é um animal local pendente, preserva as propriedades explicitamente
      const id = String(a?._id || "").toLowerCase();
      const isLocalPending = (a?._local === true || id.startsWith("local:")) && String(a?._sync || "").toLowerCase() === "pending";
      
      if (isLocalPending) {
        // Garante que _local e _sync sejam preservados mesmo após toCloneable
        return normalizeAnimal({
          ...a,
          _local: true,
          _sync: "pending"
        });
      }
      return normalizeAnimal(a);
    });
    
    const animais = toCloneable(animaisFinalNormalizados);
    
    // DEBUG: Verifica se os animais locais pendentes ainda têm as propriedades após toCloneable
    const animaisLocaisAposClone = animais.filter(a => {
      const id = String(a?._id || "").toLowerCase();
      return (a?._local === true || id.startsWith("local:")) && String(a?._sync || "").toLowerCase() === "pending";
    });
    
    const lotes = toCloneable((Array.isArray(allLotesRaw) ? allLotesRaw : []).map(normalizeLote));
    const pastos = toCloneable((Array.isArray(allPastosRaw) ? allPastosRaw : []).map(normalizePasto));
    const vacinacao = toCloneable((Array.isArray(allVacinacaoRaw) ? allVacinacaoRaw : []).map(normalizeVacinacaoItem));

    // ✅ Gravação com debug por etapa (pra não “sumir” o erro)
    try {
      if (organizacao) await idbSet("organizacao", "current", organizacao);
      await idbSet("colaboradores", "list", colaboradores);
      await idbSet("fazenda", "list", listFazendasClone);
      await idbSet("fazenda", "current", fazendaCurrent);
      await idbSet("owner", "current", owner);
      await idbSet("animais", "list", animais);
      await idbSet("lotes", "list", lotes);
      await idbSet("pastos", "list", pastos);
      await idbSet("vacinacao", "list", vacinacao);

      await idbSet("meta", cachedCtxKey, { cachedAt: Date.now() });
      await idbSet("meta", "lastCtx", { ...state.ctx, cachedAt: Date.now() });
    } catch (e) {
      // Se falhar o IDB, não trava o app: mostra erro real
      console.error("[BOOT][IDB] erro ao salvar:", e);

      // Se já tinha cache, libera com cache antigo
      if (cachedOk) {
        toast("Falha ao salvar atualização. Usando dados offline já existentes.");
        state.bootstrapReady = true;
        hideBoot();
        return;
      }

      // Se não tinha cache, pelo menos não deixa loading eterno:
      showBoot("Sincronização parcial falhou", `Erro ao salvar no IndexedDB: ${e?.message || e}`);
      state.bootstrapReady = false;
      return;
    }

    // ✅ Sucesso total
    state.bootstrapReady = true;
    hideBoot();
    return;

  } catch (err) {
    const isAbort = err?.name === "AbortError";
    const msg = isAbort
      ? "A requisição demorou muito e foi cancelada. Verifique sua conexão ou tente novamente."
      : (err?.message || String(err));
    console.error("[BOOT] falhou:", err?.name || err, msg, { url });

    // Se falhou, mas já tem cache, libera offline com cache
    if (cachedOk) {
      toast("Falha ao sincronizar agora. Usando dados offline salvos.");
      state.bootstrapReady = true;
      hideBoot();
      return;
    }

    // Sem cache: bloqueia
    showBoot(
      "Não foi possível sincronizar",
      `Detalhe: ${msg}`
    );
    state.bootstrapReady = false;
    return;
  }
}

// ---------------- Dashboard: bloco usuário no topo direito (sidebar removido) ----------------
function renderSidebar() {
  renderSidebarUser();
}

/** Preenche o bloco de usuário no topo direito do dashboard (avatar, nome, fazenda). Desktop e mobile podem ter IDs diferentes. */
async function renderSidebarUser() {
  const avatarEls = [ $("#dashUserAvatar"), $("#dashUserAvatarMobile") ].filter(Boolean);
  const nameEls = [ $("#dashUserName"), $("#dashUserNameMobile") ].filter(Boolean);
  const farmEls = [ $("#dashFarmName"), $("#dashFarmNameMobile") ].filter(Boolean);
  if (avatarEls.length === 0 && nameEls.length === 0 && farmEls.length === 0) return;

  const sessionOwner = await idbGet("owner", "current");
  let owner = sessionOwner;
  if (!owner) {
    const fazenda = await idbGet("fazenda", "current");
    const colaboradores = (await idbGet("colaboradores", "list")) || [];
    const principalId = fazenda?.colaborador_principal;
    if (principalId) {
      owner = colaboradores.find(c => String(c._id) === String(principalId)) || owner;
    }
  }
  const name = owner?.nome || "Usuário";
  const firstLetter = name.charAt(0).toUpperCase();

  const fazenda = await idbGet("fazenda", "current");
  const farmName = fazenda?.name || "—";

  const allAnimaisRaw = (await idbGet("animais", "list")) || [];
  const allAnimais = filterByCurrentFazenda(allAnimaisRaw);
  const hasPending = allAnimais.some(a => a._sync === "pending");
  const nameHtml = escapeHtml(name) + (hasPending ? " <span style='font-size:12px;vertical-align:middle' title='Dados pendentes'>☁️</span>" : "");

  avatarEls.forEach(el => {
    el.textContent = firstLetter;
    if (navigator.onLine) el.classList.remove("offline");
    else el.classList.add("offline");
  });
  nameEls.forEach(el => { el.innerHTML = nameHtml; });
  farmEls.forEach(el => { el.textContent = farmName; });
}

// ---------------- Linha de produção (Pipeline) ----------------
const PIPELINE_STEP_LABELS = {
  movimentacao: "Movimentação",
  pesagem: "Pesagem",
  saida_animais: "Saída de animais"
};

/** Abas suportadas no passo de movimentação (pipeline). Ordem padrão. */
const MOVIMENTACAO_ABA_KEYS = ["lotes", "pastos", "fazendas"];
/** Títulos exibidos por aba */
const MOVIMENTACAO_ABA_LABELS = { lotes: "Entre lotes", pastos: "Entre pastos", fazendas: "Entre fazendas" };

/** Retorna o div onde o conteúdo dos passos do pipeline é renderizado (dentro do dashboard). */
function getPipelineContainer() {
  return document.getElementById("pipelineStepContent");
}

/** Mostra o modal (dois cards) e esconde a área de passos; volta ao início do fluxo. */
function showPipelineModalView() {
  state.pipelineAnimal = null;
  state.pipelineStepIndex = 0;
  state.pipelineCreatedAnimalId = null;

  // Limpa busca de animal no dashboard (input e resultados)
  const inputBrinco = document.getElementById("pipelineSearchBrinco");
  const resultsEl = document.getElementById("pipelineSearchResults");
  if (inputBrinco) inputBrinco.value = "";
  if (resultsEl) {
    resultsEl.innerHTML = "";
    resultsEl.hidden = true;
  }

  // No dashboard raiz, o card de pendências só aparece com ≥1 dado pendente e online
  const hasPending = Array.isArray(state.pendingSyncListForCard) && state.pendingSyncListForCard.length > 0;
  setPendingSyncCardVisible(hasPending && state.view === "dashboard" && navigator.onLine);

  const modal = document.getElementById("pipelineModal");
  const stepContent = document.getElementById("pipelineStepContent");
  if (modal) modal.hidden = false;
  if (stepContent) stepContent.hidden = true;
}

/** Modal de confirmação: "Deseja cancelar a criação do animal?" (já na fila). Retorna Promise<boolean>. */
function confirmPipelineCancelCreate() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "pipelineConfirmOverlay";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:99999;";
    overlay.innerHTML = `
      <div class="pipelineConfirmCard" style="background:#fff;border-radius:12px;padding:24px;max-width:360px;box-shadow:0 8px 24px rgba(0,0,0,0.15);">
        <p style="margin:0 0 20px;font-size:15px;color:#111827;">Deseja cancelar a criação do animal? Essa criação já foi adicionada à fila de sincronização.</p>
        <div style="display:flex;gap:12px;justify-content:flex-end;">
          <button type="button" class="pipelineConfirmBtnNo" style="padding:8px 16px;border:1px solid #d1d5db;background:#fff;border-radius:8px;cursor:pointer;">Não</button>
          <button type="button" class="pipelineConfirmBtnYes" style="padding:8px 16px;background:#edff77;border:none;border-radius:8px;cursor:pointer;font-weight:600;">Sim, cancelar</button>
        </div>
      </div>`;
    const remove = () => { overlay.remove(); };
    overlay.querySelector(".pipelineConfirmBtnNo").onclick = () => { remove(); resolve(false); };
    overlay.querySelector(".pipelineConfirmBtnYes").onclick = () => { remove(); resolve(true); };
    overlay.addEventListener("click", (e) => { if (e.target === overlay) { remove(); resolve(false); } });
    document.body.appendChild(overlay);
  });
}

/**
 * Modal de confirmação ao voltar no pipeline.
 * @param {string} currentStepName - Nome do módulo atual (ex.: "Saída de animais").
 * @param {string|null} previousStepName - Nome do módulo anterior. Se null, está voltando para o dashboard (só uma pergunta).
 * @returns {Promise<boolean>}
 */
function confirmPipelineLoseData(currentStepName, previousStepName) {
  const isGoingToDashboard = previousStepName == null || previousStepName === "";
  const message = isGoingToDashboard
    ? "Os dados preenchidos nesta tela serão perdidos. Deseja voltar?"
    : `Os dados preenchidos nesta tela serão perdidos. Ao voltar, você retornará ao módulo "${previousStepName}" e poderá alterar o que foi feito lá. Deseja voltar?`;
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "pipelineConfirmOverlay";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:99999;";
    overlay.innerHTML = `
      <div class="pipelineConfirmCard" style="background:#fff;border-radius:12px;padding:24px;max-width:400px;box-shadow:0 8px 24px rgba(0,0,0,0.15);">
        <p style="margin:0 0 20px;font-size:15px;color:#111827;">${escapeHtml(message)}</p>
        <div style="display:flex;gap:12px;justify-content:flex-end;">
          <button type="button" class="pipelineConfirmBtnNo" style="padding:8px 16px;border:1px solid #d1d5db;background:#fff;border-radius:8px;cursor:pointer;">Não</button>
          <button type="button" class="pipelineConfirmBtnYes" style="padding:8px 16px;background:#edff77;border:none;border-radius:8px;cursor:pointer;font-weight:600;">Sim, voltar</button>
        </div>
      </div>`;
    const remove = () => { overlay.remove(); };
    overlay.querySelector(".pipelineConfirmBtnNo").onclick = () => { remove(); resolve(false); };
    overlay.querySelector(".pipelineConfirmBtnYes").onclick = () => { remove(); resolve(true); };
    overlay.addEventListener("click", (e) => { if (e.target === overlay) { remove(); resolve(false); } });
    document.body.appendChild(overlay);
  });
}

/** Liga eventos do modal da linha de produção (no dashboard) uma vez. */
function bindPipelineModalOnce() {
  const modal = document.getElementById("pipelineModal");
  if (!modal || modal.dataset.pipelineBound === "1") return;
  modal.dataset.pipelineBound = "1";

  const inputBrinco = document.getElementById("pipelineSearchBrinco");
  const resultsEl = document.getElementById("pipelineSearchResults");
  let searchDebounce = null;

  async function searchPipelineBrinco(query) {
    const q = String(query || "").trim();
    if (!q) { resultsEl.hidden = true; resultsEl.innerHTML = ""; return; }
    const raw = (await idbGet("animais", "list")) || [];
    const animais = filterByCurrentFazenda(raw).filter((a) => !a.deleted).map(normalizeAnimal);
    const lower = q.toLowerCase();
    const matches = animais.filter((a) => String(a.brinco_padrao || "").toLowerCase().includes(lower));
    if (matches.length === 0) {
      resultsEl.innerHTML = '<div class="pipelineResultItem pipelineResultEmpty">Nenhum animal encontrado</div>';
      resultsEl.hidden = false;
      return;
    }
    const nome = (a) => String(a.nome_completo || "").trim() || "—";
    resultsEl.innerHTML = matches.slice(0, 10).map((a) =>
      `<button type="button" class="pipelineResultItem" data-id="${escapeHtml(a._id)}" data-brinco="${escapeHtml(a.brinco_padrao || "")}">${escapeHtml(a.brinco_padrao || "—")} — ${escapeHtml(nome(a))}</button>`
    ).join("");
    resultsEl.hidden = false;
  }

  if (inputBrinco && resultsEl) {
    inputBrinco.addEventListener("input", () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => searchPipelineBrinco(inputBrinco.value), 200);
    });
    inputBrinco.addEventListener("focus", () => { if (inputBrinco.value.trim()) searchPipelineBrinco(inputBrinco.value); });
    resultsEl.addEventListener("click", async (e) => {
      const btn = e.target.closest(".pipelineResultItem[data-id]");
      if (!btn || btn.classList.contains("pipelineResultEmpty")) return;
      const id = btn.dataset.id;
      const animaisList = (await idbGet("animais", "list")) || [];
      const animal = animaisList.find((a) => String(a._id) === String(id));
      if (!animal) return;
      state.pipelineAnimal = normalizeAnimal(animal);
      state.pipelineStepIndex = 0;
      const pipelineModal = document.getElementById("pipelineModal");
      const stepContent = document.getElementById("pipelineStepContent");
      if (pipelineModal) pipelineModal.hidden = true;
      if (stepContent) stepContent.hidden = false;
       // Dentro do fluxo da linha de produção: esconde o card de pendências
      setPendingSyncCardVisible(false);
      await renderPipelineStep(0);
    });
  }

  const btnCreate = document.getElementById("pipelineBtnCreate");
  if (btnCreate) {
    btnCreate.addEventListener("click", async () => {
      state.pipelineFromCreate = true;
      state.pipelineCreatedAnimalId = null;
      state.pipelineCreateCallback = (newAnimal) => {
        state.pipelineAnimal = newAnimal;
        state.pipelineStepIndex = 0;
        state.pipelineCreateCallback = null;
        moveAnimalFormBackToContainer();
        renderPipelineStep(0);
      };
      state.activeKey = "animal";
      state.animalView = "form";
      state.animalEditingId = null;
      const pipelineModal = document.getElementById("pipelineModal");
      const stepContent = document.getElementById("pipelineStepContent");
      const wrap = document.getElementById("pipelineWrap");
      const secForm = $("#modAnimaisForm");
      if (pipelineModal) pipelineModal.hidden = true;
      if (stepContent) {
        stepContent.hidden = false;
        stepContent.innerHTML = ""; // só pode aparecer 1 passo por vez: remove Pesagem/Movimentação/Saída
        if (secForm) stepContent.appendChild(secForm);
      }
      if (wrap) {
        wrap.classList.remove("pipelineWrap--saida", "pipelineWrap--movimentacao", "pipelineWrap--pesagem");
        wrap.classList.add("pipelineWrap--animalForm");
      }
      if (stepContent) stepContent.classList.add("pipelineStepContent--animalForm");
      setPendingSyncCardVisible(false);
      await openAnimalFormForCreate();
      renderSidebar();
    });
  }
}

/** Move o form de animal de volta para #animalModuleContainer (após salvar no pipeline ou voltar). */
function moveAnimalFormBackToContainer() {
  const stepContent = document.getElementById("pipelineStepContent");
  const animalContainer = $("#animalModuleContainer");
  const secForm = $("#modAnimaisForm");
  if (secForm && animalContainer && secForm.parentNode === stepContent) {
    animalContainer.appendChild(secForm);
  }
  const wrap = document.getElementById("pipelineWrap");
  if (wrap) wrap.classList.remove("pipelineWrap--animalForm");
  if (stepContent) stepContent.classList.remove("pipelineStepContent--animalForm");
}

/** Garante que o modal do pipeline está visível ou que o passo atual está sendo exibido (chamado ao abrir o dashboard). */
function ensurePipelineModalReady() {
  const pipelineModal = document.getElementById("pipelineModal");
  const stepContent = document.getElementById("pipelineStepContent");
  if (!pipelineModal || !stepContent) return;

  bindPipelineModalOnce();

  if (!state.pipelineAnimal) {
    pipelineModal.hidden = false;
    stepContent.hidden = true;
    // No dashboard raiz: card de pendências só aparece com ≥1 dado pendente e online
    const hasPending = Array.isArray(state.pendingSyncListForCard) && state.pendingSyncListForCard.length > 0;
    setPendingSyncCardVisible(hasPending && state.view === "dashboard" && navigator.onLine);
  } else {
    pipelineModal.hidden = true;
    stepContent.hidden = false;
    // Dentro do fluxo (qualquer passo): card de pendências some
    setPendingSyncCardVisible(false);
    renderPipelineStep(state.pipelineStepIndex);
  }
}

/** Passos do pipeline que temos tela implementada (ordem vem de state.modules do GET). */
const PIPELINE_STEP_KEYS_IMPLEMENTED = ["movimentacao", "pesagem", "saida_animais"];

/** Renderiza o passo atual do pipeline (movimentação, pesagem ou saída) com o animal já selecionado. */
async function renderPipelineStep(stepIndex) {
  const container = getPipelineContainer();
  if (!container) return;
  const wrap = document.getElementById("pipelineWrap");
  if (wrap) {
    wrap.classList.remove("pipelineWrap--saida", "pipelineWrap--movimentacao", "pipelineWrap--pesagem");
  }
  container.classList.remove("pipelineStepContent--saida", "pipelineStepContent--movimentacao", "pipelineStepContent--pesagem");
  const fromModules = (state.modules || []).map(m => m.key).filter(k => PIPELINE_STEP_KEYS_IMPLEMENTED.includes(k));
  const steps = fromModules.length > 0 ? fromModules : (PIPELINE_STEPS || []);
  const animal = state.pipelineAnimal;

  // Voltar antes do primeiro passo ou fim do fluxo: volta para a pergunta inicial (dashboard)
  if (stepIndex < 0 || stepIndex >= steps.length || !animal) {
    // Primeiro limpa o estado do pipeline para que isDashboardRoot fique true
    state.pipelineAnimal = null;
    state.pipelineStepIndex = 0;
    state.pipelineCreatedAnimalId = null;
    // Recarrega a lista de pendências antes de mostrar o modal (para card e FAB usarem dados atualizados)
    try {
      const pendingList = await getPendingSyncList();
      state.pendingSyncListForCard = pendingList;
      if (pendingList.length > 0 && (state.pendingSyncPage === undefined || state.pendingSyncPage < 0)) {
        state.pendingSyncPage = 0;
      }
    } catch (e) {
      console.error("Erro ao atualizar pendências ao sair do pipeline:", e);
    }
    // Volta visualmente para o dashboard (modal visível, passo escondido)
    showPipelineModalView();
    const isDashboardRoot = state.view === "dashboard" && !state.pipelineAnimal;
    const hasPending = Array.isArray(state.pendingSyncListForCard) && state.pendingSyncListForCard.length > 0;
    if (hasPending && isDashboardRoot && navigator.onLine) {
      setPendingSyncCardVisible(true);
      renderPendingSyncCard();
    } else {
      setPendingSyncCardVisible(false);
    }
    updateFabSyncVisibility();
    if (hasPending && isDashboardRoot) {
      checkSyncStatus();
    }
    return;
  }

  const stepKey = steps[stepIndex];
  const stepLabel = PIPELINE_STEP_LABELS[stepKey] || stepKey;
  const isLast = stepIndex >= steps.length - 1;
  const previousStepLabel = stepIndex > 0 ? (PIPELINE_STEP_LABELS[steps[stepIndex - 1]] || steps[stepIndex - 1]) : null;

  if (stepKey === "movimentacao") {
    await renderPipelineStepMovimentacao(container, animal, stepIndex, isLast, previousStepLabel);
    return;
  }
  if (stepKey === "pesagem") {
    await renderPipelineStepPesagem(container, animal, stepIndex, isLast, previousStepLabel);
    return;
  }
  if (stepKey === "saida_animais") {
    await renderPipelineStepSaida(container, animal, stepIndex, isLast, previousStepLabel);
    return;
  }

  container.innerHTML = `
    <div class="pipelineStepHead">
      <button type="button" class="pipelineBackBtn" id="pipelineBackBtn">&larr; Voltar</button>
      <h2 class="pipelineStepTitle">${escapeHtml(stepLabel)}</h2>
    </div>
    <div class="pipelineStepPlaceholder"><p>Passo: ${escapeHtml(stepLabel)}</p><button type="button" class="pipelineCardBtn" id="pipelineBtnNext">Próximo</button></div>`;
  document.getElementById("pipelineBackBtn")?.addEventListener("click", async () => {
    const ok = await confirmPipelineLoseData(stepLabel, previousStepLabel);
    if (ok) await renderPipelineStep(stepIndex - 1);
  });
  document.getElementById("pipelineBtnNext")?.addEventListener("click", () => renderPipelineStep(stepIndex + 1));
}

async function renderPipelineStepMovimentacao(container, animal, stepIndex, isLast, previousStepLabel) {
  const pipelineWrap = document.getElementById("pipelineWrap");
  if (pipelineWrap) pipelineWrap.classList.add("pipelineWrap--movimentacao");
  container.classList.add("pipelineStepContent--movimentacao");

  const movConfig = getModuleConfig("movimentacao");
  const abasRaw = Array.isArray(movConfig?.abas) ? movConfig.abas : [];
  const tabList = abasRaw.length
    ? abasRaw
        .map((a) => String(a.titulo || a.aba || "").trim().toLowerCase())
        .filter((t) => MOVIMENTACAO_ABA_KEYS.includes(t))
        .filter((t, i, arr) => arr.indexOf(t) === i)
    : [...MOVIMENTACAO_ABA_KEYS];
  const activeTab = tabList[0] || "lotes";

  const lotesRaw = (await idbGet("lotes", "list")) || [];
  const pastosRaw = (await idbGet("pastos", "list")) || [];
  const lotes = filterByCurrentFazenda(lotesRaw);
  const pastos = filterByCurrentFazenda(pastosRaw);
  const listFazendas = (await idbGet("fazenda", "list")) || [];
  const fazendaAtualId = getCurrentFazendaId();
  const org = await idbGet("organizacao", "current");
  const organizacaoId = org?._id || org?.organizacao || null;
  const sameOrgId = (f) => {
    if (!organizacaoId) return true;
    const fOrg = f?.organizacao_id ?? f?.organizacao ?? (typeof f?.organizacao === "object" ? f?.organizacao?._id : null);
    return String(fOrg || "") === String(organizacaoId);
  };
  const fazendasDestino = listFazendas.filter(
    (f) => String(f._id || "") !== fazendaAtualId && sameOrgId(f)
  );

  const prefillLote = getPrefilledField("movimentacao", "lotes", "lote");
  const origemLotePredefinida = !!(prefillLote && prefillLote.type === "BD" && prefillLote.value);
  let loteOrigemId = (origemLotePredefinida ? String(prefillLote.value).trim() : (animal.lote || (Array.isArray(animal.list_lotes) && animal.list_lotes[0]) || "").toString().trim());
  const loteOrigem = loteOrigemId ? lotes.find((l) => String(l._id) === String(loteOrigemId)) : null;

  const prefillPasto = getPrefilledField("movimentacao", "pastos", "pasto");
  const origemPastoPredefinida = !!(prefillPasto && prefillPasto.type === "BD" && prefillPasto.value);
  let pastoOrigemId = origemPastoPredefinida ? String(prefillPasto.value).trim() : "";
  const pastoOrigem = pastoOrigemId ? pastos.find((p) => String(p._id) === String(pastoOrigemId)) : null;

  const animalLabel = `Brinco ${escapeHtml(animal.brinco_padrao || "—")} — ${escapeHtml(String(animal.nome_completo || "").trim() || "—")}`;
  const loteOptions = lotes.map((l) => `<option value="${escapeHtml(l._id)}">${escapeHtml(l.nome_lote || "—")}</option>`).join("");
  const pastoOptions = (pastos || []).map((p) => `<option value="${escapeHtml(p._id)}">${escapeHtml(p.nome || "—")}</option>`).join("");
  const fazendaOptions = fazendasDestino.map((f) => `<option value="${escapeHtml(f._id)}">${escapeHtml(f.name || "—")}</option>`).join("");

  const origemLoteHtml = origemLotePredefinida
    ? `<p class="pipelineFieldValue">${escapeHtml(loteOrigem?.nome_lote || "—")}</p>`
    : `<select id="pipelineMovLoteOrigem" class="saVendaSelect pipelineSelect"><option value="">Selecione o lote de origem</option>${loteOptions}</select>`;
  const origemPastoHtml = origemPastoPredefinida
    ? `<p class="pipelineFieldValue">${escapeHtml(pastoOrigem?.nome || "—")}</p>`
    : `<select id="pipelineMovPastoOrigem" class="saVendaSelect pipelineSelect"><option value="">Selecione o pasto de origem</option>${pastoOptions}</select>`;

  const tabsHtml = tabList
    .map(
      (tabKey) =>
        `<span class="movTab pipelineMovTab pipelineMovTab--step ${tabKey === activeTab ? "active" : ""}" data-tab="${tabKey}" role="tab" aria-selected="${tabKey === activeTab}">${escapeHtml(MOVIMENTACAO_ABA_LABELS[tabKey] || tabKey)}</span>`
    )
    .join("");
  const contentLotesHtml =
    tabList.includes("lotes") ?
      `<div class="movContent pipelineMovContent" id="pipelineMovContentLotes" data-tab="lotes" ${activeTab !== "lotes" ? "hidden" : ""}>
        <div class="saVendaFormGrid saMovFormGrid">
          <div class="saVendaField"><label>Lote de origem</label>${origemLoteHtml}</div>
          <div class="saVendaField"><label for="pipelineMovLoteDestino">Lote de destino</label>
            <select id="pipelineMovLoteDestino" class="saVendaSelect pipelineSelect"><option value="">Selecione o lote</option></select>
          </div>
        </div>
      </div>`
    : "";
  const contentPastosHtml =
    tabList.includes("pastos") ?
      `<div class="movContent pipelineMovContent" id="pipelineMovContentPastos" data-tab="pastos" ${activeTab !== "pastos" ? "hidden" : ""}>
        <div class="saVendaFormGrid saMovFormGrid">
          <div class="saVendaField"><label>Pasto de origem</label>${origemPastoHtml}</div>
          <div class="saVendaField"><label for="pipelineMovPastoDestino">Pasto de destino</label>
            <select id="pipelineMovPastoDestino" class="saVendaSelect pipelineSelect"><option value="">Selecione o pasto</option>${(pastos || []).filter((p) => String(p._id) !== pastoOrigemId).map((p) => `<option value="${escapeHtml(p._id)}">${escapeHtml(p.nome || "—")}</option>`).join("")}</select>
          </div>
        </div>
      </div>`
    : "";
  const contentFazendasHtml =
    tabList.includes("fazendas") ?
      `<div class="movContent pipelineMovContent" id="pipelineMovContentFazendas" data-tab="fazendas" ${activeTab !== "fazendas" ? "hidden" : ""}>
        <div class="saVendaFormGrid saMovFormGrid" style="grid-template-columns: 1fr;">
          <div class="saVendaField"><label>Origem (lote/pasto)</label>
            <div class="movToggleGroup" style="display:flex;gap:8px;margin-bottom:8px;">
              <button type="button" class="movToggleBtn pipelineMovToggleOrigemLote movToggleBtnActive" data-type="lote">Lote</button>
              <button type="button" class="movToggleBtn pipelineMovToggleOrigemPasto" data-type="pasto">Pasto</button>
            </div>
            <select id="pipelineMovLoteOrigemFazenda" class="saVendaSelect pipelineSelect" style="margin-top:4px;"><option value="">Selecione o lote de origem</option>${loteOptions}</select>
            <select id="pipelineMovPastoOrigemFazenda" class="saVendaSelect pipelineSelect" style="margin-top:4px;display:none;"><option value="">Selecione o pasto de origem</option>${pastoOptions}</select>
          </div>
          <div class="saVendaField"><label for="pipelineMovFazendaDestino">Fazenda de destino</label>
            <select id="pipelineMovFazendaDestino" class="saVendaSelect pipelineSelect"><option value="">Selecione a fazenda</option>${fazendaOptions}</select>
          </div>
          <div class="saVendaField"><label>Destino (lote ou pasto na fazenda de destino)</label>
            <div class="movToggleGroup" style="display:flex;gap:8px;margin-bottom:8px;">
              <button type="button" class="movToggleBtn movToggleBtnActive pipelineMovToggleDestinoLote" data-type="lote">Lote</button>
              <button type="button" class="movToggleBtn pipelineMovToggleDestinoPasto" data-type="pasto">Pasto</button>
            </div>
            <select id="pipelineMovLoteDestinoFazenda" class="saVendaSelect pipelineSelect" style="margin-top:4px;"><option value="">Selecione o lote de destino</option></select>
            <select id="pipelineMovPastoDestinoFazenda" class="saVendaSelect pipelineSelect" style="margin-top:4px;display:none;"><option value="">Selecione o pasto de destino</option></select>
          </div>
        </div>
      </div>`
    : "";

  container.innerHTML = `
    <div class="saVendaForm saMovForm" id="saMovForm">
      <div class="pageHead">
        <div class="pageHeadRow1">
          <button type="button" class="animalFormBackBtn" id="pipelineBackBtn" aria-label="Voltar">&larr; Voltar</button>
          <div class="pageHeadActions">
            <button type="button" class="animalFormHeaderBtn btnSaveAnimal" id="saMovBtnAvançar" style="display:none;">Avançar</button>
            <button type="button" class="animalFormHeaderBtn btnSaveAnimal" id="saMovBtnConcluir">${isLast ? "Concluir" : "Próximo"}</button>
          </div>
        </div>
        <div class="pageHeadRow2">
          <h1 class="pageTitle">${escapeHtml(PIPELINE_STEP_LABELS.movimentacao)}</h1>
          <p class="pageSub">Altere lote, pasto ou fazenda do animal selecionado</p>
          <p class="saVendaHeaderAnimal">${animalLabel}</p>
        </div>
      </div>
      <div class="saVendaFormBody saVendaFormOnly">
        <div class="saVendaFormCard">
          ${tabList.length > 1 ? `<div class="movTabs pipelineMovTabs" role="tablist">${tabsHtml}</div>` : ""}
          ${contentLotesHtml}
          ${contentPastosHtml}
          ${contentFazendasHtml}
        </div>
      </div>
    </div>
  `;

  let currentTab = activeTab;
  const contents = { lotes: container.querySelector("#pipelineMovContentLotes"), pastos: container.querySelector("#pipelineMovContentPastos"), fazendas: container.querySelector("#pipelineMovContentFazendas") };
  const tabButtons = container.querySelectorAll(".pipelineMovTab");
  const btnAvançar = document.getElementById("saMovBtnAvançar");
  const btnConcluir = document.getElementById("saMovBtnConcluir");

  function getCurrentTabIndex() {
    const idx = tabList.indexOf(currentTab);
    return idx >= 0 ? idx : 0;
  }
  function hasNextTab() {
    return tabList.length > 1 && getCurrentTabIndex() < tabList.length - 1;
  }
  function isMovimentacaoTabValid() {
    if (currentTab === "lotes") {
      const selDest = document.getElementById("pipelineMovLoteDestino");
      const selOrig = document.getElementById("pipelineMovLoteOrigem");
      const destId = selDest?.value?.trim();
      if (!destId) return false;
      if (!origemLotePredefinida) {
        const origemId = selOrig?.value?.trim() || "";
        if (!origemId) return false;
      }
      return true;
    }
    if (currentTab === "pastos") {
      const selDest = document.getElementById("pipelineMovPastoDestino");
      const selOrig = document.getElementById("pipelineMovPastoOrigem");
      const destId = selDest?.value?.trim();
      if (!destId) return false;
      if (!origemPastoPredefinida) {
        const origemId = selOrig?.value?.trim() || "";
        if (!origemId) return false;
      }
      return true;
    }
    if (currentTab === "fazendas") {
      const selFaz = document.getElementById("pipelineMovFazendaDestino");
      const selLote = document.getElementById("pipelineMovLoteDestinoFazenda");
      const selPasto = document.getElementById("pipelineMovPastoDestinoFazenda");
      const fazendaDestinoId = selFaz?.value?.trim();
      const loteDestId = selLote?.value?.trim();
      const pastoDestId = selPasto?.value?.trim();
      return !!(fazendaDestinoId && (loteDestId || pastoDestId));
    }
    return false;
  }

  function updateMovimentacaoHeaderButtons() {
    if (btnAvançar && btnConcluir) {
      const showAvançar = hasNextTab();
      btnAvançar.style.display = showAvançar ? "" : "none";
      btnConcluir.style.display = showAvançar ? "none" : "";
      btnConcluir.textContent = isLast ? "Concluir" : "Próximo";
      const valid = isMovimentacaoTabValid();
      btnAvançar.disabled = !valid;
      btnAvançar.classList.toggle("pipelineBtnAvançarActive", valid);
    }
  }

  function setActiveTab(tabKey) {
    currentTab = tabKey;
    tabButtons.forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tabKey);
      b.setAttribute("aria-selected", b.dataset.tab === tabKey ? "true" : "false");
    });
    MOVIMENTACAO_ABA_KEYS.forEach((k) => {
      const el = contents[k];
      if (el) el.hidden = k !== tabKey;
    });
    updateMovimentacaoHeaderButtons();
  }
  updateMovimentacaoHeaderButtons();

  const selectLoteDestino = document.getElementById("pipelineMovLoteDestino");
  const selectLoteOrigem = document.getElementById("pipelineMovLoteOrigem");
  function fillLoteDestinoOptions(origemId) {
    if (!selectLoteDestino) return;
    const opts = lotes
      .filter((l) => String(l._id) !== String(origemId))
      .map((l) => `<option value="${escapeHtml(l._id)}">${escapeHtml(l.nome_lote || "—")}</option>`)
      .join("");
    selectLoteDestino.innerHTML = `<option value="">Selecione o lote</option>${opts}`;
  }
  fillLoteDestinoOptions(origemLotePredefinida ? loteOrigemId : "");
  if (selectLoteOrigem && !origemLotePredefinida) {
    if (loteOrigemId) selectLoteOrigem.value = loteOrigemId;
    selectLoteOrigem.addEventListener("change", () => {
      fillLoteDestinoOptions(selectLoteOrigem.value || "");
      updateMovimentacaoHeaderButtons();
    });
  }
  selectLoteDestino?.addEventListener("change", updateMovimentacaoHeaderButtons);

  const selectPastoDestino = document.getElementById("pipelineMovPastoDestino");
  const selectPastoOrigem = document.getElementById("pipelineMovPastoOrigem");
  if (selectPastoOrigem && !origemPastoPredefinida && selectPastoDestino) {
    selectPastoOrigem.addEventListener("change", () => {
      const orig = selectPastoOrigem.value || "";
      selectPastoDestino.innerHTML = `<option value="">Selecione o pasto</option>${(pastos || []).filter((p) => String(p._id) !== orig).map((p) => `<option value="${escapeHtml(p._id)}">${escapeHtml(p.nome || "—")}</option>`).join("")}`;
      updateMovimentacaoHeaderButtons();
    });
  }
  selectPastoDestino?.addEventListener("change", updateMovimentacaoHeaderButtons);

  const selFazendaDestino = document.getElementById("pipelineMovFazendaDestino");
  const selLoteOrigemFaz = document.getElementById("pipelineMovLoteOrigemFazenda");
  const selPastoOrigemFaz = document.getElementById("pipelineMovPastoOrigemFazenda");
  const selLoteDestinoFaz = document.getElementById("pipelineMovLoteDestinoFazenda");
  const selPastoDestinoFaz = document.getElementById("pipelineMovPastoDestinoFazenda");
  let origemTipoFaz = "lote";
  let destinoTipoFaz = "lote";
  // Origem (lote/pasto) em "Entre fazendas" só é preenchido pelo get_modulos (applyModulePrefillToContainer); não usar animal para não vir default quando nada chegou
  const togglesOrigemLote = container.querySelectorAll(".pipelineMovToggleOrigemLote");
  const togglesOrigemPasto = container.querySelectorAll(".pipelineMovToggleOrigemPasto");
  const togglesDestinoLote = container.querySelectorAll(".pipelineMovToggleDestinoLote");
  const togglesDestinoPasto = container.querySelectorAll(".pipelineMovToggleDestinoPasto");
  function updateFazendaToggles() {
    togglesOrigemLote.forEach((b) => b.classList.toggle("movToggleBtnActive", origemTipoFaz === "lote"));
    togglesOrigemPasto.forEach((b) => b.classList.toggle("movToggleBtnActive", origemTipoFaz === "pasto"));
    togglesDestinoLote.forEach((b) => b.classList.toggle("movToggleBtnActive", destinoTipoFaz === "lote"));
    togglesDestinoPasto.forEach((b) => b.classList.toggle("movToggleBtnActive", destinoTipoFaz === "pasto"));
    if (selLoteOrigemFaz) selLoteOrigemFaz.style.display = origemTipoFaz === "lote" ? "block" : "none";
    if (selPastoOrigemFaz) selPastoOrigemFaz.style.display = origemTipoFaz === "pasto" ? "block" : "none";
    if (selLoteDestinoFaz) selLoteDestinoFaz.style.display = destinoTipoFaz === "lote" ? "block" : "none";
    if (selPastoDestinoFaz) selPastoDestinoFaz.style.display = destinoTipoFaz === "pasto" ? "block" : "none";
  }
  togglesOrigemLote.forEach((b) => b.addEventListener("click", () => { origemTipoFaz = "lote"; updateFazendaToggles(); }));
  togglesOrigemPasto.forEach((b) => b.addEventListener("click", () => { origemTipoFaz = "pasto"; updateFazendaToggles(); }));
  togglesDestinoLote.forEach((b) => b.addEventListener("click", () => { destinoTipoFaz = "lote"; updateFazendaToggles(); }));
  togglesDestinoPasto.forEach((b) => b.addEventListener("click", () => { destinoTipoFaz = "pasto"; updateFazendaToggles(); }));
  updateFazendaToggles();
  selFazendaDestino?.addEventListener("change", async () => {
    const fid = selFazendaDestino?.value || "";
    if (!fid) {
      if (selLoteDestinoFaz) selLoteDestinoFaz.innerHTML = "<option value=\"\">Selecione o lote de destino</option>";
      if (selPastoDestinoFaz) selPastoDestinoFaz.innerHTML = "<option value=\"\">Selecione o pasto de destino</option>";
      updateMovimentacaoHeaderButtons();
      return;
    }
    const lotesList = (await idbGet("lotes", "list")) || [];
    const pastosList = (await idbGet("pastos", "list")) || [];
    const lotesDest = lotesList.filter((l) => String(l?.fazenda) === String(fid));
    const pastosDest = pastosList.filter((p) => String(p?.fazenda) === String(fid));
    if (selLoteDestinoFaz) selLoteDestinoFaz.innerHTML = "<option value=\"\">Selecione o lote de destino</option>" + lotesDest.map((l) => `<option value="${escapeHtml(l._id)}">${escapeHtml(l.nome_lote || "—")}</option>`).join("");
    if (selPastoDestinoFaz) selPastoDestinoFaz.innerHTML = "<option value=\"\">Selecione o pasto de destino</option>" + pastosDest.map((p) => `<option value="${escapeHtml(p._id)}">${escapeHtml(p.nome || "—")}</option>`).join("");
    updateMovimentacaoHeaderButtons();
  });
  selLoteDestinoFaz?.addEventListener("change", updateMovimentacaoHeaderButtons);
  selPastoDestinoFaz?.addEventListener("change", updateMovimentacaoHeaderButtons);

  // Pré-preenchimento dinâmico: aplica ao formulário o que chegou em get_modulos (lotes, pastos, fazendas)
  applyModulePrefillToContainer(container, "movimentacao", "lotes");
  applyModulePrefillToContainer(container, "movimentacao", "pastos");
  applyModulePrefillToContainer(container, "movimentacao", "fazendas");
  if (selFazendaDestino?.value) selFazendaDestino.dispatchEvent(new Event("change", { bubbles: true }));
  updateMovimentacaoHeaderButtons();

  document.getElementById("pipelineBackBtn")?.addEventListener("click", async () => {
    const ok = await confirmPipelineLoseData(PIPELINE_STEP_LABELS.movimentacao, previousStepLabel);
    if (!ok) return;
    if (stepIndex === 0 && state.pipelineCreatedAnimalId) {
      const okCancel = await confirmPipelineCancelCreate();
      if (!okCancel) return;
      const animalId = state.pipelineCreatedAnimalId;
      const arr = (await idbGet("animais", "list")) || [];
      const draft = arr.find((a) => String(a._id) === String(animalId));
      if (draft) try { sessionStorage.setItem("pipelineCreateDraft", JSON.stringify(draft)); } catch (_) {}
      const qKey = `queue:${state.ctx.fazendaId || ""}:${state.ctx.ownerId || ""}:animal`;
      const queue = (await idbGet("records", qKey)) || [];
      const newQueue = queue.filter((op) => !(op.op === "animal_create" && String(op.payload?._id) === String(animalId)));
      await idbSet("records", qKey, newQueue);
      const newArr = arr.filter((a) => String(a._id) !== String(animalId));
      await idbSet("animais", "list", newArr);
      state.pipelineCreatedAnimalId = null;
      state.pipelineAnimal = null;
      state.pipelineStepIndex = 0;
      state.pipelineRestoreDraft = true;
      state.pipelineFromCreate = true;
      state.pipelineCreateCallback = (newAnimal) => {
        state.pipelineAnimal = newAnimal;
        state.pipelineStepIndex = 0;
        state.pipelineCreateCallback = null;
        moveAnimalFormBackToContainer();
        renderPipelineStep(0);
      };
      const pipelineModal = document.getElementById("pipelineModal");
      const stepContent = document.getElementById("pipelineStepContent");
      const wrap = document.getElementById("pipelineWrap");
      const secForm = $("#modAnimaisForm");
      if (pipelineModal) pipelineModal.hidden = true;
      if (stepContent) {
        stepContent.hidden = false;
        stepContent.innerHTML = ""; // só pode aparecer 1 passo por vez
        if (secForm) stepContent.appendChild(secForm);
      }
      if (wrap) {
        wrap.classList.remove("pipelineWrap--saida", "pipelineWrap--movimentacao", "pipelineWrap--pesagem");
        wrap.classList.add("pipelineWrap--animalForm");
      }
      if (stepContent) stepContent.classList.add("pipelineStepContent--animalForm");
      await openAnimalFormForCreate();
      renderSidebar();
      updateFabSyncVisibility();
      return;
    }
    if (stepIndex === 0) { showPipelineModalView(); return; }
    await renderPipelineStep(stepIndex - 1);
  });

  async function persistCurrentTabAndAdvance(goToNextTab) {
    const arr = (await idbGet("animais", "list")) || [];
    const idx = arr.findIndex((a) => String(a._id) === String(animal._id));
    if (idx === -1) { toast("Animal não encontrado."); return false; }
    const prev = arr[idx];
    const qKey = `queue:${state.ctx.fazendaId || ""}:${state.ctx.ownerId || ""}:animal`;

    if (currentTab === "lotes") {
      const destId = selectLoteDestino?.value?.trim();
      if (!destId) { toast("Selecione o lote de destino."); return false; }
      let origemId = loteOrigemId;
      if (!origemLotePredefinida) origemId = selectLoteOrigem?.value?.trim() || "";
      if (!origemId) { toast("Selecione o lote de origem."); return false; }
      const updated = normalizeAnimal({ ...prev, lote: destId, list_lotes: [destId], _local: prev._local || true, _sync: "pending", data_modificacao: prev.data_modificacao });
      arr[idx] = updated;
      const queue = (await idbGet("records", qKey)) || [];
      queue.push({ op: OFFLINE_OPS.MOVIMENTACAO_ENTRE_LOTES, at: Date.now(), payload: updated, targetId: animal._id });
      await idbSet("records", qKey, queue);
    } else if (currentTab === "pastos") {
      const destId = selectPastoDestino?.value?.trim();
      if (!destId) { toast("Selecione o pasto de destino."); return false; }
      let origemId = pastoOrigemId;
      if (!origemPastoPredefinida) origemId = selectPastoOrigem?.value?.trim() || "";
      if (!origemId) { toast("Selecione o pasto de origem."); return false; }
      const updated = normalizeAnimal({ ...prev, pasto: destId, _local: prev._local || true, _sync: "pending", data_modificacao: prev.data_modificacao });
      arr[idx] = updated;
      const queue = (await idbGet("records", qKey)) || [];
      queue.push({ op: OFFLINE_OPS.MOVIMENTACAO_ENTRE_PASTOS, at: Date.now(), payload: updated, targetId: animal._id });
      await idbSet("records", qKey, queue);
    } else if (currentTab === "fazendas") {
      const fazendaDestinoId = selFazendaDestino?.value?.trim();
      const loteDestId = selLoteDestinoFaz?.value?.trim();
      const pastoDestId = selPastoDestinoFaz?.value?.trim();
      if (!fazendaDestinoId || (!loteDestId && !pastoDestId)) {
        toast("Selecione a fazenda de destino e um lote ou pasto de destino.");
        return false;
      }
      const updated = normalizeAnimal({
        ...prev,
        fazenda: fazendaDestinoId,
        lote: loteDestId || "",
        pasto: pastoDestId || "",
        list_lotes: loteDestId ? [loteDestId] : [],
        _local: prev._local || true,
        _sync: "pending",
        data_modificacao: prev.data_modificacao,
      });
      arr[idx] = updated;
      const qKeyDest = `queue:${fazendaDestinoId}:${state.ctx.ownerId || ""}:animal`;
      const queueDest = (await idbGet("records", qKeyDest)) || [];
      queueDest.push({ op: OFFLINE_OPS.MOVIMENTACAO_ENTRE_FAZENDAS, at: Date.now(), payload: updated, targetId: animal._id });
      await idbSet("records", qKeyDest, queueDest);
    }

    await idbSet("animais", "list", arr);
    state.pipelineAnimal = arr[idx] || state.pipelineAnimal;
    updateFabSyncVisibility();
    if (goToNextTab) {
      const nextIndex = getCurrentTabIndex() + 1;
      if (nextIndex < tabList.length) setActiveTab(tabList[nextIndex]);
    } else {
      await renderPipelineStep(stepIndex + 1);
    }
    return true;
  }

  btnAvançar?.addEventListener("click", async () => {
    await persistCurrentTabAndAdvance(true);
  });
  document.getElementById("saMovBtnConcluir")?.addEventListener("click", async () => {
    await persistCurrentTabAndAdvance(false);
  });
}

async function renderPipelineStepPesagem(container, animal, stepIndex, isLast, previousStepLabel) {
  const pipelineWrap = document.getElementById("pipelineWrap");
  if (pipelineWrap) pipelineWrap.classList.add("pipelineWrap--pesagem");
  container.classList.add("pipelineStepContent--pesagem");

  const pesagemConfig = getModuleConfig("pesagem");
  const fazendaAtual = await idbGet("fazenda", "current");
  const organizacaoCurrent = await idbGet("organizacao", "current");
  const orgIdFazenda = fazendaAtual?.organizacao_id ?? (typeof fazendaAtual?.organizacao === "object" ? fazendaAtual?.organizacao?._id : fazendaAtual?.organizacao) ?? null;
  const orgId = orgIdFazenda || organizacaoCurrent?._id || organizacaoCurrent?.organizacao || null;
  const colaboradoresRaw = await idbGet("colaboradores", "list");
  const colaboradoresAll = Array.isArray(colaboradoresRaw) ? colaboradoresRaw : (state.colaboradoresList || []);
  const colaboradores = orgId
    ? colaboradoresAll.filter((c) => {
        const cOrg = c?.organizacao_id ?? (typeof c?.organizacao === "object" ? c?.organizacao?._id : c?.organizacao) ?? null;
        if (cOrg) return String(cOrg) === String(orgId);
        if (Array.isArray(c?.fazendas) && fazendaAtual?._id) return c.fazendas.some((f) => String(f) === String(fazendaAtual._id));
        return true;
      })
    : colaboradoresAll;
  const colabOptions = colaboradores.length
    ? colaboradores
        .map((c) => `<option value="${escapeHtml(c._id || "")}">${escapeHtml(c.nome || "—")}</option>`)
        .join("")
    : "";
  const tipoOptions = TIPO_PESAGEM_LIST.map(
    (t) => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`
  ).join("");
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const animalLabel = `Brinco ${escapeHtml(animal.brinco_padrao || "—")} — ${escapeHtml(String(animal.nome_completo || "").trim() || "—")}`;

  container.innerHTML = `
    <div class="saVendaForm saMovForm" id="pipelinePesagemForm">
      <div class="pageHead">
        <div class="pageHeadRow1">
          <button type="button" class="animalFormBackBtn" id="pipelinePesagemBackBtn" aria-label="Voltar">← Voltar</button>
          <div class="pageHeadActions">
            <button type="button" class="animalFormHeaderBtn btnSaveAnimal" id="pipelinePesagemSalvarBtn" disabled>${isLast ? "Concluir pesagem" : "Salvar pesagem"}</button>
          </div>
        </div>
        <div class="pageHeadRow2">
          <h1 class="pageTitle">${escapeHtml(PIPELINE_STEP_LABELS.pesagem)}</h1>
          <p class="pageSub">Cadastre ou atualize pesagens aqui</p>
          <p class="saVendaHeaderAnimal">${animalLabel}</p>
        </div>
      </div>
      <div class="saVendaFormBody saVendaFormOnly">
        <div class="saVendaFormCard">
          <div class="saVendaFormGrid pipelinePesagemGrid">
            <div class="saVendaField">
              <label for="pesoColaboradorSelect">Colaborador <span class="saVendaRequired">*</span></label>
              <select id="pesoColaboradorSelect" class="saVendaSelect" required>
                <option value="">Escolha um colaborador</option>${colabOptions}
              </select>
            </div>
            <div class="saVendaField">
              <label for="pesoTipoPesagem">Tipo da pesagem <span class="saVendaRequired">*</span></label>
              <select id="pesoTipoPesagem" class="saVendaSelect" required>
                <option value="">Escolha o tipo de pesagem</option>${tipoOptions}
              </select>
            </div>
            <div class="saVendaField">
              <label for="pesoValorKg">Valor em Kilograma <span class="saVendaRequired">*</span></label>
              <div class="saVendaCurrencyWrap">
                <span class="saVendaCurrencyPrefix" aria-hidden="true">Kg</span>
                <input type="number" id="pesoValorKg" class="saVendaInput" placeholder="0,00" min="0" step="0.01" inputmode="decimal" />
              </div>
            </div>
            <div class="saVendaField">
              <label for="pesoDataPesagem">Data da pesagem <span class="saVendaRequired">*</span></label>
              <input type="date" id="pesoDataPesagem" class="saVendaInput" value="${today}" />
            </div>
          </div>
        </div>
      </div>
      <!-- Modal Confirmar pesagem -->
      <div id="pesagemModalConfirm" class="saVendaModalOverlay" hidden aria-modal="true" role="dialog" aria-labelledby="pesagemModalTitle">
        <div class="saVendaModal">
          <div class="saVendaModalHeader">
            <h2 id="pesagemModalTitle" class="saVendaModalTitle">Confirmar pesagem</h2>
            <p class="saVendaModalSub">Revise os detalhes antes de confirmar a pesagem do animal.</p>
            <button type="button" class="saVendaModalClose" id="pesagemModalClose" aria-label="Fechar">&times;</button>
          </div>
          <div class="saVendaModalBody">
            <div class="saVendaModalDetalhes">
              <div class="saVendaModalCol">
                <p class="saVendaModalDetalhe"><span class="saVendaModalDetalheLabel">Animal:</span> <span id="pesagemModalAnimal">—</span></p>
                <p class="saVendaModalDetalhe"><span class="saVendaModalDetalheLabel">Colaborador:</span> <span id="pesagemModalColaborador">—</span></p>
                <p class="saVendaModalDetalhe"><span class="saVendaModalDetalheLabel">Tipo da pesagem:</span> <span id="pesagemModalTipo">—</span></p>
                <p class="saVendaModalDetalhe"><span class="saVendaModalDetalheLabel">Valor (kg):</span> <span id="pesagemModalPeso">—</span></p>
                <p class="saVendaModalDetalhe"><span class="saVendaModalDetalheLabel">Data da pesagem:</span> <span id="pesagemModalData">—</span></p>
              </div>
            </div>
            <div class="saVendaModalAviso">
              <span class="saVendaModalAvisoIcon" aria-hidden="true">&#9888;</span>
              <span>Por favor, confira se as informações estão corretas. Essa ação não poderá ser desfeita!</span>
            </div>
          </div>
          <div class="saVendaModalFooter">
            <button type="button" class="saVendaModalBtn saVendaModalBtnCancel" id="pesagemModalCancel">Cancelar</button>
            <button type="button" class="saVendaModalBtn saVendaModalBtnConfirm" id="pesagemModalConfirmBtn">Confirmar pesagem</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // Prefill dinâmico vindo do get_modulos (aba "Pesagem")
  if (pesagemConfig) {
    applyModulePrefillToContainer(container, "pesagem", "Pesagem");
  }

  const btnBack = container.querySelector("#pipelinePesagemBackBtn");
  const btnSalvar = container.querySelector("#pipelinePesagemSalvarBtn");
  const colaboradorSelect = container.querySelector("#pesoColaboradorSelect");
  const tipoSelect = container.querySelector("#pesoTipoPesagem");
  const pesoInput = container.querySelector("#pesoValorKg");
  const dataInput = container.querySelector("#pesoDataPesagem");

  const updateBtnState = () => {
    const hasColaborador = !!colaboradorSelect?.value?.trim();
    const hasTipo = !!tipoSelect?.value?.trim();
    const pesoVal = Number(pesoInput?.value) || 0;
    const hasPeso = pesoVal > 0;
    const hasData = !!dataInput?.value;
    const ok = hasColaborador && hasTipo && hasPeso && hasData;
    if (btnSalvar) btnSalvar.disabled = !ok;
  };

  colaboradorSelect?.addEventListener("change", updateBtnState);
  tipoSelect?.addEventListener("change", updateBtnState);
  pesoInput?.addEventListener("input", updateBtnState);
  dataInput?.addEventListener("change", updateBtnState);
  updateBtnState();

  const modalOverlay = container.querySelector("#pesagemModalConfirm");
  const modalCloseBtn = container.querySelector("#pesagemModalClose");
  const modalCancelBtn = container.querySelector("#pesagemModalCancel");
  const modalConfirmBtn = container.querySelector("#pesagemModalConfirmBtn");

  function formatBrDatePesagem(isoDate) {
    if (!isoDate || !String(isoDate).trim()) return "—";
    const s = String(isoDate).trim().slice(0, 10);
    if (s.length < 10) return s || "—";
    const [y, m, d] = s.split("-");
    return `${d}/${m}/${y}`;
  }

  function openPesagemModal(data) {
    if (!modalOverlay) return;
    const set = (id, text) => {
      const el = container.querySelector(`#${id}`);
      if (el) el.textContent = text ?? "—";
    };
    set("pesagemModalAnimal", data.animalLabel);
    set("pesagemModalColaborador", data.colaboradorNome);
    set("pesagemModalTipo", data.tipoPesagem);
    set("pesagemModalPeso", data.pesoTexto);
    set("pesagemModalData", data.dataTexto);
    modalOverlay.hidden = false;
  }

  function closePesagemModal() {
    if (modalOverlay) modalOverlay.hidden = true;
  }

  if (modalCloseBtn) modalCloseBtn.addEventListener("click", closePesagemModal);
  if (modalCancelBtn) modalCancelBtn.addEventListener("click", closePesagemModal);
  if (modalOverlay) {
    modalOverlay.addEventListener("click", (e) => {
      if (e.target === modalOverlay) closePesagemModal();
    });
  }

  btnBack?.addEventListener("click", async () => {
    const ok = await confirmPipelineLoseData(PIPELINE_STEP_LABELS.pesagem, previousStepLabel);
    if (ok) {
      container.classList.remove("pipelineStepContent--pesagem");
      if (pipelineWrap) pipelineWrap.classList.remove("pipelineWrap--pesagem");
      await renderPipelineStep(stepIndex - 1);
    }
  });

  btnSalvar?.addEventListener("click", () => {
    const colaboradorId = colaboradorSelect?.value?.trim();
    const tipoPesagem = tipoSelect?.value?.trim();
    const pesoVal = Number(pesoInput?.value) || 0;
    const dataVal = dataInput?.value;

    if (!colaboradorId) {
      toast("Selecione o Colaborador.");
      return;
    }
    if (!tipoPesagem) {
      toast("Selecione o Tipo da pesagem.");
      return;
    }
    if (!pesoVal || pesoVal <= 0) {
      toast("Informe o valor em Kilograma.");
      return;
    }
    if (!dataVal) {
      toast("Informe a Data da pesagem.");
      return;
    }

    const colaboradorNome = colaboradores.find((c) => String(c._id) === String(colaboradorId))?.nome || colaboradorSelect?.options?.[colaboradorSelect.selectedIndex]?.textContent?.trim() || "—";
    openPesagemModal({
      animalLabel: `${animal.brinco_padrao || "—"} — ${String(animal.nome_completo || "").trim() || "—"}`,
      colaboradorNome,
      tipoPesagem,
      pesoTexto: `${pesoVal} kg`,
      dataTexto: formatBrDatePesagem(dataVal),
    });
  });

  if (modalConfirmBtn) {
    modalConfirmBtn.addEventListener("click", async () => {
      const colaboradorId = colaboradorSelect?.value?.trim();
      const tipoPesagem = tipoSelect?.value?.trim();
      const pesoVal = Number(pesoInput?.value) || 0;
      const dataVal = dataInput?.value;
      if (!colaboradorId || !tipoPesagem || !pesoVal || !dataVal) {
        closePesagemModal();
        return;
      }

      const dataIso = new Date(dataVal).toISOString();
      const animalPeso = {
        animal: animal._id,
        data_pesagem: dataIso,
        peso_atual_kg: pesoVal,
        tipo_equipamento: "Manual",
        momento_pesagem: tipoPesagem || "Pesagem regular",
        user: colaboradorId,
      };

      const arr = (await idbGet("animais", "list")) || [];
      const idx = arr.findIndex((a) => String(a._id) === String(animal._id));
      if (idx !== -1) {
        const prev = arr[idx];
        const updated = normalizeAnimal({
          ...prev,
          animal_peso: animalPeso,
          peso_atual_kg: pesoVal,
          _local: prev._local || true,
          _sync: "pending",
          data_modificacao: prev.data_modificacao,
        });
        arr[idx] = updated;
        await idbSet("animais", "list", arr);
        const qKey = `queue:${state.ctx.fazendaId || ""}:${state.ctx.ownerId || ""}:animal`;
        const queue = (await idbGet("records", qKey)) || [];
        const withoutPeso = queue.filter(
          (item) => !(item.op === OFFLINE_OPS.ANIMAL_CREATE_PESO && String(item.payload?.animal) === String(animal._id))
        );
        withoutPeso.push({
          _id: `local:${uuid()}`,
          op: OFFLINE_OPS.ANIMAL_CREATE_PESO,
          at: Date.now(),
          payload: animalPeso,
        });
        await idbSet("records", qKey, withoutPeso);
        updateFabSyncVisibility();
      }
      closePesagemModal();
      toast("Pesagem registrada. Será sincronizada quando houver conexão.");
      await renderPipelineStep(stepIndex + 1);
    });
  }
}

/** Labels das abas do módulo saida_animais (para exibição) */
const SAIDA_ABA_LABELS = {
  venda: "Venda",
  morte: "Morte",
  emprestimo: "Empréstimo",
  "ajuste inventario": "Ajuste inventário",
  doacao: "Doação",
};

async function renderPipelineStepSaida(container, animal, stepIndex, isLast, previousStepLabel) {
  const pipelineWrap = document.getElementById("pipelineWrap");
  if (pipelineWrap) pipelineWrap.classList.add("pipelineWrap--saida");
  container.classList.add("pipelineStepContent--saida");

  const saidaConfig = getModuleConfig("saida_animais");
  const abasRaw = Array.isArray(saidaConfig?.abas) ? saidaConfig.abas : [];
  const tabList = abasRaw.length > 0
    ? abasRaw.map((a) => normalizeAbaKeyName(a.aba || a.titulo || "")).filter(Boolean)
    : ["venda", "morte", "emprestimo", "ajuste inventário", "doacao"];
  const activeTab = tabList[0] || "venda";
  const animalLabel = `Brinco ${escapeHtml(animal.brinco_padrao || "—")} — ${escapeHtml(String(animal.nome_completo || "").trim() || "—")}`;

  const tabsHtml = tabList
    .map(
      (tabKey) =>
        `<span class="movTab pipelineMovTab pipelineMovTab--step ${tabKey === activeTab ? "active" : ""}" data-tab="${escapeHtml(tabKey)}" role="tab">${escapeHtml(SAIDA_ABA_LABELS[tabKey] || tabKey)}</span>`
    )
    .join("");

  container.innerHTML = `
    <div class="saVendaForm saMovForm" id="saMovFormSaida">
      <div class="pageHead">
        <div class="pageHeadRow1">
          <button type="button" class="animalFormBackBtn" id="pipelineSaidaBackBtn" aria-label="Voltar">&larr; Voltar</button>
          <div class="pageHeadActions">
            <button type="button" class="animalFormHeaderBtn btnSaveAnimal" id="saidaBtnAvançar" style="display:none;">Avançar</button>
            <button type="button" class="animalFormHeaderBtn btnSaveAnimal" id="saidaBtnConcluir">${isLast ? "Concluir" : "Próximo"}</button>
          </div>
        </div>
        <div class="pageHeadRow2">
          <h1 class="pageTitle" id="saidaHeaderTitle">${escapeHtml(PIPELINE_STEP_LABELS.saida_animais)}</h1>
          <p class="pageSub" id="saidaHeaderSub">Registre a saída do animal</p>
          <p class="saVendaHeaderAnimal">${animalLabel}</p>
        </div>
      </div>
      <div class="saVendaFormBody saVendaFormOnly">
        <div class="saVendaFormCard">
          ${tabList.length > 1 ? `<div class="movTabs pipelineMovTabs" role="tablist">${tabsHtml}</div>` : ""}
          <div id="pipelineSaidaFormWrap" class="pipelineSaidaFormWrap"></div>
        </div>
      </div>
    </div>
  `;

  state.pipelineStepIndex = stepIndex;
  let currentTab = activeTab;
  const formWrap = document.getElementById("pipelineSaidaFormWrap");
  const btnAvançar = document.getElementById("saidaBtnAvançar");
  const btnConcluir = document.getElementById("saidaBtnConcluir");
  const headerTitleEl = container.querySelector("#saidaHeaderTitle");
  const headerSubEl = container.querySelector("#saidaHeaderSub");

  function getCurrentTabIndex() {
    const idx = tabList.indexOf(currentTab);
    return idx >= 0 ? idx : 0;
  }
  function hasNextTab() {
    return tabList.length > 1 && getCurrentTabIndex() < tabList.length - 1;
  }
  function updateSaidaHeaderForTab() {
    const label = SAIDA_ABA_LABELS[currentTab] || currentTab;
    if (headerTitleEl) {
      headerTitleEl.textContent = `${PIPELINE_STEP_LABELS.saida_animais} — ${label}`;
    }
    if (headerSubEl) {
      const lower = String(label).toLowerCase();
      let sub;
      if (currentTab === "morte") {
        sub = "Registre a morte do animal";
      } else if (currentTab === "emprestimo") {
        sub = "Registre o empréstimo do animal";
      } else if (currentTab === "ajuste inventario") {
        sub = "Registre um ajuste de inventário";
      } else if (currentTab === "ajuste inventário") {
        sub = "Registre um ajuste de inventário";
      } else if (currentTab === "doacao") {
        sub = "Registre a doação do animal";
      } else {
        // Venda ou qualquer outra aba de saída
        sub = "Registre a saída do animal";
      }
      headerSubEl.textContent = sub;
    }
  }
  function setTabActive(tabKey) {
    currentTab = tabKey;
    container.querySelectorAll(".pipelineMovTab[data-tab]").forEach((t) => {
      t.classList.toggle("active", t.getAttribute("data-tab") === tabKey);
    });
    updateSaidaHeaderForTab();
  }
  function advanceOrFinish() {
    if (hasNextTab()) {
      const nextIdx = getCurrentTabIndex() + 1;
      const nextTab = tabList[nextIdx];
      setTabActive(nextTab);
      renderSaidaTabContent(nextTab);
      if (btnAvançar) btnAvançar.style.display = "none";
      if (btnConcluir) btnConcluir.style.display = "";
      if (nextIdx < tabList.length - 1) {
        if (btnConcluir) btnConcluir.textContent = "Próximo";
      } else {
        if (btnConcluir) btnConcluir.textContent = isLast ? "Concluir" : "Próximo";
      }
    } else {
      container.classList.remove("pipelineStepContent--saida");
      if (pipelineWrap) pipelineWrap.classList.remove("pipelineWrap--saida");
      renderPipelineStep(stepIndex + 1);
    }
  }
  async function renderSaidaTabContent(tabKey) {
    if (!formWrap) return;
    currentTab = tabKey;
    updateSaidaHeaderForTab();
    if (tabKey === "venda") {
      await renderSaidaAnimaisVendaForm(formWrap, {
        preselectedAnimal: animal,
        onAfterConfirm: () => advanceOrFinish(),
        onBack: async () => {
          const ok = await confirmPipelineLoseData(PIPELINE_STEP_LABELS.saida_animais, previousStepLabel);
          if (ok) {
            container.classList.remove("pipelineStepContent--saida");
            if (pipelineWrap) pipelineWrap.classList.remove("pipelineWrap--saida");
            await renderPipelineStep(stepIndex - 1);
          }
        },
      });
      if (hasNextTab()) {
        if (btnAvançar) btnAvançar.style.display = "none";
        if (btnConcluir) btnConcluir.style.display = "";
      }
      return;
    }
    if (tabKey === "ajuste inventario") {
      if (btnConcluir) {
        btnConcluir.textContent = "Realizar ajuste de inventário";
      }
      await renderSaidaAnimaisVendaForm(formWrap, {
        preselectedAnimal: animal,
        mode: "ajuste",
        headerButton: btnConcluir,
        onAfterConfirm: () => advanceOrFinish(),
        onBack: async () => {
          const ok = await confirmPipelineLoseData(PIPELINE_STEP_LABELS.saida_animais, previousStepLabel);
          if (ok) {
            container.classList.remove("pipelineStepContent--saida");
            if (pipelineWrap) pipelineWrap.classList.remove("pipelineWrap--saida");
            await renderPipelineStep(stepIndex - 1);
          }
        },
      });
      if (hasNextTab()) {
        if (btnAvançar) btnAvançar.style.display = "none";
        if (btnConcluir) btnConcluir.style.display = "";
      }
      return;
    }
    if (tabKey === "emprestimo") {
      if (btnConcluir) {
        btnConcluir.textContent = "Realizar empréstimo de animais";
      }
      await renderSaidaAnimaisVendaForm(formWrap, {
        preselectedAnimal: animal,
        mode: "emprestimo",
        headerButton: btnConcluir,
        onAfterConfirm: () => advanceOrFinish(),
        onBack: async () => {
          const ok = await confirmPipelineLoseData(PIPELINE_STEP_LABELS.saida_animais, previousStepLabel);
          if (ok) {
            container.classList.remove("pipelineStepContent--saida");
            if (pipelineWrap) pipelineWrap.classList.remove("pipelineWrap--saida");
            await renderPipelineStep(stepIndex - 1);
          }
        },
      });
      if (hasNextTab()) {
        if (btnAvançar) btnAvançar.style.display = "none";
        if (btnConcluir) btnConcluir.style.display = "";
      }
      return;
    }
    if (tabKey === "doacao") {
      if (btnConcluir) {
        btnConcluir.textContent = "Realizar doação de animais";
      }
      await renderSaidaAnimaisVendaForm(formWrap, {
        preselectedAnimal: animal,
        mode: "doacao",
        headerButton: btnConcluir,
        onAfterConfirm: () => advanceOrFinish(),
        onBack: async () => {
          const ok = await confirmPipelineLoseData(PIPELINE_STEP_LABELS.saida_animais, previousStepLabel);
          if (ok) {
            container.classList.remove("pipelineStepContent--saida");
            if (pipelineWrap) pipelineWrap.classList.remove("pipelineWrap--saida");
            await renderPipelineStep(stepIndex - 1);
          }
        },
      });
      if (hasNextTab()) {
        if (btnAvançar) btnAvançar.style.display = "none";
        if (btnConcluir) btnConcluir.style.display = "";
      }
      return;
    }
    if (tabKey === "morte") {
      await renderSaidaAnimaisMorteForm(formWrap, animal, { 
        headerButton: btnConcluir,
        onAfterConfirm: () => advanceOrFinish(),
        onBack: async () => {
          const ok = await confirmPipelineLoseData("Registro de morte", previousStepLabel);
          if (ok) {
            setTabActive("venda");
            renderSaidaTabContent("venda");
            if (btnAvançar) btnAvançar.style.display = "none";
            if (btnConcluir) btnConcluir.style.display = "";
            if (btnConcluir) btnConcluir.textContent = isLast ? "Concluir" : "Próximo";
          }
        },
      });
      return;
    }
    formWrap.innerHTML = `
      <div class="saVendaFormCard" style="padding:2rem;text-align:center;">
        <p class="pageSub" style="margin:0;">Formulário "${escapeHtml(SAIDA_ABA_LABELS[tabKey] || tabKey)}" em preparação.</p>
        <button type="button" class="pipelineCardBtn" id="saidaPlaceholderAvançar" style="margin-top:1rem;">Avançar</button>
      </div>`;
    formWrap.querySelector("#saidaPlaceholderAvançar")?.addEventListener("click", () => advanceOrFinish());
  }

  document.getElementById("pipelineSaidaBackBtn")?.addEventListener("click", async () => {
    if (getCurrentTabIndex() === 0) {
      const ok = await confirmPipelineLoseData(PIPELINE_STEP_LABELS.saida_animais, previousStepLabel);
      if (ok) {
        container.classList.remove("pipelineStepContent--saida");
        if (pipelineWrap) pipelineWrap.classList.remove("pipelineWrap--saida");
        await renderPipelineStep(stepIndex - 1);
      }
    } else {
      const prevTab = tabList[getCurrentTabIndex() - 1];
      setTabActive(prevTab);
      renderSaidaTabContent(prevTab);
      if (btnConcluir) btnConcluir.style.display = "";
      if (btnAvançar) btnAvançar.style.display = "none";
    }
  });
  if (btnConcluir) {
    btnConcluir.style.display = tabList.length > 1 ? "" : "";
    btnConcluir.addEventListener("click", () => {});
  }
  await renderSaidaTabContent(activeTab);
}

/** Formulário e popup de registro de morte (aba Morte — linha de produção; animal já definido). */
async function renderSaidaAnimaisMorteForm(container, animal, options = {}) {
  if (!container) return;
  const headerBtn = options.headerButton || null;
  const today = new Date().toISOString().slice(0, 10);
  const causaOptions = CAUSA_MORTE_LIST.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  const colaboradoresRaw = await idbGet("colaboradores", "list");
  const colaboradores = Array.isArray(colaboradoresRaw) ? colaboradoresRaw : (state.colaboradoresList || []);
  const responsavelOptions = colaboradores
    .map((c) => `<option value="${escapeHtml(c._id || "")}">${escapeHtml(c.nome || "—")}</option>`)
    .join("");

  container.innerHTML = `
    <div class="saVendaForm saVendaFormPipeline" id="saMorteForm">
      <div class="saVendaFormGrid" style="grid-template-columns: 1fr 1fr;">
        <div class="saVendaField">
          <label for="morteCausaMorte">Causa da morte <span class="saVendaRequired">*</span></label>
          <select id="morteCausaMorte" class="saVendaSelect" required>
            <option value="">Selecione a causa da morte</option>${causaOptions}
          </select>
        </div>
        <div class="saVendaField">
          <label for="morteResponsavel">Responsável <span class="saVendaRequired">*</span></label>
          <select id="morteResponsavel" class="saVendaSelect" required>
            <option value="">Selecione o responsável</option>${responsavelOptions}
          </select>
        </div>
        <div class="saVendaField">
          <label for="morteDataMorte">Data da morte <span class="saVendaRequired">*</span></label>
          <input type="date" id="morteDataMorte" class="saVendaInput" value="${today}" required />
        </div>
        <div class="saVendaField" style="grid-column: 1 / -1;">
          <label for="morteDetalhesObservacoes">Detalhes/Observações</label>
          <textarea id="morteDetalhesObservacoes" class="saVendaInput" rows="3" placeholder="Digite aqui...."></textarea>
        </div>
        <div class="saVendaField" style="grid-column: 1 / -1;">
          <label>Imagem do brinco ou animal</label>
          <div class="saVendaUploadArea" id="morteImagemBrincoWrap" style="border:1px dashed var(--border);border-radius:8px;padding:1.5rem;text-align:center;cursor:pointer;position:relative;">
            <span class="saVendaUploadIcon" aria-hidden="true" style="font-size:1.5rem;">☁</span>
            <p class="saVendaUploadText" style="margin:8px 0 0;font-size:13px;color:var(--muted);">Clique para fazer upload</p>
            <p class="saVendaUploadText" style="margin:4px 0 0;font-size:11px;color:var(--muted);">SVG, PNG, JPG ou GIF (máx. 800x400px)</p>
            <input type="file" id="morteImagemBrinco" accept="image/svg+xml,image/png,image/jpeg,image/gif" style="display:none;" />
            <div id="morteImagemPreview" class="saVendaUploadPreview" style="display:none;position:relative;margin-top:12px;max-width:100%;justify-content:center;">
              <button type="button" id="morteImagemRemove" aria-label="Remover imagem" style="position:absolute;top:6px;right:6px;width:24px;height:24px;border-radius:999px;border:none;background:rgba(0,0,0,0.65);color:#fff;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;">×</button>
              <img id="morteImagemPreviewImg" alt="Pré-visualização da imagem do brinco ou animal" style="max-width:100%;max-height:200px;border-radius:8px;object-fit:cover;" />
            </div>
          </div>
        </div>
      </div>
    </div>
    <div id="morteModalConfirm" class="saVendaModalOverlay" hidden aria-modal="true" role="dialog">
      <div class="saVendaModal" style="max-width:400px;">
        <div class="saVendaModalHeader">
          <h2 class="saVendaModalTitle">Registrar morte</h2>
          <button type="button" class="saVendaModalClose" id="morteModalClose" aria-label="Fechar">&times;</button>
        </div>
        <div class="saVendaModalBody" style="display:flex;flex-direction:column;gap:12px;">
          <div style="display:flex;align-items:flex-start;gap:12px;">
            <span style="background:#f59e0b;color:#fff;width:28px;height:28px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;">!</span>
            <div>
              <p style="margin:0;font-size:14px;">Tem certeza que deseja registrar a morte do animal, brinco: <strong id="morteModalBrinco">—</strong>?</p>
              <p style="margin:8px 0 0;font-size:13px;color:var(--muted);">Após confirmar, esse animal ficará inativo!</p>
            </div>
          </div>
        </div>
        <div class="saVendaModalFooter">
          <button type="button" class="saVendaModalBtn saVendaModalBtnCancel" id="morteModalCancel">Cancelar</button>
          <button type="button" class="saVendaModalBtn saVendaModalBtnConfirm" id="morteModalConfirmBtn">Registrar morte</button>
        </div>
      </div>
    </div>
  `;

  applyModulePrefillToContainer(container, "saida_animais", "Morte");

  const modal = container.querySelector("#morteModalConfirm");
  const modalClose = container.querySelector("#morteModalClose");
  const modalCancel = container.querySelector("#morteModalCancel");
  const modalConfirmBtn = container.querySelector("#morteModalConfirmBtn");
  const brincoEl = container.querySelector("#morteModalBrinco");
  const inputCausa = container.querySelector("#morteCausaMorte");
  const inputResponsavel = container.querySelector("#morteResponsavel");
  const inputDataMorte = container.querySelector("#morteDataMorte");
  const inputDetalhes = container.querySelector("#morteDetalhesObservacoes");
  const inputImagem = container.querySelector("#morteImagemBrinco");
  const wrapImagem = container.querySelector("#morteImagemBrincoWrap");
  const previewWrap = container.querySelector("#morteImagemPreview");
  const previewImg = container.querySelector("#morteImagemPreviewImg");
  const btnRemoveImg = container.querySelector("#morteImagemRemove");
  let morteImagemBase64 = null;

  if (wrapImagem && inputImagem) {
    wrapImagem.addEventListener("click", (ev) => {
      if (ev.target === btnRemoveImg) return;
      inputImagem.click();
    });
  }

  function isFormValid() {
    const causa = inputCausa?.value?.trim();
    const responsavel = inputResponsavel?.value?.trim();
    const dataMorte = inputDataMorte?.value?.trim();
    const ok = !!(causa && responsavel && dataMorte);
    if (headerBtn) {
      headerBtn.disabled = !ok;
      headerBtn.classList.toggle("pipelineBtnAvançarActive", ok);
    }
    return ok;
  }

  function applyImageState() {
    if (!wrapImagem) return;
    const hasImage = !!morteImagemBase64;
    const icon = wrapImagem.querySelector(".saVendaUploadIcon");
    const texts = wrapImagem.querySelectorAll(".saVendaUploadText");
    if (icon) icon.style.display = hasImage ? "none" : "";
    texts.forEach((t) => { t.style.display = hasImage ? "none" : ""; });
    if (previewWrap) previewWrap.style.display = hasImage ? "flex" : "none";
  }

  if (inputImagem) {
    inputImagem.addEventListener("change", () => {
      const file = inputImagem.files && inputImagem.files[0];
      if (!file) {
        morteImagemBase64 = null;
        if (previewImg) previewImg.src = "";
        applyImageState();
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        morteImagemBase64 = reader.result;
        if (previewImg) previewImg.src = morteImagemBase64;
        applyImageState();
      };
      reader.onerror = () => {
        toast("Não foi possível ler a imagem. Tente novamente.");
      };
      reader.readAsDataURL(file);
    });
  }

  if (btnRemoveImg) {
    btnRemoveImg.addEventListener("click", (ev) => {
      ev.stopPropagation();
      morteImagemBase64 = null;
      if (inputImagem) inputImagem.value = "";
      if (previewImg) previewImg.src = "";
      applyImageState();
    });
  }

  function openModal() {
    if (!isFormValid()) {
      // Mensagens específicas para ajudar o usuário se ele tentar forçar
      const causa = inputCausa?.value?.trim();
      if (!causa) {
        toast("Selecione a causa da morte.");
        return;
      }
      const responsavel = inputResponsavel?.value?.trim();
      if (!responsavel) {
        toast("Selecione o responsável.");
        return;
      }
      const dataMorte = inputDataMorte?.value?.trim();
      if (!dataMorte) {
        toast("Informe a data da morte.");
        return;
      }
    }
    const causa = inputCausa?.value?.trim();
    const responsavel = inputResponsavel?.value?.trim();
    const dataMorte = inputDataMorte?.value?.trim();
    if (brincoEl) brincoEl.textContent = animal.brinco_padrao || "—";
    if (modal) modal.hidden = false;
  }
  function closeModal() {
    if (modal) modal.hidden = true;
  }
  if (modalClose) modalClose.addEventListener("click", closeModal);
  if (modalCancel) modalCancel.addEventListener("click", closeModal);

  if (modalConfirmBtn) {
    modalConfirmBtn.addEventListener("click", async () => {
      closeModal();
      const causa = inputCausa?.value?.trim() || "";
      const responsavel = inputResponsavel?.value?.trim() || "";
      const dataMorte = inputDataMorte?.value?.trim() || "";
      const detalhes = inputDetalhes?.value?.trim() || "";
      const owner = await idbGet("owner", "current");
      const userAtualId = String(state.ctx.ownerId || owner?._id || "").trim();
      const fazendaOrigemId = state.ctx.fazendaId || "";
      const dataMorteTs = dataMorte ? new Date(dataMorte).getTime() : null;

      const payload = {
        animais: [animal._id],
        animal: animal._id,
        animal_peso: null,
        proprietario_destino: null,
        fazenda_destino: null,
        peso_saida: null,
        nota_fiscal: "",
        data_aquisicao: null,
        valor: null,
        condicao_pagamento: "",
        movimentacao_saida_animal: "Morte",
        movimentacao_entrada_animal: "",
        numero_gta: "",
        serie_gta: "",
        data_emissao_gta: null,
        data_validade_gta: null,
        uf_gta: "",
        fazenda_origem: fazendaOrigemId || null,
        user_atual: userAtualId || null,
        valor_saida: null,
        causa_morte: causa,
        detalhes_observacoes: detalhes,
        responsavel,
        data_morte: dataMorteTs,
        imagem_brinco_animal: morteImagemBase64,
      };
      const qKey = `queue:${fazendaOrigemId}:${state.ctx.ownerId || ""}:animal`;
      const queue = (await idbGet("records", qKey)) || [];
      queue.push({ _id: `local:${uuid()}`, op: OFFLINE_OPS.CREATE_SAIDA_ANIMAIS_MORTE, at: Date.now(), payload });
      await idbSet("records", qKey, queue);
      updateFabSyncVisibility();
      toast("Morte registrada. Será sincronizada quando houver conexão.");
      options?.onAfterConfirm?.();
    });
  }

  if (headerBtn) {
    headerBtn.textContent = "Registrar morte";
    headerBtn.disabled = true;
    headerBtn.classList.remove("pipelineBtnAvançarActive");
    headerBtn.onclick = openModal;
  }

  ["change", "input"].forEach((evt) => {
    inputCausa?.addEventListener(evt, isFormValid);
    inputResponsavel?.addEventListener(evt, isFormValid);
    inputDataMorte?.addEventListener(evt, isFormValid);
  });
  isFormValid();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------------- Form helpers ----------------
function qAll(root, sel) { return root.querySelectorAll(sel); }

function readForm(root) {
  const data = {};
  qAll(root, "[data-key]").forEach((el) => {
    const k = el.dataset.key;
    if (!k) return;
    if (el.type === "checkbox") data[k] = el.checked ? "1" : "0";
    else data[k] = (el.value ?? "").toString();
  });
  return data;
}

function writeForm(root, data) {
  qAll(root, "[data-key]").forEach((el) => {
    const k = el.dataset.key;
    if (!k) return;

    if (!(k in (data || {}))) return;
    const v = data?.[k];

    if (el.type === "checkbox") el.checked = v === "1" || v === true;
    else el.value = String(v ?? "");
  });
}

function validateForm(root) {
  const reqs = qAll(root, "[data-required='1']");
  for (const el of reqs) {
    const v = (el.value ?? "").toString().trim();
    if (!v) return { ok: false, key: el.dataset.key };
  }
  return { ok: true };
}

function monthDiff(fromDate, toDate) {
  const y = toDate.getFullYear() - fromDate.getFullYear();
  const m = toDate.getMonth() - fromDate.getMonth();
  const d = toDate.getDate() - fromDate.getDate();
  let total = y * 12 + m;
  if (d < 0) total -= 1;
  return Math.max(0, total);
}

function isoToDateInput(iso) {
  if (!iso || String(iso).toLowerCase() === "nan" || String(iso).trim() === "") return "";
  const isoStr = String(iso).trim();
  // se já for yyyy-mm-dd, retorna
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoStr)) return isoStr;
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime()) || !d.getTime()) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function dateInputToISO(dateStr) {
  if (!dateStr || dateStr.trim() === "" || dateStr.toLowerCase() === "nan") return "";
  // Remove espaços e valida formato básico
  const trimmed = String(dateStr).trim();
  // Verifica se é formato YYYY-MM-DD válido
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return "";
  // salva como ISO Z meia-noite local
  const d = new Date(trimmed + "T03:00:00.000Z"); // mantém seu padrão BR (-03)
  if (Number.isNaN(d.getTime()) || !d.getTime()) return "";
  return d.toISOString();
}

// ---------------- Animal module: LIST + SEARCH ----------------

function normText(v) {
  return String(v ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function normBrinco(v) {
  return normText(v);
}

function renderSex(v) {
  if (v === "M") return "M ♂";
  if (v === "F") return "F ♀";
  return "—";
}

function fmtKg(v) {
  const n = toNumberOrZero(v);
  // sem Intl pra não “quebrar” em ambientes ruins
  const s = String(n).replace(".", ",");
  return `${s} KG`;
}

function fmtDateDisplay(iso) {
  if (!iso || String(iso).toLowerCase() === "nan" || String(iso).trim() === "") return "—";
  const str = String(iso).trim();
  let yyyy, mm, dd;
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    yyyy = str.slice(0, 4);
    mm = str.slice(5, 7);
    dd = str.slice(8, 10);
  } else {
    const d = new Date(str);
    if (Number.isNaN(d.getTime()) || !d.getTime()) return "—";
    yyyy = d.getFullYear();
    mm = String(d.getMonth() + 1).padStart(2, "0");
    dd = String(d.getDate()).padStart(2, "0");
  }
  return `${dd}/${mm}/${yyyy}`;
}

/** Calcula idade em meses a partir de data (YYYY-MM-DD) e retorna texto: "0,2 mês", "1 mês", "5 meses" */
function formatIdadeMeses(dateStr) {
  if (!dateStr || String(dateStr).trim() === "" || String(dateStr).toLowerCase() === "nan") return "—";
  const str = String(dateStr).trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(str)) return "—";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const birth = new Date(str + "T12:00:00");
  birth.setHours(0, 0, 0, 0);
  const diffMs = today.getTime() - birth.getTime();
  if (diffMs < 0) return "—";
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  const months = diffDays / 30.44;
  if (months < 0) return "—";
  if (months < 1) {
    const dec = Math.round(months * 10) / 10;
    return `${String(dec).replace(".", ",")} mês`;
  }
  const n = Math.floor(months);
  if (n === 1) return "1 mês";
  return `${n} meses`;
}

function updateAnimalIdadeDisplay() {
  const nascEl = $("#animalNasc");
  const displayEl = $("#animalIdadeDisplay");
  if (!displayEl) return;
  const dateStr = nascEl ? nascEl.value : "";
  displayEl.textContent = formatIdadeMeses(dateStr);
}

/** Formata número para exibição em Real (R$ 1.234,56) */
function formatCurrencyBR(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "R$ 0,00";
  return "R$ " + n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Extrai valor numérico de string com R$ (ex: "R$ 45.411,00" ou "45411") */
function parseCurrencyBR(str) {
  if (str == null || String(str).trim() === "") return 0;
  const s = String(str).replace(/\s/g, "").replace(/R\$/gi, "").replace(/\./g, "").replace(",", ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function animalDisplayName(a) {
  const name = String(a?.nome_completo || "").trim();
  if (name) return name;
  const br = String(a?.brinco_padrao || "").trim();
  return br ? `Animal ${br}` : "Animal";
}

/** Retorna animais da mesma organização (todas as fazendas da org) para busca em genealogia. */
async function getAnimaisByOrganizacao() {
  const fazendaAtual = await idbGet("fazenda", "current");
  const org = await idbGet("organizacao", "current");
  const orgId = fazendaAtual?.organizacao_id ?? (typeof fazendaAtual?.organizacao === "object" ? fazendaAtual?.organizacao?._id : fazendaAtual?.organizacao) ?? org?._id ?? org?.organizacao ?? null;
  const raw = (await idbGet("animais", "list")) || [];
  const base = raw.filter((a) => !a.deleted).map(normalizeAnimal);
  if (!orgId) {
    return filterByCurrentFazenda(base, "fazenda");
  }
  const listFazendas = (await idbGet("fazenda", "list")) || [];
  const sameOrgId = (f) => {
    const fOrg = f?.organizacao_id ?? f?.organizacao ?? (typeof f?.organizacao === "object" ? f?.organizacao?._id : null);
    return String(fOrg || "") === String(orgId);
  };
  const fazendaIds = new Set(listFazendas.filter(sameOrgId).map((f) => String(f._id || "")).filter(Boolean));
  return base.filter((a) => fazendaIds.has(String(a.fazenda || "")));
}

/** Exibe label do animal para genealogia (brinco — nome). */
function animalGenealogiaLabel(a) {
  const br = String(a?.brinco_padrao || "").trim() || "—";
  const nome = String(a?.nome_completo || "").trim() || "—";
  return `${br} — ${nome}`;
}

// ---------------- Animal module: FORM (CREATE / EDIT) ----------------

function getAnimalFormRoot() {
  // No HTML novo, os inputs têm ids (animalBrinco, animalSexo etc).
  // Para reaproveitar seus helpers de data-key, vamos criar um "root virtual"
  // que aponta pro #modAnimaisForm e usa um mapeamento para ler/gravar.
  return $("#modAnimaisForm");
}

function readAnimalFormByIds() {
  // coleta valores do HTML novo (ids)
  const owner = $("#animalOwnerSelect")?.value ?? "";
  const brinco = $("#animalBrinco")?.value ?? "";
  const sexo = $("#animalSexo")?.value ?? "";
  const pesoAtual = $("#animalPesoAtual")?.value ?? "0";
  const nasc = $("#animalNasc")?.value ?? "";
  const categoria = $("#animalCategoria")?.value ?? "";
  const raca = $("#animalRaca")?.value ?? "";

  // extras (Dados adicionais)
  const nome = $("#animalNome")?.value ?? "";
  const finalidade = $("#animalFinalidade")?.value ?? "";
  const pesoNasc = $("#animalPesoNasc")?.value ?? "0";
  const sisbov = $("#animalSisbov")?.value ?? "";
  const eletronica = $("#animalEletronica")?.value ?? "";
  const rgd = $("#animalRgd")?.value ?? "";
  const rgn = $("#animalRgn")?.value ?? "";
  const listLotes = getAnimalLoteIdsFromChips();
  const lote = listLotes.length > 0 ? listLotes[0] : "";
  const pasto = $("#animalPasto")?.value ?? "";
  const obs = $("#animalObs")?.value ?? "";

  // genealogia (Mãe / Pai)
  const mae = ($("#animalMae")?.getAttribute?.("data-selected-id") || $("#animalMae")?.value) ?? "";
  const pai = ($("#animalPai")?.getAttribute?.("data-selected-id") || $("#animalPai")?.value) ?? "";

  // aquisição (seção visível quando entry_type = Compra)
  const dataAquisicaoEl = document.getElementById("animalDataAquisicao");
  const dataAquisicaoVal = dataAquisicaoEl?.value ?? "";
  const dataAquisicao = dataAquisicaoVal ? dateToTimestampSync(dataAquisicaoVal) : null;
  const notaFiscal = $("#animalNotaFiscal")?.value ?? "";
  const valorAquisicaoRaw = $("#animalValorAquisicao")?.value ?? "";
  const valorAquisicao = parseCurrencyBR(valorAquisicaoRaw);
  const origemFornecedor = $("#animalOrigemFornecedor")?.value ?? "";
  const numeroGta = $("#animalNumeroGTA")?.value ?? "";
  const ufGta = $("#animalUfGTA")?.value ?? "";
  const serieGta = $("#animalSerieGTA")?.value ?? "";
  const dataEmissaoVal = $("#animalDataEmissaoGTA")?.value ?? "";
  const dataValidadeVal = $("#animalDataValidadeGTA")?.value ?? "";
  const dataEmissaoGta = dataEmissaoVal ? dateToTimestampSync(dataEmissaoVal) : null;
  const dataValidadeGta = dataValidadeVal ? dateToTimestampSync(dataValidadeVal) : null;

  // tipo entrada (chip ativo)
  const entry = document.querySelector("#tipoEntradaChips .chip.active")?.dataset?.value || "Compra";
  const valorDisabledForEntry = ["Doação", "Empréstimo", "Ajuste inventário"].includes(entry);
  const valorAnimalFinal = valorDisabledForEntry ? 0 : valorAquisicao;

  // Valida e limpa data de nascimento
  const dataNascimentoISO = dateInputToISO(nasc);
  const dataNascimentoFinal = (dataNascimentoISO &&
    String(dataNascimentoISO).toLowerCase() !== "nan" &&
    String(dataNascimentoISO).trim() !== "")
    ? dataNascimentoISO
    : "";

  return {
    owner,
    entry_type: entry,
    animal_type: $("#animalTipo")?.value ?? "Físico",
    brinco_padrao: brinco,
    sexo,
    peso_atual_kg: toNumberOrZero(pesoAtual),
    data_nascimento: dataNascimentoFinal,
    categoria,
    raca,

    nome_completo: nome,
    finalidade,
    peso_nascimento: toNumberOrZero(pesoNasc),
    sisbov,
    identificacao_eletronica: eletronica,
    rgd,
    rgn,
    list_lotes: listLotes,
    lote,
    pasto,
    observacoes: obs,

    mae_vinculo: mae,
    pai_vinculo: pai,

    data_aquisicao: dataAquisicao,
    nota_fiscal: notaFiscal,
    valor_animal: valorAnimalFinal,
    origem_fornecedor: origemFornecedor,
    numero_gta: numeroGta,
    uf_gta: ufGta,
    serie_gta: serieGta,
    data_emissao_gta: dataEmissaoGta,
    data_validade_gta: dataValidadeGta,
  };
}

async function writeAnimalFormByIds(data = {}) {
  const fazenda = await idbGet("fazenda", "current");
  const farmName = fazenda?.name || "—";
  const fazendaNome = $("#fazendaSelecionadaNome");
  if (fazendaNome) fazendaNome.textContent = farmName;

  if ($("#animalOwnerSelect")) $("#animalOwnerSelect").value = String(data.owner || "");
  if ($("#animalTipo")) $("#animalTipo").value = String(data.animal_type || "Físico");
  if ($("#animalBrinco")) $("#animalBrinco").value = String(data.brinco_padrao || "");
  if ($("#animalSexo")) $("#animalSexo").value = String(data.sexo || "");
  if ($("#animalPesoAtual")) $("#animalPesoAtual").value = String(toNumberOrZero(data.peso_atual_kg));
  if ($("#animalNasc")) $("#animalNasc").value = isoToDateInput(data.data_nascimento || "");
  updateAnimalIdadeDisplay();
  if ($("#animalCategoria")) $("#animalCategoria").value = String(data.categoria || "");
  if ($("#animalRaca")) $("#animalRaca").value = String(data.raca || "");

  if ($("#animalNome")) $("#animalNome").value = String(data.nome_completo || "");
  if ($("#animalFinalidade")) $("#animalFinalidade").value = String(data.finalidade || "");
  if ($("#animalPesoNasc")) $("#animalPesoNasc").value = String(toNumberOrZero(data.peso_nascimento));
  if ($("#animalSisbov")) $("#animalSisbov").value = String(data.sisbov || "");
  if ($("#animalEletronica")) $("#animalEletronica").value = String(data.identificacao_eletronica || "");
  if ($("#animalRgd")) $("#animalRgd").value = String(data.rgd || "");
  if ($("#animalRgn")) $("#animalRgn").value = String(data.rgn || "");
  const listLotesForForm = Array.isArray(data.list_lotes) ? data.list_lotes : (data.lote ? [data.lote] : []);
  await renderAnimalLoteChips(listLotesForForm);
  if ($("#animalPasto")) $("#animalPasto").value = String(data.pasto || "");
  if ($("#animalObs")) $("#animalObs").value = String(data.observacoes || "");

  // Genealogia: se mae_vinculo/pai_vinculo forem IDs, resolver para exibir "Brinco — Nome"
  const animaisOrg = await getAnimaisByOrganizacao();
  const editingId = state.animalEditingId ? String(state.animalEditingId) : null;
  if ($("#animalMae")) {
    const maeId = String(data.mae_vinculo || "").trim();
    $("#animalMae").removeAttribute("data-selected-id");
    if (maeId) {
      const maeAnimal = animaisOrg.find((a) => String(a._id) === maeId);
      if (maeAnimal) {
        $("#animalMae").value = animalGenealogiaLabel(maeAnimal);
        $("#animalMae").setAttribute("data-selected-id", maeId);
      } else {
        $("#animalMae").value = maeId;
      }
    } else {
      $("#animalMae").value = "";
    }
  }
  if ($("#animalPai")) {
    const paiId = String(data.pai_vinculo || "").trim();
    $("#animalPai").removeAttribute("data-selected-id");
    if (paiId) {
      const paiAnimal = animaisOrg.find((a) => String(a._id) === paiId);
      if (paiAnimal) {
        $("#animalPai").value = animalGenealogiaLabel(paiAnimal);
        $("#animalPai").setAttribute("data-selected-id", paiId);
      } else {
        $("#animalPai").value = paiId;
      }
    } else {
      $("#animalPai").value = "";
    }
  }

  // Aquisição
  const dataAquisicaoInput = document.getElementById("animalDataAquisicao");
  if (dataAquisicaoInput) dataAquisicaoInput.value = isoToDateInput(data.data_aquisicao || "");
  if ($("#animalNotaFiscal")) $("#animalNotaFiscal").value = String(data.nota_fiscal || "");
  if ($("#animalValorAquisicao")) $("#animalValorAquisicao").value = formatCurrencyBR(data.valor_animal ?? data.valor ?? 0);
  if ($("#animalOrigemFornecedor")) $("#animalOrigemFornecedor").value = String(data.origem_fornecedor || "");
  if ($("#animalNumeroGTA")) $("#animalNumeroGTA").value = String(data.numero_gta || data.gta || "");
  if ($("#animalUfGTA")) $("#animalUfGTA").value = String(data.uf_gta || data.uf || "");
  if ($("#animalSerieGTA")) $("#animalSerieGTA").value = String(data.serie_gta || "");
  const dataEmissaoInput = document.getElementById("animalDataEmissaoGTA");
  if (dataEmissaoInput) dataEmissaoInput.value = isoToDateInput(data.data_emissao_gta || "");
  const dataValidadeInput = document.getElementById("animalDataValidadeGTA");
  if (dataValidadeInput) dataValidadeInput.value = isoToDateInput(data.data_validade_gta || "");

  // chip seleção
  const val = String(data.entry_type || "Compra");
  const wrap = $("#tipoEntradaChips");
  if (wrap) {
    wrap.querySelectorAll(".chip").forEach((c) => {
      const active = c.dataset.value === val;
      c.classList.toggle("active", active);
      const box = c.querySelector(".box");
      if (box) box.textContent = active ? "✓" : "";
    });
  }
}

function validateAnimalFormRequired() {
  // campos obrigatórios (igual seu layout)
  const owner = $("#animalOwnerSelect")?.value ?? "";
  const br = $("#animalBrinco")?.value ?? "";
  const sx = $("#animalSexo")?.value ?? "";
  const nasc = $("#animalNasc")?.value ?? "";
  const cat = $("#animalCategoria")?.value ?? "";
  const raca = $("#animalRaca")?.value ?? "";

  if (!owner.trim()) return { ok: false, key: "owner" };
  if (!br.trim()) return { ok: false, key: "brinco_padrao" };
  if (!sx.trim()) return { ok: false, key: "sexo" };
  if (!nasc.trim()) return { ok: false, key: "data_nascimento" };
  if (!cat.trim()) return { ok: false, key: "categoria" };
  if (!raca.trim()) return { ok: false, key: "raca" };

  return { ok: true };
}

function updateSaveButtonState() {
  const btns = document.querySelectorAll(".btnSaveAnimal");
  if (!btns.length) return;

  const check = validateAnimalFormRequired();
  const enabled = check.ok;
  btns.forEach((btn) => {
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? "1" : "0.5";
    btn.style.cursor = enabled ? "pointer" : "not-allowed";
  });
}

/**
 * Popula dropdowns fixos com listas do config.js
 */
function populateFixedDropdowns() {
  // UF (Estados) — seção Aquisição
  const selUfGta = document.getElementById("animalUfGTA");
  if (selUfGta) {
    selUfGta.innerHTML = [
      `<option value="">Selecione</option>`,
      ...UF_LIST.map(uf => `<option value="${escapeHtml(uf.value)}">${escapeHtml(uf.label)}</option>`)
    ].join("");
  }

  // Raça
  const selRaca = $("#animalRaca");
  if (selRaca) {
    selRaca.innerHTML = [
      `<option value="" selected disabled>Selecione a raça</option>`,
      ...RACAS_LIST.map(raca => `<option value="${escapeHtml(raca)}">${escapeHtml(raca)}</option>`)
    ].join("");
  }

  // Finalidade
  const selFinalidade = $("#animalFinalidade");
  if (selFinalidade) {
    selFinalidade.innerHTML = [
      `<option value="" selected disabled>Selecione a finalidade</option>`,
      ...FINALIDADE_LIST.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`)
    ].join("");
  }

  // Categoria
  const selCategoria = $("#animalCategoria");
  if (selCategoria) {
    selCategoria.innerHTML = [
      `<option value="" selected disabled>Categoria</option>`,
      ...CATEGORIA_LIST.map(cat => `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`)
    ].join("");
  }

  // Sexo
  const selSexo = $("#animalSexo");
  if (selSexo) {
    selSexo.innerHTML = [
      `<option value="" selected disabled>Sexo</option>`,
      ...SEXO_LIST.map(s => `<option value="${escapeHtml(s.value)}">${escapeHtml(s.label)}</option>`)
    ].join("");
  }

  // Tipo de Animal
  const selTipo = $("#animalTipo");
  if (selTipo) {
    selTipo.innerHTML = TIPO_ANIMAL_LIST.map(tipo => 
      `<option value="${escapeHtml(tipo)}"${tipo === "Físico" ? " selected" : ""}>${escapeHtml(tipo)}</option>`
    ).join("");
  }
}

function getAnimalLoteIdsFromChips() {
  const wrap = document.getElementById("animalLoteChips");
  if (!wrap) return [];
  return Array.from(wrap.querySelectorAll(".animalLoteChip")).map(el => el.getAttribute("data-id")).filter(Boolean);
}

async function renderAnimalLoteChips(ids = []) {
  const wrap = document.getElementById("animalLoteChips");
  if (!wrap) return;
  const lotesRaw = (await idbGet("lotes", "list")) || [];
  const lotes = filterByCurrentFazenda(lotesRaw);
  const idSet = new Set(ids.map(id => String(id)).filter(Boolean));
  wrap.innerHTML = "";
  idSet.forEach(id => {
    const lote = lotes.find(l => String(l._id) === String(id));
    const nome = lote?.nome_lote || id;
    const chip = document.createElement("span");
    chip.className = "animalLoteChip";
    chip.setAttribute("data-id", id);
    chip.innerHTML = `${escapeHtml(nome)} <button type="button" class="animalLoteChipRemove" aria-label="Remover lote">×</button>`;
    const btn = chip.querySelector(".animalLoteChipRemove");
    if (btn) btn.addEventListener("click", () => { chip.remove(); });
    wrap.appendChild(chip);
  });
}

async function fillOwnersAndLotesInForm() {
  // Proprietários agora vêm da tabela de colaboradores, filtrando por fazenda vinculada
  const colaboradores = (await idbGet("colaboradores", "list")) || [];
  const fazendaId = getCurrentFazendaId();
  const proprietarios = colaboradores.filter(c =>
    Array.isArray(c.fazendas) && c.fazendas.some(f => String(f) === String(fazendaId))
  );
  const lotesRaw = (await idbGet("lotes", "list")) || [];
  const lotes = filterByCurrentFazenda(lotesRaw);
  const pastosRaw = (await idbGet("pastos", "list")) || [];
  const pastos = filterByCurrentFazenda(pastosRaw);

  const selOwner = $("#animalOwnerSelect");
  const selLoteAdd = $("#animalLoteAdd");
  const selPasto = $("#animalPasto");

  if (selOwner) {
    selOwner.innerHTML = [
      `<option value="">Selecione…</option>`,
      ...proprietarios.map(p => `<option value="${escapeHtml(p._id)}">${escapeHtml(p.nome || "—")}</option>`)
    ].join("");

    if (proprietarios.length > 0) {
      selOwner.selectedIndex = 1;
      selOwner.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  if (selLoteAdd) {
    selLoteAdd.innerHTML = [
      `<option value="">Adicionar lote…</option>`,
      ...lotes.map(l => `<option value="${escapeHtml(l._id)}">${escapeHtml(l.nome_lote || "—")}</option>`)
    ].join("");

    if (!selLoteAdd.__loteAddBound) {
      selLoteAdd.__loteAddBound = true;
      selLoteAdd.addEventListener("change", async () => {
        const val = selLoteAdd.value;
        if (!val) return;
        const ids = getAnimalLoteIdsFromChips();
        if (ids.includes(val)) return;
        ids.push(val);
        await renderAnimalLoteChips(ids);
        selLoteAdd.value = "";
      });
    }
  }

  if (selPasto) {
    selPasto.innerHTML = [
      `<option value="">Pasto</option>`,
      ...pastos.map(p => `<option value="${escapeHtml(p._id)}">${escapeHtml(p.nome || "—")}</option>`)
    ].join("");
  }

  const selOrigem = document.getElementById("animalOrigemFornecedor");
  if (selOrigem) {
    selOrigem.innerHTML = [
      `<option value="">Origem/Fornecedor</option>`,
      ...proprietarios.map(p => `<option value="${escapeHtml(p._id)}">${escapeHtml(p.nome || "—")}</option>`)
    ].join("");
  }
}

function updateAquisicaoSectionVisibility() {
  const entry = document.querySelector("#tipoEntradaChips .chip.active")?.dataset?.value || "";
  const section = document.getElementById("aquisicaoSection");
  const valorInput = document.getElementById("animalValorAquisicao");
  const showSection = ["Compra", "Doação", "Empréstimo", "Ajuste inventário"].includes(entry);
  if (section) section.style.display = showSection ? "block" : "none";
  if (valorInput) {
    const valorDisabled = entry === "Doação" || entry === "Empréstimo" || entry === "Ajuste inventário";
    valorInput.disabled = !!valorDisabled;
    valorInput.classList.toggle("aquisicaoValorDisabled", !!valorDisabled);
  }
}

function bindAnimalFormUIOnce() {
  const secForm = $("#modAnimaisForm");
  if (!secForm || secForm.__bound) return;
  secForm.__bound = true;

  // Accordion Tabs (Mobile)
  const accordionHeaders = secForm.querySelectorAll(".accordionHeader");
  accordionHeaders.forEach(header => {
    header.addEventListener("click", () => {
      const accordionId = header.dataset.accordion;
      const panel = header.nextElementSibling;
      const isActive = header.classList.contains("active");

      // Fecha todos os outros accordions
      accordionHeaders.forEach(h => {
        if (h !== header) {
          h.classList.remove("active");
          h.nextElementSibling.classList.remove("active");
        }
      });

      // Toggle do accordion clicado
      if (isActive) {
        header.classList.remove("active");
        panel.classList.remove("active");
      } else {
        header.classList.add("active");
        panel.classList.add("active");
      }
    });
  });

  // Data de nascimento: ao alterar, recalcula e exibe a idade
  const animalNasc = document.getElementById("animalNasc");
  if (animalNasc && !animalNasc.__idadeBound) {
    animalNasc.__idadeBound = true;
    animalNasc.addEventListener("input", updateAnimalIdadeDisplay);
    animalNasc.addEventListener("change", updateAnimalIdadeDisplay);
  }

  // Campo Valor (aquisição): formata com R$ ao sair do campo
  const valorAquisicao = document.getElementById("animalValorAquisicao");
  if (valorAquisicao && !valorAquisicao.__currencyBound) {
    valorAquisicao.__currencyBound = true;
    valorAquisicao.addEventListener("blur", () => {
      const parsed = parseCurrencyBR(valorAquisicao.value);
      valorAquisicao.value = formatCurrencyBR(parsed);
    });
  }

  // Genealogia (Mãe / Pai): busca por animais da mesma organização
  const animalMaeInput = document.getElementById("animalMae");
  const animalMaeResults = document.getElementById("animalMaeResults");
  const animalPaiInput = document.getElementById("animalPai");
  const animalPaiResults = document.getElementById("animalPaiResults");
  let genealogiaDebounce = null;

  async function runGenealogiaSearch(inputEl, resultsEl, excludeId) {
    if (!inputEl || !resultsEl) return;
    const q = String(inputEl.value || "").trim();
    if (!q) {
      resultsEl.innerHTML = "";
      resultsEl.hidden = true;
      return;
    }
    const animais = await getAnimaisByOrganizacao();
    const exclude = excludeId ? String(excludeId) : null;
    const list = animais.filter((a) => !exclude || String(a._id) !== exclude);
    const lower = q.toLowerCase();
    const matches = list.filter(
      (a) =>
        String(a.nome_completo || "").toLowerCase().includes(lower) ||
        String(a.brinco_padrao || "").toLowerCase().includes(lower)
    );
    if (matches.length === 0) {
      resultsEl.innerHTML = '<div class="pipelineResultItem pipelineResultEmpty">Nenhum animal encontrado</div>';
      resultsEl.hidden = false;
      return;
    }
    resultsEl.innerHTML = matches.slice(0, 12).map((a) =>
      `<button type="button" class="pipelineResultItem" data-id="${escapeHtml(a._id)}">${escapeHtml(animalGenealogiaLabel(a))}</button>`
    ).join("");
    resultsEl.hidden = false;
  }

  function bindGenealogiaInput(inputEl, resultsEl) {
    if (!inputEl || !resultsEl || inputEl.__genealogiaBound) return;
    inputEl.__genealogiaBound = true;
    const excludeId = () => state.animalEditingId ? String(state.animalEditingId) : null;
    inputEl.addEventListener("input", () => {
      if (!inputEl.value.trim()) inputEl.removeAttribute("data-selected-id");
      clearTimeout(genealogiaDebounce);
      genealogiaDebounce = setTimeout(() => runGenealogiaSearch(inputEl, resultsEl, excludeId()), 200);
    });
    inputEl.addEventListener("focus", () => {
      if (inputEl.value.trim()) runGenealogiaSearch(inputEl, resultsEl, excludeId());
    });
    inputEl.addEventListener("blur", () => {
      setTimeout(() => { resultsEl.hidden = true; }, 180);
    });
    resultsEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".pipelineResultItem[data-id]");
      if (!btn || btn.classList.contains("pipelineResultEmpty")) return;
      const id = btn.dataset.id;
      const label = btn.textContent.trim();
      inputEl.value = label;
      inputEl.setAttribute("data-selected-id", id);
      resultsEl.hidden = true;
      resultsEl.innerHTML = "";
      updateSaveButtonState();
    });
  }
  bindGenealogiaInput(animalMaeInput, animalMaeResults);
  bindGenealogiaInput(animalPaiInput, animalPaiResults);

  // chips tipo entrada
  const chipWrap = $("#tipoEntradaChips");
  if (chipWrap) {
    chipWrap.querySelectorAll(".chip").forEach(chip => {
      chip.addEventListener("click", () => {
        chipWrap.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
        chip.classList.add("active");
        updateSaveButtonState();
        updateAquisicaoSectionVisibility();
      });
    });
  }

  // Botão salvar (footer e header) - validação e estado
  const saveButtons = document.querySelectorAll(".btnSaveAnimal");
  saveButtons.forEach((btn) => {
    if (btn.__bound) return;
    btn.__bound = true;
    btn.addEventListener("click", async () => {
      const check = validateAnimalFormRequired();
      if (!check.ok) {
        toast(`Campo obrigatório: ${check.key}`);
        return;
      }
      const allSaveBtns = document.querySelectorAll(".btnSaveAnimal");
      allSaveBtns.forEach((b) => {
        b.disabled = true;
        b.textContent = "Salvando...";
      });
      try {
        await saveAnimalFromForm();
      } finally {
        allSaveBtns.forEach((b) => {
          b.disabled = false;
          b.textContent = "Salvar Animal";
        });
      }
    });
  });

  // toggle avançado
  const tgl = $("#toggleAdvanced");
  if (tgl) {
    tgl.onchange = async (e) => {
      state.advanced = !!e.target.checked;
      await idbSet("meta", "animal_advanced", state.advanced ? "1" : "0");
      applyAdvancedVisibility();
    };
  }
}

function applyAdvancedVisibility() {
  const group = $("#advancedGroup");
  if (group) {
    group.style.display = state.advanced ? "block" : "none";
  }
}

async function openAnimalList() {
  await openDashboard();
}

async function openAnimalFormForCreate() {
  if (await isSyncInProgress()) {
    toast("Aguarde a finalização da sincronização para criar um novo animal.");
    return;
  }

  state.view = "module";
  state.activeKey = "animal";
  state.animalView = "form";
  state.animalEditingId = null;

  // Esconde FAB Sync imediatamente ao abrir o form
  const fabSync = document.getElementById("fabSync");
  if (fabSync) {
    fabSync.hidden = true;
    fabSync.style.display = "none"; // Força esconder também via CSS
  }

  // mostra header do form
  setPageHeadTexts("Informações do animal", "Cadastre ou atualize aqui");
  setPageHeadVisible(true);

  const secList = $("#modAnimaisList");
  const secForm = $("#modAnimaisForm");
  if (secList) secList.hidden = true;
  if (secForm) {
    secForm.hidden = false;
    // Quando o form de animal é aberto como parte da linha de produção,
    // marcamos o formulário com uma classe especial para aplicar o mesmo
    // estilo/posicionamento dos módulos do pipeline.
    if (state.pipelineFromCreate) {
      secForm.classList.add("animalFormPipeline");
    } else {
      secForm.classList.remove("animalFormPipeline");
    }
  }

  bindAnimalFormUIOnce();
  populateFixedDropdowns(); // Popula dropdowns fixos (UF, Raça, etc.)
  await fillOwnersAndLotesInForm();

  // Quando o form está dentro do pipeline: botão Voltar volta para o modal inicial
  if (state.pipelineFromCreate) {
    const btnVoltar = document.getElementById("btnVoltarTopo");
    if (btnVoltar && !btnVoltar.__pipelineBackBound) {
      btnVoltar.__pipelineBackBound = true;
      btnVoltar.addEventListener("click", async () => {
        const ok = await confirmPipelineLoseData("Informações do animal", null);
        if (!ok) return;
        moveAnimalFormBackToContainer();
        const pipelineModal = document.getElementById("pipelineModal");
        const stepContent = document.getElementById("pipelineStepContent");
        if (pipelineModal) pipelineModal.hidden = false;
        if (stepContent) {
          stepContent.hidden = true;
          stepContent.classList.remove("pipelineStepContent--animalForm");
        }
        const wrap = document.getElementById("pipelineWrap");
        if (wrap) wrap.classList.remove("pipelineWrap--animalForm");
        state.pipelineFromCreate = false;
        state.pipelineCreateCallback = null;
        state.animalView = null;
        state.activeKey = null;
        renderSidebar();
        updateFabSyncVisibility();
      });
    }
  }

  // advanced state - sempre inicia desligado
  state.advanced = false;
  const tgl = $("#toggleAdvanced");
  if (tgl) tgl.checked = false;
  applyAdvancedVisibility();
  updateAquisicaoSectionVisibility();

  // default owner - colaborador_principal da fazenda; se não houver, primeiro colaborador vinculado ou ownerId da sessão
  const fazendaAtual = await idbGet("fazenda", "current");
  const colaboradores = (await idbGet("colaboradores", "list")) || [];
  const fazendaId = getCurrentFazendaId();
  const principalId = fazendaAtual?.colaborador_principal;
  let defaultOwner = principalId || "";
  if (!defaultOwner) {
    const vinculado = colaboradores.find(c =>
      Array.isArray(c.fazendas) && c.fazendas.some(f => String(f) === String(fazendaId))
    );
    if (vinculado) defaultOwner = vinculado._id;
  }
  if (!defaultOwner) defaultOwner = state.ctx.ownerId || "";
  
  const initData = {
    owner: defaultOwner,
    entry_type: "Compra",
    animal_type: "Físico",
    brinco_padrao: "",
    sexo: "",
    peso_atual_kg: 0,
    data_nascimento: "",
    categoria: "",
    raca: "",
    nome_completo: "",
    finalidade: "",
    peso_nascimento: 0,
    sisbov: "",
    identificacao_eletronica: "",
    rgd: "",
    rgn: "",
    list_lotes: [],
    lote: "",
    pasto: "",
    observacoes: "",
    mae_vinculo: "",
    pai_vinculo: "",
    data_aquisicao: "",
    nota_fiscal: "",
    valor_animal: 0,
    origem_fornecedor: "",
    numero_gta: "",
    uf_gta: "",
    serie_gta: "",
    data_emissao_gta: "",
    data_validade_gta: "",
  };

  await writeAnimalFormByIds(initData);
  updateAquisicaoSectionVisibility();

  if (state.pipelineRestoreDraft) {
    state.pipelineRestoreDraft = false;
    try {
      const raw = sessionStorage.getItem("pipelineCreateDraft");
      if (raw) {
        const draft = JSON.parse(raw);
        sessionStorage.removeItem("pipelineCreateDraft");
        const formData = {
          owner: draft.proprietario || draft.owner || "",
          animal_type: draft.animal_type || "Físico",
          brinco_padrao: draft.brinco_padrao || "",
          sexo: draft.sexo || "",
          peso_atual_kg: draft.peso_atual_kg ?? 0,
          data_nascimento: draft.data_nascimento || "",
          categoria: draft.categoria || "",
          raca: draft.raca || "",
          nome_completo: draft.nome_completo || "",
          finalidade: draft.finalidade || "",
          peso_nascimento: draft.peso_nascimento ?? 0,
          sisbov: draft.sisbov || "",
          identificacao_eletronica: draft.identificacao_eletronica || "",
          rgd: draft.rgd || "",
          rgn: draft.rgn || "",
          list_lotes: Array.isArray(draft.list_lotes) ? draft.list_lotes : (draft.lote ? [draft.lote] : []),
          lote: draft.lote || "",
          pasto: draft.pasto || "",
          observacoes: draft.observacoes || "",
          mae_cadastrada: draft.mae_cadastrada || "0",
          pai_cadastrado: draft.pai_cadastrado || "0",
          mae_vinculo: draft.mae_vinculo || "",
          pai_vinculo: draft.pai_vinculo || "",
          data_aquisicao: draft.data_aquisicao || "",
          nota_fiscal: draft.nota_fiscal || "",
          valor_animal: draft.valor_animal ?? draft.valor ?? 0,
          origem_fornecedor: draft.origem_fornecedor || "",
          numero_gta: draft.numero_gta || draft.gta || "",
          uf_gta: draft.uf_gta || draft.uf || "",
          serie_gta: draft.serie_gta || "",
          data_emissao_gta: draft.data_emissao_gta || "",
          data_validade_gta: draft.data_validade_gta || "",
          entry_type: draft.entry_type || "Compra",
        };
        await writeAnimalFormByIds(formData);
        updateAquisicaoSectionVisibility();
      }
    } catch (_) {}
  }

  setPageHeadTexts("Informações do animal", "Cadastre ou atualize aqui");

  const fabSync2 = document.getElementById("fabSync");
  if (fabSync2) {
    fabSync2.hidden = true;
    fabSync2.style.display = "none";
    fabSync2.style.visibility = "hidden";
    fabSync2.style.opacity = "0";
    fabSync2.style.pointerEvents = "none";
  }

  await saveNavigationState();
}

async function saveAnimalFromForm() {
  if (await isSyncInProgress()) {
    toast("Aguarde a finalização da sincronização para salvar alterações.");
    return;
  }

  const check = validateAnimalFormRequired();
  if (!check.ok) {
    toast(`Campo obrigatório: ${check.key}`);
    return;
  }

  // Mostra loading
  const bootOverlay = $("#bootOverlay");
  const bootSub = $("#bootSub");
  if (bootOverlay) {
    bootOverlay.style.display = "flex";
    if (bootSub) bootSub.textContent = "Salvando animal...";
  }

  try {
    const data = readAnimalFormByIds();

    const list = (await idbGet("animais", "list")) || [];
    const arr = Array.isArray(list) ? list.map(normalizeAnimal) : [];

    const target = normBrinco(data.brinco_padrao);
    const editingId = state.animalEditingId;

    // valida brinco duplicado (permitindo o próprio registro quando editando)
    const exists = arr.some(a => {
      const sameBr = normBrinco(a?.brinco_padrao) === target;
      const sameId = String(a?._id || "") === String(editingId || "");
      return sameBr && !sameId;
    });

    if (exists) {
      toast("Já existe um animal com este brinco padrão. Não é possível salvar.");
      return;
    }

    const fazenda = await idbGet("fazenda", "current");
    const org = fazenda?.organizacao || "";

    if (!editingId) {
      // CREATE
      // Garante que proprietario seja salvo (converte owner para proprietario se necessário)
      const recordData = { ...data };
      if (recordData.owner && !recordData.proprietario) {
        recordData.proprietario = recordData.owner;
      }
      
      const record = normalizeAnimal({
        _id: `local:${uuid()}`,
        _local: true,
        _sync: "pending",
        fazenda: state.ctx.fazendaId,
        organizacao: org,
        deleted: false,
        ativo: true,
        morto: false,
        ...recordData,
      });

      arr.unshift(record);
            
      // IMPORTANTE: Usa toCloneable para garantir que os dados sejam serializáveis
      const arrToSave = toCloneable(arr);
      await idbSet("animais", "list", arrToSave);
      
      // Verifica se foi salvo corretamente
      const verifica = await idbGet("animais", "list");
      const totalAnimais = Array.isArray(verifica) ? verifica.length : 0;
      
      const encontrado = Array.isArray(verifica) ? verifica.find(a => String(a?._id) === String(record._id)) : null;
      if (!encontrado) {
        console.error("[SAVE] ERRO: Animal não foi salvo corretamente no IndexedDB!");
        console.error("[SAVE] DEBUG - Lista completa:", verifica);
      } else {
        
        // Verifica quantos animais locais pendentes existem agora
        const animaisLocaisPendentes = Array.isArray(verifica) 
          ? verifica.filter(a => {
              const id = String(a?._id || "").toLowerCase();
              return (a?._local === true || id.startsWith("local:")) && String(a?._sync || "").toLowerCase() === "pending";
            })
          : [];
      }

      // fila
      const qKey = `queue:${state.ctx.fazendaId}:${state.ctx.ownerId}:animal`;
      const queue = (await idbGet("records", qKey)) || [];
      queue.push({ op: OFFLINE_OPS.ANIMAL_CREATE, at: Date.now(), payload: record });
      await idbSet("records", qKey, queue);

      updateFabSyncVisibility();
      toast("Animal salvo offline.");

      if (state.pipelineCreateCallback) {
        try {
          sessionStorage.setItem("pipelineCreateDraft", JSON.stringify(record));
        } catch (_) {}
        state.pipelineCreatedAnimalId = record._id || null;
        state.pipelineFromCreate = false;
        const cb = state.pipelineCreateCallback;
        state.pipelineCreateCallback = null;
        state.view = "dashboard";
        const dash = $("#modDashboard");
        const dashDesktop = document.getElementById("modDashboardDesktop");
        if (dash) dash.hidden = false;
        if (dashDesktop) dashDesktop.hidden = false;
        const animalContainer = $("#animalModuleContainer");
        if (animalContainer) animalContainer.hidden = true;
        const secList = $("#modAnimaisList");
        const secForm = $("#modAnimaisForm");
        if (secList) secList.hidden = true;
        if (secForm) secForm.hidden = true;
        state.pipelineAnimal = normalizeAnimal(record);
        state.pipelineStepIndex = 0;
        const pipelineModal = document.getElementById("pipelineModal");
        const stepContent = document.getElementById("pipelineStepContent");
        if (pipelineModal) pipelineModal.hidden = true;
        if (stepContent) stepContent.hidden = false;
        renderSidebar();
        cb(normalizeAnimal(record));
        return;
      }

      await renderDashboard();
      await openDashboard();
      return;
    }

    // UPDATE
    const idx = arr.findIndex(a => String(a?._id) === String(editingId));
    if (idx === -1) {
      toast("Não foi possível salvar: animal não encontrado.");
      return;
    }

    const prev = arr[idx];
    const updated = normalizeAnimal({
      ...prev,
      ...data,
      _local: prev._local || true,
      _sync: "pending",
      // Preserva data_modificacao do servidor para o backend comparar na sync
      data_modificacao: prev.data_modificacao,
    });

    arr[idx] = updated;
    await idbSet("animais", "list", arr);

    // fila
    const qKey = `queue:${state.ctx.fazendaId}:${state.ctx.ownerId}:animal`;
    const queue = (await idbGet("records", qKey)) || [];
    queue.push({ op: OFFLINE_OPS.ANIMAL_UPDATE, at: Date.now(), payload: updated, targetId: editingId });
    await idbSet("records", qKey, queue);

    await renderDashboard();
    toast("Animal atualizado offline.");
    await openDashboard();
  } finally {
    // Esconde loading
    if (bootOverlay) {
      bootOverlay.style.display = "none";
    }
  }
}

// ---------------- Render módulo ativo (desativado: app é só linha de produção) ----------------
async function renderActiveModule() {
  await openDashboard();
}

// ---------------- Movimentações: apenas no pipeline (renderPipelineStepMovimentacao) ----------------
async function renderMovimentacoesModule(container) {
  if (!container) return;
  await openDashboard();
}

// ---------------- Saída de Animais (módulo) ----------------
const SAIDA_ANIMAIS_TABS = [
  { id: "venda", label: "Venda", title: "Saída por venda de animais", sub: "Crie e gerencie as vendas de animais da sua fazenda", btnNew: "Nova venda" },
  { id: "morte", label: "Morte", title: "Saída por morte de animais", sub: "Registre óbitos dos animais da sua fazenda", btnNew: "Nova morte" },
  { id: "emprestimo", label: "Empréstimo", title: "Saída por empréstimo", sub: "Registre empréstimos de animais da sua fazenda", btnNew: "Novo empréstimo" },
  { id: "ajuste", label: "Ajuste inventário", title: "Ajuste de inventário", sub: "Ajustes de inventário de animais", btnNew: "Novo ajuste" },
  { id: "doacao", label: "Doação", title: "Saída por doação", sub: "Registre doações de animais da sua fazenda", btnNew: "Nova doação" }
];

/** Tela "Informações sobre a venda" (saída individual — apenas formulário, sem listagem).
 * options: { preselectedAnimal, onAfterConfirm, onBack } para uso na linha de produção.
 */
async function renderSaidaAnimaisVendaForm(container, options = {}) {
  if (!container) return;

  const mode = options.mode || "venda";
  const isEmprestimo = mode === "emprestimo";
  const isAjuste = mode === "ajuste";
  const isDoacao = mode === "doacao";
  const externalHeaderButton = options.headerButton || null;

  // Opções dos selects (sem pré-seleção; o pré-preenchimento é aplicado dinamicamente por applyModulePrefillToContainer)
  const condicaoOptions = CONDICAO_PAGAMENTO_LIST.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  const movimentacaoSaidaOptions = MOVIMENTACAO_SAIDA_ANIMAL_LIST.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join("");
  const ufOptions = UF_LIST.map(
    (u) => `<option value="${escapeHtml(u.value)}">${escapeHtml(u.label)}</option>`
  ).join("");

  const today = new Date().toISOString().slice(0, 10);

  const isPipelineContext = !!options.preselectedAnimal;

  container.innerHTML = `
    <div class="saVendaForm${isPipelineContext ? " saVendaFormPipeline" : ""}${isEmprestimo ? " saVendaFormEmprestimo" : ""}" id="saVendaForm">
      <div class="pageHead">
        <div class="pageHeadRow1">
          <button type="button" class="animalFormBackBtn" id="saVendaBack" aria-label="Voltar">← Voltar</button>
          <div class="pageHeadActions">
            <button type="button" class="animalFormHeaderBtn btnSaveAnimal" id="saVendaBtnRealizar">${
              isEmprestimo
                ? "Realizar empréstimo de animais"
                : isAjuste
                  ? "Realizar ajuste de inventário"
                  : isDoacao
                    ? "Realizar doação de animais"
                    : "Realizar saída de animais"
            }</button>
          </div>
        </div>
        <div class="pageHeadRow2">
          <h1 class="pageTitle">${
            isEmprestimo
              ? "Informações sobre o empréstimo"
              : isAjuste
                ? "Informações sobre ajuste de inventário"
                : isDoacao
                  ? "Informações sobre a doação"
                  : "Informações sobre a venda"
          }</h1>
          <p class="pageSub">${
            isEmprestimo
              ? "Registre o empréstimo do animal"
              : isAjuste
                ? "Registre o ajuste de inventário do animal"
                : isDoacao
                  ? "Registre a doação do animal"
                  : "Registre a saída individual do animal"
          }</p>
        </div>
      </div>
      <div class="saVendaFormBody saVendaFormOnly">
        <div class="saVendaFormCard">
          <div class="saVendaFormGrid">
            <div class="saVendaField saVendaFieldAnimal">
              <label for="vendaAnimalBrinco">Animal <span class="saVendaRequired">*</span></label>
              <div class="saVendaAnimalSearchWrap">
                <span class="saVendaAnimalSearchIcon" aria-hidden="true">&#128269;</span>
                <input type="text" id="vendaAnimalBrinco" class="saVendaAnimalSearchInput" placeholder="Digite o nº do Brinco" required aria-label="Buscar animal pelo brinco" autocomplete="off" />
              </div>
              <div id="vendaAnimalResults" class="saVendaAnimalResults" role="listbox" aria-label="Resultados da busca" hidden></div>
            </div>
            <div class="saVendaField saVendaFieldProprietarioDestino">
              <label for="vendaProprietarioDestino">Proprietário de destino <span class="saVendaRequired">*</span></label>
              <div class="saVendaAnimalSearchWrap">
                <span class="saVendaAnimalSearchIcon" aria-hidden="true">&#128269;</span>
                <input type="text" id="vendaProprietarioDestino" class="saVendaAnimalSearchInput" placeholder="Digite o nome do proprietário" aria-label="Buscar proprietário de destino" autocomplete="off" />
              </div>
              <div id="vendaProprietarioDestinoResults" class="saVendaAnimalResults" role="listbox" aria-label="Resultados da busca" hidden></div>
            </div>
            <div class="saVendaField saVendaFieldFazendaDestino" id="saVendaFazendaDestinoWrap" hidden>
              <label for="vendaFazendaDestino">Fazenda de destino</label>
              <select id="vendaFazendaDestino" class="saVendaSelect"><option value="">Selecione a fazenda de destino</option></select>
            </div>
            <div class="saVendaField">
              <label for="vendaValor">Valor</label>
              <div class="saVendaCurrencyWrap">
                <span class="saVendaCurrencyPrefix" aria-hidden="true">R$</span>
                <input type="text" id="vendaValor" class="saVendaInput saVendaInputCurrency" placeholder="0,00" inputmode="decimal" data-raw="" />
              </div>
            </div>
            <div class="saVendaField">
              <label for="vendaPeso">Peso</label>
              <input type="number" id="vendaPeso" class="saVendaInput" placeholder="kg" min="0" step="0.01" inputmode="decimal" />
            </div>
            <div class="saVendaField">
              <label for="vendaCondicaoPagamento">Condição de Pagamento</label>
              <select id="vendaCondicaoPagamento" class="saVendaSelect"><option value="">Selecione a condição de pagamento</option>${condicaoOptions}</select>
            </div>
            <div class="saVendaField">
              <label for="vendaMovimentacaoSaida">Tipo de saída</label>
              <select id="vendaMovimentacaoSaida" class="saVendaSelect"><option value="">Selecione o tipo de saída</option>${movimentacaoSaidaOptions}</select>
            </div>
            <div class="saVendaField">
              <label for="vendaData">Data</label>
              <input type="date" id="vendaData" class="saVendaInput" value="${today}" />
            </div>
            <div class="saVendaField">
              <label for="vendaNotaFiscal">Número da nota fiscal</label>
              <input type="text" id="vendaNotaFiscal" class="saVendaInput" placeholder="Nota fiscal" />
            </div>
            <div class="saVendaField">
              <label for="vendaNumeroGTA">N° GTA</label>
              <input type="text" id="vendaNumeroGTA" class="saVendaInput" placeholder="Número GTA" />
            </div>
            <div class="saVendaField">
              <label for="vendaDataEmissaoGTA">Data emissão GTA <span class="saVendaRequired">*</span></label>
              <input type="date" id="vendaDataEmissaoGTA" class="saVendaInput" value="${today}" required />
            </div>
            <div class="saVendaField">
              <label for="vendaDataValidadeGTA">Data validade GTA <span class="saVendaRequired">*</span></label>
              <input type="date" id="vendaDataValidadeGTA" class="saVendaInput" value="${today}" required />
            </div>
            <div class="saVendaField">
              <label for="vendaSerie">Série</label>
              <input type="text" id="vendaSerie" class="saVendaInput" placeholder="Série da GTA" />
            </div>
            <div class="saVendaField">
              <label for="vendaUF">UF</label>
              <select id="vendaUF" class="saVendaSelect"><option value="">Selecione</option>${ufOptions}</select>
            </div>
          </div>
        </div>
      </div>
      <!-- Modal Confirmar venda de animais -->
      <div id="saVendaModalConfirm" class="saVendaModalOverlay" hidden aria-modal="true" role="dialog" aria-labelledby="saVendaModalTitle">
        <div class="saVendaModal">
          <div class="saVendaModalHeader">
            <h2 id="saVendaModalTitle" class="saVendaModalTitle">Confirmar venda de animais</h2>
            <p class="saVendaModalSub">Revise os detalhes antes de confirmar a saída dos animais.</p>
            <button type="button" class="saVendaModalClose" id="saVendaModalClose" aria-label="Fechar">&times;</button>
          </div>
          <div class="saVendaModalBody">
            <div class="saVendaModalOrigemDestino">
              <div class="saVendaModalCard saVendaModalOrigem">
                <span class="saVendaModalCardIcon" aria-hidden="true">&#128970;</span>
                <span class="saVendaModalCardLabel">Origem</span>
                <span id="saVendaModalOrigemNome" class="saVendaModalCardValue">—</span>
              </div>
              <span class="saVendaModalArrow" aria-hidden="true">→</span>
              <div class="saVendaModalCard saVendaModalDestino">
                <span class="saVendaModalCardIcon" aria-hidden="true">&#128205;</span>
                <span class="saVendaModalCardLabel">Destino</span>
                <span id="saVendaModalDestinoNome" class="saVendaModalCardValue">—</span>
              </div>
            </div>
            <div class="saVendaModalQtd">
              <span class="saVendaModalQtdIcon" aria-hidden="true">&#128046;</span>
              <span id="saVendaModalQtdText">Quantidade de animais: 1</span>
            </div>
            <div class="saVendaModalDetalhes">
              <div class="saVendaModalCol">
                <p class="saVendaModalDetalhe"><span class="saVendaModalDetalheLabel">Data de aquisição:</span> <span id="saVendaModalDataAquisicao">—</span></p>
                <p class="saVendaModalDetalhe"><span class="saVendaModalDetalheLabel">Número da nota fiscal:</span> <span id="saVendaModalNotaFiscal">—</span></p>
                <p class="saVendaModalDetalhe"><span class="saVendaModalDetalheLabel">Valor da aquisição:</span> <span id="saVendaModalValorAquisicao">—</span></p>
              </div>
              <div class="saVendaModalCol">
                <p class="saVendaModalDetalhe"><span class="saVendaModalDetalheLabel">Número GTA:</span> <span id="saVendaModalNumeroGTA">—</span></p>
                <p class="saVendaModalDetalhe"><span class="saVendaModalDetalheLabel">Data emissão GTA:</span> <span id="saVendaModalDataEmissaoGTA">—</span></p>
                <p class="saVendaModalDetalhe"><span class="saVendaModalDetalheLabel">Série GTA:</span> <span id="saVendaModalSerieGTA">—</span></p>
                <p class="saVendaModalDetalhe"><span class="saVendaModalDetalheLabel">Estado:</span> <span id="saVendaModalEstado">—</span></p>
                <p class="saVendaModalDetalhe"><span class="saVendaModalDetalheLabel">Data validade GTA:</span> <span id="saVendaModalDataValidadeGTA">—</span></p>
              </div>
            </div>
            <div class="saVendaModalAviso">
              <span class="saVendaModalAvisoIcon" aria-hidden="true">&#9888;</span>
              <span>Por favor, confira se as informações estão corretas. Essa ação não poderá ser desfeita!</span>
            </div>
          </div>
          <div class="saVendaModalFooter">
            <button type="button" class="saVendaModalBtn saVendaModalBtnCancel" id="saVendaModalCancel">Cancelar</button>
            <button type="button" class="saVendaModalBtn saVendaModalBtnConfirm" id="saVendaModalConfirmBtn">Confirmar saída de animais</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // Prefill dinâmico baseado no modo (venda x empréstimo x ajuste x doação)
  const abaKeyForPrefill = isEmprestimo
    ? "emprestimo"
    : isAjuste
      ? "ajuste inventário"
      : isDoacao
        ? "doacao"
        : "Venda";
  applyModulePrefillToContainer(container, "saida_animais", abaKeyForPrefill);

  const innerBtn = container.querySelector("#saVendaBtnRealizar");
  const headerBtn = externalHeaderButton || innerBtn;

  // Se estamos no pipeline e usando botão externo (header do passo), escondemos o header interno do formulário
  if (externalHeaderButton && isPipelineContext) {
    const innerHead = container.querySelector(".pageHead");
    if (innerHead) innerHead.style.display = "none";
  }

  const backBtn = container.querySelector("#saVendaBack");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      if (options.onBack) options.onBack();
      else renderSaidaAnimaisModule(container);
    });
  }

  if (isEmprestimo || isAjuste || isDoacao) {
    // Para empréstimo/ajuste/doação, tipo de saída é fixo e alguns campos são escondidos.
    const movSel = container.querySelector("#vendaMovimentacaoSaida");
    if (movSel) {
      movSel.value = isEmprestimo ? "Empréstimo" : isAjuste ? "Ajuste inventário" : "Doação";
      movSel.disabled = true;
      const movField = movSel.closest(".saVendaField");
      if (movField) movField.style.display = "none";
    }
    const condField = container.querySelector("#vendaCondicaoPagamento")?.closest(".saVendaField");
    if (condField) condField.style.display = "none";
    // Campos de GTA/UF não são exibidos na aba de empréstimo.
    ["vendaNumeroGTA", "vendaDataEmissaoGTA", "vendaDataValidadeGTA", "vendaSerie", "vendaUF"].forEach((id) => {
      const el = container.querySelector(`#${id}`);
      if (el) {
        const field = el.closest(".saVendaField");
        if (field) field.style.display = "none";
      }
    });
  }

  if (options.preselectedAnimal) {
    const animal = options.preselectedAnimal;
    const displayName = `${animal.brinco_padrao || "—"} — ${String(animal.nome_completo || "").trim() || "—"}`;

    // Mostra o animal atual no header
    const headRow2 = container.querySelector(".pageHeadRow2");
    if (headRow2) {
      const info = document.createElement("p");
      info.className = "saVendaHeaderAnimal";
      info.textContent = displayName;
      headRow2.appendChild(info);
    }

    const inputBrinco = container.querySelector("#vendaAnimalBrinco");
    if (inputBrinco) {
      inputBrinco.value = displayName;
      inputBrinco.setAttribute("data-selected-id", animal._id || "");
      inputBrinco.readOnly = true;
      const wrap = container.querySelector(".saVendaFieldAnimal");
      if (wrap) {
        wrap.classList.add("pipeline-animal-locked");
        // some o campo de busca de animal no fluxo da linha de produção
        wrap.style.display = "none";
      }
    }
    const pesoInput = container.querySelector("#vendaPeso");
    if (pesoInput && (animal.peso_atual_kg != null)) pesoInput.value = animal.peso_atual_kg;
    const valorInput = container.querySelector("#vendaValor");
    if (valorInput && (animal.valor_animal != null)) {
      const v = Number(animal.valor_animal);
      if (!isNaN(v)) {
        valorInput.setAttribute("data-raw", String(v));
        valorInput.value = v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
    }
  }

  /** Formata string de dígitos em moeda BR (ex.: "120000" -> "1.200,00"). Usado no campo Valor e ao pré-preencher. */
  function formatBrCurrencyFromDigits(digits) {
    const d = String(digits).replace(/\D/g, "") || "0";
    if (d === "0" || d === "") return "";
    const len = d.length;
    const intPart = len <= 2 ? "0" : d.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    const decPart = len >= 2 ? d.slice(-2) : d.padStart(2, "0");
    return intPart + "," + decPart;
  }

  /** Formata data YYYY-MM-DD para DD/MM/YYYY para exibição no modal. */
  function formatBrDate(isoDate) {
    if (!isoDate || !String(isoDate).trim()) return "—";
    const s = String(isoDate).trim().slice(0, 10);
    if (s.length < 10) return s || "—";
    const [y, m, d] = s.split("-");
    return `${d}/${m}/${y}`;
  }

  const modalOverlay = container.querySelector("#saVendaModalConfirm");
  const modalCloseBtn = container.querySelector("#saVendaModalClose");
  const modalCancelBtn = container.querySelector("#saVendaModalCancel");
  const modalConfirmBtn = container.querySelector("#saVendaModalConfirmBtn");
  const modalTitleEl = document.getElementById("saVendaModalTitle");
  const modalSubEl = document.querySelector(".saVendaModalSub");

  function closeVendaModal() {
    if (modalOverlay) modalOverlay.hidden = true;
  }

  function openVendaModal(data) {
    if (!modalOverlay) return;
    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text ?? "—";
    };
    set("saVendaModalOrigemNome", data.origemNome);
    set("saVendaModalDestinoNome", data.destinoNome);
    set("saVendaModalQtdText", `Quantidade de animais: ${data.quantidade ?? 1}`);

    const dataSpan = document.getElementById("saVendaModalDataAquisicao");
    const valorSpan = document.getElementById("saVendaModalValorAquisicao");
    const col2 = document.querySelector(".saVendaModalCol:nth-child(2)");

    if (isEmprestimo || isAjuste || isDoacao) {
      // Empréstimo / Ajuste inventário / Doação (layout enxuto: data, nota, peso)
      if (modalTitleEl) {
        modalTitleEl.textContent = isEmprestimo
          ? "Confirmar empréstimo de animais"
          : isAjuste
            ? "Confirmar ajuste de inventário"
            : "Confirmar doação de animais";
      }
      if (modalSubEl) {
        modalSubEl.textContent = isEmprestimo
          ? "Revise os detalhes antes de confirmar o empréstimo."
          : isAjuste
            ? "Revise os detalhes antes de confirmar o ajuste de inventário."
            : "Revise os detalhes antes de confirmar a doação.";
      }
      if (dataSpan && dataSpan.previousElementSibling) {
        dataSpan.previousElementSibling.textContent = isEmprestimo
          ? "Data de empréstimo:"
          : isAjuste
            ? "Data de ajuste:"
            : "Data de doação:";
      }
      if (valorSpan && valorSpan.previousElementSibling) {
        valorSpan.previousElementSibling.textContent = "Peso:";
      }
      set("saVendaModalDataAquisicao", data.dataAquisicao);
      set("saVendaModalNotaFiscal", data.notaFiscal);
      set("saVendaModalValorAquisicao", data.pesoTexto || "—");
      if (col2) col2.style.display = "none";
      if (modalConfirmBtn) {
        modalConfirmBtn.textContent = isEmprestimo
          ? "Confirmar empréstimo de animais"
          : isAjuste
            ? "Confirmar ajuste de inventário"
            : "Confirmar doação de animais";
      }
    } else {
      // Venda (padrão)
      if (modalTitleEl) modalTitleEl.textContent = "Confirmar venda de animais";
      if (modalSubEl) modalSubEl.textContent = "Revise os detalhes antes de confirmar a saída dos animais.";
      if (dataSpan && dataSpan.previousElementSibling) {
        dataSpan.previousElementSibling.textContent = "Data de aquisição:";
      }
      if (valorSpan && valorSpan.previousElementSibling) {
        valorSpan.previousElementSibling.textContent = "Valor da aquisição:";
      }
      set("saVendaModalDataAquisicao", data.dataAquisicao);
      set("saVendaModalNotaFiscal", data.notaFiscal);
      set("saVendaModalValorAquisicao", data.valorAquisicao);
      set("saVendaModalNumeroGTA", data.numeroGTA);
      set("saVendaModalDataEmissaoGTA", data.dataEmissaoGTA);
      set("saVendaModalSerieGTA", data.serieGTA);
      set("saVendaModalEstado", data.estado);
      set("saVendaModalDataValidadeGTA", data.dataValidadeGTA);
      if (col2) col2.style.display = "";
      if (modalConfirmBtn) modalConfirmBtn.textContent = "Confirmar saída de animais";
    }
    modalOverlay.hidden = false;
  }

  if (modalCloseBtn) modalCloseBtn.addEventListener("click", closeVendaModal);
  if (modalCancelBtn) modalCancelBtn.addEventListener("click", closeVendaModal);
  if (modalOverlay) {
    modalOverlay.addEventListener("click", (e) => {
      if (e.target === modalOverlay) closeVendaModal();
    });
  }

  const btnRealizar = headerBtn;
  if (btnRealizar) {
    if (isEmprestimo || isAjuste || isDoacao) {
      btnRealizar.disabled = true;
    }
    btnRealizar.addEventListener("click", async () => {
      const animalBrinco = container.querySelector("#vendaAnimalBrinco");
      const proprietarioDestino = container.querySelector("#vendaProprietarioDestino");
      const fazendaDestinoWrap = container.querySelector("#saVendaFazendaDestinoWrap");
      const fazendaDestinoSelect = container.querySelector("#vendaFazendaDestino");
      const dataEmissao = container.querySelector("#vendaDataEmissaoGTA");
      const dataValidade = container.querySelector("#vendaDataValidadeGTA");
      if (!animalBrinco?.value?.trim()) {
        toast("Informe o animal (digite o nº do Brinco).");
        return;
      }
      if (!proprietarioDestino?.value?.trim() || !proprietarioDestino.getAttribute("data-selected-id")) {
        toast("Selecione o Proprietário de destino (busque e escolha na lista).");
        return;
      }
      if (fazendaDestinoWrap && !fazendaDestinoWrap.hidden && fazendaDestinoSelect && !fazendaDestinoSelect.value?.trim()) {
        toast("Selecione a Fazenda de destino.");
        return;
      }
      if (!isEmprestimo && !isAjuste && !isDoacao) {
        if (!dataEmissao?.value || !dataValidade?.value) {
          toast("Preencha Data emissão GTA e Data validade GTA.");
          return;
        }
      }
      const fazenda = await idbGet("fazenda", "current");
      const origemNome = fazenda?.name || fazenda?.nome || "—";
      const destinoNome = proprietarioDestino.value.trim() || "—";
      const vendaData = container.querySelector("#vendaData")?.value;
      const vendaNotaFiscal = container.querySelector("#vendaNotaFiscal")?.value?.trim();
      const vendaValor = container.querySelector("#vendaValor");
      const vendaPesoInput = container.querySelector("#vendaPeso");
      const valorRaw = vendaValor?.dataset?.raw ?? vendaValor?.value;
      const valorAquisicao = (valorRaw !== undefined && valorRaw !== "") ? (formatBrCurrencyFromDigits(String(Math.round(parseFloat(valorRaw) * 100))) || "—") : "—";
      const pesoValor = Number(vendaPesoInput?.value) || 0;
      const pesoTexto = pesoValor > 0 ? `${pesoValor} kg` : "—";
      const numeroGTA = container.querySelector("#vendaNumeroGTA")?.value?.trim();
      const serieGTA = container.querySelector("#vendaSerie")?.value?.trim();
      const ufSelect = container.querySelector("#vendaUF");
      const estadoOpt = ufSelect?.options?.[ufSelect.selectedIndex];
      const estado = estadoOpt?.text?.trim() && estadoOpt?.value ? estadoOpt.text.trim() : "—";
      openVendaModal({
        origemNome,
        destinoNome,
        quantidade: 1,
        dataAquisicao: formatBrDate(vendaData),
        notaFiscal: vendaNotaFiscal || "—",
        valorAquisicao,
        pesoTexto,
        numeroGTA: numeroGTA || "—",
        dataEmissaoGTA: formatBrDate(dataEmissao?.value),
        serieGTA: serieGTA || "—",
        estado,
        dataValidadeGTA: formatBrDate(dataValidade?.value),
      });
    });
  }

  if ((isEmprestimo || isAjuste || isDoacao) && btnRealizar) {
    const proprietarioDestino = container.querySelector("#vendaProprietarioDestino");
    const fazendaDestinoWrap = container.querySelector("#saVendaFazendaDestinoWrap");
    const fazendaDestinoSelect = container.querySelector("#vendaFazendaDestino");
    const dataInput = container.querySelector("#vendaData");
    const updateBtnState = () => {
      const hasProprietario = !!(proprietarioDestino?.value?.trim() && proprietarioDestino.getAttribute("data-selected-id"));
      const needsFazenda = fazendaDestinoWrap && !fazendaDestinoWrap.hidden;
      const hasFazenda = !needsFazenda || !!fazendaDestinoSelect?.value?.trim();
      const hasData = !!dataInput?.value;
      const ok = hasProprietario && hasFazenda && hasData;
      btnRealizar.disabled = !ok;
    };
    proprietarioDestino?.addEventListener("input", updateBtnState);
    proprietarioDestino?.addEventListener("change", updateBtnState);
    fazendaDestinoSelect?.addEventListener("change", updateBtnState);
    dataInput?.addEventListener("change", updateBtnState);
    updateBtnState();
  }
  if (modalConfirmBtn) {
    modalConfirmBtn.addEventListener("click", async () => {
      const animalBrinco = container.querySelector("#vendaAnimalBrinco");
      const proprietarioDestino = container.querySelector("#vendaProprietarioDestino");
      const fazendaDestinoWrap = container.querySelector("#saVendaFazendaDestinoWrap");
      const fazendaDestinoSelect = container.querySelector("#vendaFazendaDestino");
      const animalId = animalBrinco?.getAttribute("data-selected-id")?.trim();
      const proprietarioId = proprietarioDestino?.getAttribute("data-selected-id")?.trim();
      if (!animalId || !proprietarioId) {
        toast("Dados do animal ou proprietário não encontrados. Feche e preencha novamente.");
        return;
      }
      const fazenda = await idbGet("fazenda", "current");
      const owner = await idbGet("owner", "current");
      const fazendaOrigemId = String(state.ctx.fazendaId || fazenda?._id || "").trim();
      const userAtualId = String(state.ctx.ownerId || owner?._id || "").trim();
      const fazendaDestinoId = (fazendaDestinoWrap && !fazendaDestinoWrap.hidden && fazendaDestinoSelect?.value) ? String(fazendaDestinoSelect.value).trim() : "";
      const vendaData = container.querySelector("#vendaData")?.value;
      const vendaPeso = container.querySelector("#vendaPeso");
      const pesoSaida = Number(vendaPeso?.value) || 0;
      const notaFiscal = container.querySelector("#vendaNotaFiscal")?.value?.trim() || "";
      const vendaValor = container.querySelector("#vendaValor");
      const valorNum = parseFloat(vendaValor?.dataset?.raw ?? vendaValor?.value ?? 0) || 0;
      const condicaoPagamento = (isEmprestimo || isAjuste || isDoacao)
        ? ""
        : (container.querySelector("#vendaCondicaoPagamento")?.value?.trim() || "");
      let movimentacaoSaida = container.querySelector("#vendaMovimentacaoSaida")?.value?.trim() || "";
      if (isEmprestimo) movimentacaoSaida = "Empréstimo";
      else if (isAjuste) movimentacaoSaida = "Ajuste inventário";
      else if (isDoacao) movimentacaoSaida = "Doação";
      const movimentacaoEntrada = movimentacaoSaida ? (MOVIMENTACAO_SAIDA_TO_ENTRADA[movimentacaoSaida] ?? "") : "";
      const numeroGTA = container.querySelector("#vendaNumeroGTA")?.value?.trim() || "";
      const serieGTA = container.querySelector("#vendaSerie")?.value?.trim() || "";
      const dataEmissaoGTA = container.querySelector("#vendaDataEmissaoGTA")?.value;
      const dataValidadeGTA = container.querySelector("#vendaDataValidadeGTA")?.value;
      const ufGTA = container.querySelector("#vendaUF")?.value?.trim() || "";
      const dataAquisicaoTs = vendaData ? dateToTimestampSync(vendaData) : null;
      const dataEmissaoTs = dataEmissaoGTA ? dateToTimestampSync(dataEmissaoGTA) : null;
      const dataValidadeTs = dataValidadeGTA ? dateToTimestampSync(dataValidadeGTA) : null;
      const qKey = `queue:${state.ctx.fazendaId || ""}:${state.ctx.ownerId || ""}:animal`;
      const queueBefore = (await idbGet("records", qKey)) || [];
      const pesoCreateItem = queueBefore.find((item) => item.op === OFFLINE_OPS.ANIMAL_CREATE_PESO && String(item.payload?.animal) === String(animalId));
      const animaisList = (await idbGet("animais", "list")) || [];
      const animalRecord = animaisList.find((a) => String(a?._id) === String(animalId));
      const existingPeso = animalRecord?.animal_peso && typeof animalRecord.animal_peso === "object" ? animalRecord.animal_peso : null;
      const animalPesoId = pesoCreateItem?._id || `local:${uuid()}`;
      const animalPeso = {
        _id: animalPesoId,
        animal: animalId,
        data_pesagem: (existingPeso?.data_pesagem || pesoCreateItem?.payload?.data_pesagem) || new Date().toISOString(),
        peso_atual_kg: (existingPeso?.peso_atual_kg ?? pesoCreateItem?.payload?.peso_atual_kg) ?? pesoSaida,
        tipo_equipamento: (existingPeso?.tipo_equipamento || pesoCreateItem?.payload?.tipo_equipamento) || "Manual",
        momento_pesagem: (existingPeso?.momento_pesagem || pesoCreateItem?.payload?.momento_pesagem) || "Pesagem regular",
        user: (existingPeso?.user || pesoCreateItem?.payload?.user) || userAtualId,
      };
      const payload = {
        animais: [animalId],
        animal: animalId,
        animal_peso: animalPeso,
        proprietario_destino: proprietarioId || null,
        fazenda_destino: fazendaDestinoId || null,
        peso_saida: pesoSaida,
        nota_fiscal: notaFiscal != null && String(notaFiscal).trim() !== "" ? String(notaFiscal).trim() : "",
        data_aquisicao: dataAquisicaoTs != null ? dataAquisicaoTs : null,
        valor: valorNum,
        condicao_pagamento: condicaoPagamento != null && String(condicaoPagamento).trim() !== "" ? String(condicaoPagamento).trim() : "",
        movimentacao_saida_animal: movimentacaoSaida !== "" ? movimentacaoSaida : "",
        movimentacao_entrada_animal: movimentacaoEntrada !== "" ? movimentacaoEntrada : "",
        numero_gta: numeroGTA != null && String(numeroGTA).trim() !== "" ? String(numeroGTA).trim() : "",
        serie_gta: serieGTA != null && String(serieGTA).trim() !== "" ? String(serieGTA).trim() : "",
        data_emissao_gta: dataEmissaoTs != null ? dataEmissaoTs : null,
        data_validade_gta: dataValidadeTs != null ? dataValidadeTs : null,
        uf_gta: ufGTA != null && String(ufGTA).trim() !== "" ? String(ufGTA).trim() : "",
        fazenda_origem: fazendaOrigemId || null,
        user_atual: userAtualId || null,
        valor_saida: valorNum,
        fazenda_fora_sistema: !!isFazendaForaSistemaDestino,
      };
      const opSaida = SAIDA_TIPO_TO_OFFLINE_OP[movimentacaoSaida] || OFFLINE_OPS.CREATE_SAIDA_ANIMAIS_VENDA;
      queueBefore.push({ _id: `local:${uuid()}`, op: opSaida, at: Date.now(), payload });
      await idbSet("records", qKey, queueBefore);
      updateFabSyncVisibility();
      closeVendaModal();
      toast("Saída de animais registrada. Será sincronizada quando houver conexão.");
      options?.onAfterConfirm?.();
    });
  }

  // Busca de animal por brinco (IndexedDB): mostra resultados abaixo do campo
  const inputBrinco = container.querySelector("#vendaAnimalBrinco");
  const resultsEl = container.querySelector("#vendaAnimalResults");
  let searchDebounce = null;

  async function searchAnimaisByBrinco(query) {
    const q = String(query || "").trim();
    if (!q) {
      resultsEl.hidden = true;
      resultsEl.innerHTML = "";
      return;
    }
    const raw = (await idbGet("animais", "list")) || [];
    const animais = filterByCurrentFazenda(raw).filter((a) => !a.deleted).map(normalizeAnimal);
    const lower = q.toLowerCase();
    const matches = animais.filter((a) => {
      const brinco = String(a.brinco_padrao || "").toLowerCase();
      return brinco.includes(lower) || (q.length >= 2 && brinco.includes(lower));
    });
    if (matches.length === 0) {
      resultsEl.innerHTML = '<div class="saVendaAnimalResultItem saVendaAnimalResultEmpty">Nenhum animal encontrado</div>';
      resultsEl.hidden = false;
      return;
    }
    const nome = (a) => String(a.nome_completo || "").trim() || "—";
    resultsEl.innerHTML = matches
      .slice(0, 10)
      .map(
        (a) => {
          const brinco = escapeHtml(a.brinco_padrao || "—");
          const nomeStr = escapeHtml(nome(a));
          const sexoStr = escapeHtml(renderSex(a.sexo));
          const display = `${a.brinco_padrao || "—"} — ${nome(a)} — ${renderSex(a.sexo)}`;
          const valor = Number.isFinite(Number(a.valor_animal)) ? String(a.valor_animal) : "";
          const peso = Number.isFinite(Number(a.peso_atual_kg)) ? String(a.peso_atual_kg) : "";
          return `<button type="button" class="saVendaAnimalResultItem" role="option" data-id="${escapeHtml(a._id)}" data-brinco="${escapeHtml(a.brinco_padrao || "")}" data-display="${escapeHtml(display).replace(/"/g, "&quot;")}" data-valor="${escapeHtml(valor)}" data-peso="${escapeHtml(peso)}">${brinco} — ${nomeStr} — ${sexoStr}</button>`;
        }
      )
      .join("");
    resultsEl.hidden = false;
  }

  if (inputBrinco && resultsEl) {
    inputBrinco.addEventListener("input", () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => searchAnimaisByBrinco(inputBrinco.value), 200);
    });
    inputBrinco.addEventListener("focus", () => {
      if (inputBrinco.value.trim()) searchAnimaisByBrinco(inputBrinco.value);
    });
    resultsEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".saVendaAnimalResultItem[data-brinco]");
      if (btn) {
        inputBrinco.value = btn.dataset.display || btn.dataset.brinco || "";
        inputBrinco.setAttribute("data-selected-id", btn.dataset.id || "");
        resultsEl.hidden = true;
        resultsEl.innerHTML = "";

        const inputValor = container.querySelector("#vendaValor");
        const inputPeso = container.querySelector("#vendaPeso");
        const valorNum = parseFloat(btn.dataset.valor || "0") || 0;
        const pesoVal = btn.dataset.peso !== undefined && btn.dataset.peso !== "" ? String(btn.dataset.peso) : "";
        if (inputPeso) inputPeso.value = pesoVal;
        if (inputValor) {
          if (valorNum > 0) {
            const centsStr = Math.round(valorNum * 100).toString();
            inputValor.value = formatBrCurrencyFromDigits(centsStr);
            inputValor.dataset.raw = String(valorNum);
          } else {
            inputValor.value = "";
            inputValor.dataset.raw = "0";
          }
        }
      }
    });
    document.addEventListener("click", (ev) => {
      if (!resultsEl.hidden && !container.querySelector(".saVendaFieldAnimal")?.contains(ev.target)) {
        resultsEl.hidden = true;
      }
    });
  }

  // --- Proprietário de destino: busca por nome em colaboradores ---
  const FAZENDA_FORA_SISTEMA = "Fazenda Fora do Sistema";
  const inputProprietario = container.querySelector("#vendaProprietarioDestino");
  const resultsProprietario = container.querySelector("#vendaProprietarioDestinoResults");
  const wrapFazendaDestino = container.querySelector("#saVendaFazendaDestinoWrap");
  const selectFazendaDestino = container.querySelector("#vendaFazendaDestino");
  let selectedColaborador = null;
  let isFazendaForaSistemaDestino = false;
  let searchProprietarioDebounce = null;

  async function searchColaboradoresByName(query) {
    if (!resultsProprietario) return;
    const q = String(query || "").trim();
    if (!q) {
      resultsProprietario.setAttribute("hidden", "");
      resultsProprietario.style.display = "none";
      resultsProprietario.innerHTML = "";
      return;
    }
    try {
      const list = (await idbGet("colaboradores", "list")) || [];
      const lower = q.toLowerCase();
      const matches = list.filter((c) => {
        const nome = String(c.nome || "").toLowerCase();
        return nome.includes(lower);
      });
      if (matches.length === 0) {
        resultsProprietario.innerHTML = '<div class="saVendaAnimalResultItem saVendaAnimalResultEmpty">Nenhum proprietário encontrado</div>';
      } else {
        resultsProprietario.innerHTML = matches
          .slice(0, 10)
          .map(
            (c) => {
              const nome = escapeHtml(c.nome || "—");
              const tipo = escapeHtml(c.tipo || "");
              return `<button type="button" class="saVendaAnimalResultItem" role="option" data-id="${escapeHtml(c._id)}" data-nome="${escapeHtml(c.nome || "").replace(/"/g, "&quot;")}">${nome}${tipo ? ` <span class="saVendaResultSub">(${tipo})</span>` : ""}</button>`;
            }
          )
          .join("");
      }
      resultsProprietario.removeAttribute("hidden");
      resultsProprietario.style.display = "block";
    } catch (e) {
      console.error("[Venda] searchColaboradoresByName:", e);
      resultsProprietario.innerHTML = '<div class="saVendaAnimalResultItem saVendaAnimalResultEmpty">Erro ao buscar. Tente novamente.</div>';
      resultsProprietario.removeAttribute("hidden");
      resultsProprietario.style.display = "block";
    }
  }

  function hideFazendaDestinoWrap() {
    if (wrapFazendaDestino) {
      wrapFazendaDestino.setAttribute("hidden", "");
      wrapFazendaDestino.style.display = "none";
    }
    isFazendaForaSistemaDestino = false;
    if (selectFazendaDestino) {
      selectFazendaDestino.innerHTML = '<option value="">Selecione a fazenda de destino</option>';
      selectFazendaDestino.value = "";
    }
  }

  async function onColaboradorSelected(colaborador) {
    selectedColaborador = colaborador;
    if (!wrapFazendaDestino || !selectFazendaDestino) return;
    const fazendaIds = Array.isArray(colaborador?.fazendas) ? colaborador.fazendas.map((id) => String(id)) : [];
    if (fazendaIds.length === 0) {
      hideFazendaDestinoWrap();
      return;
    }
    const listFazendas = (await idbGet("fazenda", "list")) || [];
    const fazendasDoColaborador = listFazendas.filter((f) => fazendaIds.includes(String(f._id || "")));
    const temFazendaFora = fazendasDoColaborador.some((f) => String(f.name || "").trim() === FAZENDA_FORA_SISTEMA);
    isFazendaForaSistemaDestino = !!temFazendaFora;
    if (temFazendaFora) {
      hideFazendaDestinoWrap();
      return;
    }
    wrapFazendaDestino.removeAttribute("hidden");
    wrapFazendaDestino.style.display = "";
    selectFazendaDestino.innerHTML =
      '<option value="">Selecione a fazenda de destino</option>' +
      fazendasDoColaborador.map((f) => `<option value="${escapeHtml(f._id)}">${escapeHtml(f.name || "—")}</option>`).join("");
    selectFazendaDestino.value = "";
  }

  // Fazenda de destino: fica invisível até escolher um colaborador (e só aparece se ele não tiver "Fazenda Fora do Sistema")
  if (wrapFazendaDestino) {
    wrapFazendaDestino.setAttribute("hidden", "");
    wrapFazendaDestino.style.display = "none";
  }

  if (inputProprietario && resultsProprietario) {
    inputProprietario.addEventListener("input", () => {
      clearTimeout(searchProprietarioDebounce);
      selectedColaborador = null;
      hideFazendaDestinoWrap();
      searchProprietarioDebounce = setTimeout(() => searchColaboradoresByName(inputProprietario.value), 150);
    });
    inputProprietario.addEventListener("focus", () => {
      if (inputProprietario.value.trim()) searchColaboradoresByName(inputProprietario.value);
    });
    resultsProprietario.addEventListener("click", async (e) => {
      const btn = e.target.closest(".saVendaAnimalResultItem[data-id]");
      if (btn && !btn.classList.contains("saVendaAnimalResultEmpty")) {
        const id = btn.dataset.id;
        const nome = btn.dataset.nome || "";
        inputProprietario.value = nome;
        inputProprietario.setAttribute("data-selected-id", id || "");
        resultsProprietario.setAttribute("hidden", "");
        resultsProprietario.style.display = "none";
        resultsProprietario.innerHTML = "";
        const list = (await idbGet("colaboradores", "list")) || [];
        const col = list.find((c) => String(c._id) === String(id));
        if (col) onColaboradorSelected(col);
      }
    });
    document.addEventListener("click", (ev) => {
      if (!container.querySelector(".saVendaFieldProprietarioDestino")?.contains(ev.target)) {
        if (resultsProprietario && !resultsProprietario.hasAttribute("hidden")) {
          resultsProprietario.setAttribute("hidden", "");
          resultsProprietario.style.display = "none";
        }
      }
    });
  }

  // --- Campo Valor (R$): formatação em moeda BR com . (milhares) e , (decimais) em tempo real ---
  const inputValor = container.querySelector("#vendaValor");
  if (inputValor) {
    function parseBrCurrency(str) {
      const s = String(str || "").replace(/\./g, "").replace(",", ".");
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : 0;
    }
    inputValor.addEventListener("input", () => {
      const digits = inputValor.value.replace(/\D/g, "");
      const limited = digits.slice(0, 18);
      const formatted = formatBrCurrencyFromDigits(limited);
      const start = inputValor.selectionStart;
      const lenBefore = inputValor.value.length;
      inputValor.value = formatted;
      inputValor.dataset.raw = limited.length >= 2
        ? String(parseFloat(limited.slice(0, -2) + "." + limited.slice(-2)))
        : (limited.length === 1 ? "0.0" + limited : "0");
      const lenAfter = inputValor.value.length;
      const newPos = Math.max(0, start + (lenAfter - lenBefore));
      inputValor.setSelectionRange(newPos, newPos);
    });
    inputValor.addEventListener("blur", () => {
      const digits = inputValor.value.replace(/\D/g, "");
      const formatted = formatBrCurrencyFromDigits(digits);
      if (formatted) {
        inputValor.value = formatted;
        inputValor.dataset.raw = digits.length >= 2
          ? String(parseFloat(digits.slice(0, -2) + "." + digits.slice(-2)))
          : "0";
      } else {
        inputValor.value = "";
        inputValor.dataset.raw = "0";
      }
      enqueueValorUpdateIfAnimalSelected();
    });
    inputValor.addEventListener("focus", () => {
      const digits = inputValor.value.replace(/\D/g, "");
      if (digits.length > 0) inputValor.value = formatBrCurrencyFromDigits(digits);
    });

    /** Ao alterar o Valor com um animal selecionado: atualiza o animal no IDB e coloca na fila para sincronizar (update_animal). */
    async function enqueueValorUpdateIfAnimalSelected() {
      const inputBrinco = container.querySelector("#vendaAnimalBrinco");
      const animalId = inputBrinco?.getAttribute("data-selected-id")?.trim();
      if (!animalId) return;
      const rawVal = parseFloat(inputValor.dataset.raw || "0") || 0;
      const arr = (await idbGet("animais", "list")) || [];
      const idx = arr.findIndex((a) => String(a?._id) === String(animalId));
      if (idx === -1) return;
      const prev = arr[idx];
      const prevValor = Number(prev?.valor_animal) || 0;
      if (prevValor === rawVal) return;
      const updated = normalizeAnimal({
        ...prev,
        valor_animal: rawVal,
        _local: prev._local || true,
        _sync: "pending",
        data_modificacao: prev.data_modificacao,
      });
      arr[idx] = updated;
      await idbSet("animais", "list", arr);
      const qKey = `queue:${state.ctx.fazendaId || ""}:${state.ctx.ownerId || ""}:animal`;
      const queue = (await idbGet("records", qKey)) || [];
      const withoutValorUpdatesForThis = queue.filter(
        (item) => !(item.op === OFFLINE_OPS.ANIMAL_UPDATE && String(item.targetId) === String(animalId) && item.fromValorAnimal === true)
      );
      withoutValorUpdatesForThis.push({
        op: OFFLINE_OPS.ANIMAL_UPDATE,
        at: Date.now(),
        payload: updated,
        targetId: animalId,
        fromValorAnimal: true,
      });
      await idbSet("records", qKey, withoutValorUpdatesForThis);
      updateFabSyncVisibility();
    }
  }

  // --- Campo Peso: ao alterar, atualiza o animal local (animal_peso + peso_atual_kg) e enfileira só animal_create_peso.
  // Não enfileira animal_update: o backend já atualiza peso_atual_kg ao processar animal_create_peso. ---
  const inputPeso = container.querySelector("#vendaPeso");
  if (inputPeso) {
    inputPeso.addEventListener("blur", () => {
      enqueuePesoUpdateIfAnimalSelected();
    });
    async function enqueuePesoUpdateIfAnimalSelected() {
      const inputBrinco = container.querySelector("#vendaAnimalBrinco");
      const animalId = inputBrinco?.getAttribute("data-selected-id")?.trim();
      if (!animalId) return;
      const pesoVal = parseFloat(inputPeso.value) || 0;
      const arr = (await idbGet("animais", "list")) || [];
      const idx = arr.findIndex((a) => String(a?._id) === String(animalId));
      if (idx === -1) return;
      const prev = arr[idx];
      const prevPeso = Number(prev?.peso_atual_kg) || 0;
      if (prevPeso === pesoVal) return;
      const owner = (await idbGet("owner", "current")) || {};
      const userId = String(state.ctx.ownerId || owner._id || "").trim();
      const animalPeso = {
        animal: animalId,
        data_pesagem: new Date().toISOString(),
        peso_atual_kg: pesoVal,
        tipo_equipamento: "Manual",
        momento_pesagem: "Pesagem regular",
        user: userId,
      };
      // Atualiza animal local com animal_peso e peso_atual_kg (backend fará o mesmo ao processar animal_create_peso)
      const updated = normalizeAnimal({
        ...prev,
        animal_peso: animalPeso,
        peso_atual_kg: pesoVal,
        _local: prev._local || true,
        _sync: "pending",
        data_modificacao: prev.data_modificacao,
      });
      arr[idx] = updated;
      await idbSet("animais", "list", arr);
      const qKey = `queue:${state.ctx.fazendaId || ""}:${state.ctx.ownerId || ""}:animal`;
      const queue = (await idbGet("records", qKey)) || [];
      const withoutPesoCreatesForThis = queue.filter(
        (item) => !(item.op === "animal_create_peso" && String(item.payload?.animal) === String(animalId))
      );
      withoutPesoCreatesForThis.push({
        _id: `local:${uuid()}`,
        op: "animal_create_peso",
        at: Date.now(),
        payload: animalPeso,
      });
      await idbSet("records", qKey, withoutPesoCreatesForThis);
      updateFabSyncVisibility();
    }
  }
}

// ---------------- SW ----------------
async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try { await navigator.serviceWorker.register("./sw.js"); } catch { }
}

// ---------------- init ----------------
// ========================================================
// DASHBOARD LOGIC
// ========================================================

/** Retorna lista de itens pendentes de sincronização, na ordem da fila (para exibir no dashboard). */
async function getPendingSyncList() {
  const keys = await idbGetAllKeys("records");
  const queueKeys = (keys || []).filter(k => String(k).startsWith("queue:")).sort();
  const animaisList = (await idbGet("animais", "list")) || [];
  const items = [];
  let globalIndex = 0;
  const currentFazendaId = getCurrentFazendaId();
  for (const qKey of queueKeys) {
    const queue = await idbGet("records", qKey);
    if (!Array.isArray(queue) || queue.length === 0) continue;
    const parts = qKey.split(":");
    const fazendaId = parts[1] || "";
    const isTransfer = String(fazendaId) !== String(currentFazendaId);
    for (let i = 0; i < queue.length; i++) {
      const op = queue[i];
      const opType = op?.op || OFFLINE_OPS.ANIMAL_UPDATE;
      let label = opType === OFFLINE_OPS.ANIMAL_CREATE ? "Novo animal" : "Atualização de animal";
      if (opType === "animal_update" && isTransfer) label = "Transferência entre fazendas";
      if (opType === OFFLINE_OPS.ANIMAL_CREATE_PESO) label = "Pesagem";
      if (SAIDA_OFFLINE_OP_SET.has(opType)) label = "Saída de animais";
      const payload = op?.payload || {};
      let oldAnimal = null;
      if ((opType === OFFLINE_OPS.ANIMAL_UPDATE && (op.targetId || payload._id)) || (opType === OFFLINE_OPS.ANIMAL_CREATE_PESO && payload.animal)) {
        const animalId = op.targetId || payload._id || payload.animal;
        oldAnimal = animaisList.find(a => String(a?._id) === String(animalId));
      }
      if (SAIDA_OFFLINE_OP_SET.has(opType) && Array.isArray(payload.animais) && payload.animais.length > 0) {
        const aid = payload.animais[0];
        oldAnimal = animaisList.find(a => String(a?._id) === String(aid));
      }
      if (opType === OFFLINE_OPS.ANIMAL_CREATE && payload._id) {
        oldAnimal = payload;
      }
      const animalId = opType === OFFLINE_OPS.ANIMAL_CREATE ? (payload._id || "") : (op.targetId || payload._id || payload.animal || (Array.isArray(payload.animais) && payload.animais[0]) || "");
      const nome = String(payload.nome_completo || (oldAnimal && oldAnimal.nome_completo) || "").trim();
      const brinco = String(payload.brinco_padrao || payload.brinco || (oldAnimal && (oldAnimal.brinco_padrao || oldAnimal.brinco)) || "").trim();
      let detail = label + (nome || brinco ? " · " + (nome || brinco) : "");
      if (opType === OFFLINE_OPS.ANIMAL_CREATE_PESO && payload.peso_atual_kg != null) detail = (detail !== "—" ? detail + " · " : "") + payload.peso_atual_kg + " kg";
      if (SAIDA_OFFLINE_OP_SET.has(opType)) detail = (detail !== "—" ? detail + " · " : "") + (payload.animais?.length || 1) + " animal(is)";
      items.push({
        queueOrder: globalIndex++,
        queueKey: qKey,
        queueIndex: i,
        op: opType,
        label,
        detail,
        animalId: String(animalId || "").trim(),
        animalLabel: brinco ? (nome ? `Brinco ${brinco} — ${nome}` : `Brinco ${brinco}`) : (nome || animalId || "—")
      });
    }
  }
  return items;
}

const PENDING_SYNC_PAGE_SIZE = 10;

/** Agrupa itens por label (tipo), preservando ordem da primeira aparição. */
function groupPendingSyncByLabel(list) {
  const byLabel = {};
  const order = [];
  for (const item of list) {
    if (!byLabel[item.label]) {
      byLabel[item.label] = [];
      order.push(item.label);
    }
    byLabel[item.label].push(item);
  }
  return order.map(label => ({ label, items: byLabel[label] }));
}

/** Agrupa itens por animal (linha de produção): uma linha por animal, ao clicar mostra a fila daquele animal. */
function groupPendingSyncByAnimal(list) {
  const byAnimal = {};
  const order = [];
  for (const item of list) {
    const id = item.animalId || "__outros__";
    const displayLabel = item.animalLabel || "Outros";
    if (!byAnimal[id]) {
      byAnimal[id] = { label: displayLabel, animalId: id, items: [] };
      order.push(id);
    }
    byAnimal[id].items.push(item);
    if (id !== "__outros__" && (item.animalLabel || "").trim()) byAnimal[id].label = item.animalLabel;
  }
  return order.map(id => ({ label: byAnimal[id].label, animalId: byAnimal[id].animalId, items: byAnimal[id].items }));
}

/** Cria ou retorna o modal de detalhes do grupo de pendências. */
function getPendingSyncModal() {
  let el = document.getElementById("dashPendingSyncModal");
  if (!el) {
    el = document.createElement("div");
    el.id = "dashPendingSyncModal";
    el.className = "dashPendingSyncModalOverlay";
    el.style.cssText = "display:none;";
    el.innerHTML = `
      <div class="dashPendingSyncModalCard">
        <div class="dashPendingSyncModalHeader">
          <span class="dashPendingSyncModalIcon" aria-hidden="true">📋</span>
          <h3 id="dashPendingSyncModalTitle" class="dashPendingSyncModalTitle"></h3>
          <button type="button" id="dashPendingSyncModalClose" class="dashPendingSyncModalClose" aria-label="Fechar">×</button>
        </div>
        <div id="dashPendingSyncModalBody" class="dashPendingSyncModalBody"></div>
      </div>`;
    el.addEventListener("click", (e) => { if (e.target === el) openPendingSyncModal(null); });
    const closeBtn = el.querySelector("#dashPendingSyncModalClose");
    if (closeBtn) closeBtn.addEventListener("click", () => openPendingSyncModal(null));
    document.body.appendChild(el);
  }
  return el;
}

function openPendingSyncModal(group) {
  const overlay = getPendingSyncModal();
  if (!group) {
    overlay.style.display = "none";
    return;
  }
  const title = document.getElementById("dashPendingSyncModalTitle");
  const body = document.getElementById("dashPendingSyncModalBody");
  if (title) title.textContent = group.label ? `${group.label} — Fila de sincronizações` : `Fila (${group.items.length})`;
  if (body) {
    body.innerHTML = group.items.map((item, i) =>
      `<div class="dashPendingSyncModalItem"><span class="dashPendingSyncModalItemNum">${i + 1}</span><span class="dashPendingSyncModalItemText">${escapeHtml(item.detail)}</span></div>`
    ).join("");
  }
  overlay.style.display = "flex";
}

/** Renderiza o card de pendências agrupado por animal (linha de produção). Ao clicar, abre modal com a fila daquele animal. */
function setPendingSyncCardVisible(visible) {
  const wrapMobile = document.getElementById("dashPendingSyncWrap");
  const wrapDesktop = document.getElementById("dashPendingSyncWrapDesktop");
  const display = visible ? "block" : "none";
  if (wrapMobile) wrapMobile.style.display = display;
  if (wrapDesktop) wrapDesktop.style.display = display;
}

function renderPendingSyncCard() {
  const list = state.pendingSyncListForCard || [];
  const groups = groupPendingSyncByAnimal(list);
  state.pendingSyncGroupsForCard = groups;

  const page = Math.max(0, state.pendingSyncPage || 0);
  const totalPages = Math.max(1, Math.ceil(groups.length / PENDING_SYNC_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  state.pendingSyncPage = currentPage;
  const start = currentPage * PENDING_SYNC_PAGE_SIZE;
  const pageGroups = groups.slice(start, start + PENDING_SYNC_PAGE_SIZE);

  const wrapMobile = document.getElementById("dashPendingSyncWrap");
  const listMobile = document.getElementById("dashPendingSyncList");
  const wrapDesktop = document.getElementById("dashPendingSyncWrapDesktop");
  const listDesktop = document.getElementById("dashPendingSyncListDesktop");
  const paginationMobile = document.getElementById("dashPendingSyncPagination");
  const paginationDesktop = document.getElementById("dashPendingSyncPaginationDesktop");

  const buildGroupRowHtml = (group, groupIndex, displayIndex) =>
    `<div class="dashPendingSyncItem dashPendingSyncGroupRow" data-group-index="${groupIndex}" role="button" tabindex="0"><span class="dashPendingSyncOrder">${displayIndex}</span><span class="dashPendingSyncLabel">${escapeHtml(group.label)}</span><span class="dashPendingSyncDetail">Fila de sincronizações · ${group.items.length} item(ns)</span></div>`;

  const listHtml = pageGroups.map((g, i) => buildGroupRowHtml(g, start + i, start + i + 1)).join("");

  const paginationHtml = totalPages <= 1 ? "" : `
    <div class="dashPendingSyncPagination">
      <button type="button" class="dashPendingSyncPageBtn" data-dir="prev" ${currentPage === 0 ? "disabled" : ""}>Anterior</button>
      <span class="dashPendingSyncPageInfo">Página ${currentPage + 1} de ${totalPages}</span>
      <button type="button" class="dashPendingSyncPageBtn" data-dir="next" ${currentPage >= totalPages - 1 ? "disabled" : ""}>Próxima</button>
    </div>`;

  if (listMobile) listMobile.innerHTML = listHtml;
  if (listDesktop) listDesktop.innerHTML = listHtml;
  if (paginationMobile) paginationMobile.innerHTML = paginationHtml;
  if (paginationDesktop) paginationDesktop.innerHTML = paginationHtml;

  const handleGroupRowClick = (e) => {
    const row = e.target.closest(".dashPendingSyncGroupRow");
    if (!row) return;
    const idx = parseInt(row.getAttribute("data-group-index"), 10);
    if (Number.isNaN(idx)) return;
    const groups = state.pendingSyncGroupsForCard || [];
    if (groups[idx]) openPendingSyncModal(groups[idx]);
  };
  if (wrapMobile) {
    wrapMobile.onclick = handleGroupRowClick;
  }
  if (wrapDesktop) {
    wrapDesktop.onclick = handleGroupRowClick;
  }

  [paginationMobile, paginationDesktop].forEach(container => {
    if (!container) return;
    container.querySelectorAll(".dashPendingSyncPageBtn").forEach(btn => {
      btn.onclick = () => {
        const dir = btn.getAttribute("data-dir");
        if (dir === "prev") state.pendingSyncPage = Math.max(0, (state.pendingSyncPage || 0) - 1);
        else if (dir === "next") state.pendingSyncPage = Math.min(totalPages - 1, (state.pendingSyncPage || 0) + 1);
        renderPendingSyncCard();
      };
    });
  });
}

async function renderDashboard() {
  // 1. Owner Info
  // Try to get from 'owner' store first (synced session)
  const sessionOwner = await idbGet("owner", "current");
  let owner = sessionOwner;

  if (!owner) {
    // Fallback: colaborador_principal da fazenda atual na tabela de colaboradores
    const fazenda = await idbGet("fazenda", "current");
    const colaboradores = (await idbGet("colaboradores", "list")) || [];
    const principalId = fazenda?.colaborador_principal || state.ctx.ownerId;
    if (principalId) {
      owner = colaboradores.find(c => String(c._id) === String(principalId)) || owner;
    }
  }

  const name = owner?.nome || "Usuário";
  const firstLetter = name.charAt(0).toUpperCase();

  // Atualiza bloco do usuário no topo direito do dashboard (desktop e mobile)
  renderSidebarUser();

  // Módulos (carrossel mobile)
  const modContainer = $("#dashModules");
  if (modContainer) {
    modContainer.innerHTML = "";
    state.modules.forEach(mod => {
      const mDef = MODULE_CATALOG[mod.key] || { key: mod.key, label: mod.label || prettifyKey(mod.key), icon: "📦" };
      const div = document.createElement("div");
      div.className = "dashModCard";
      div.onclick = () => openModule(mod.key);
      div.innerHTML = `<div class="dashModIcon">${mDef.icon}</div><div class="dashModTitle">${escapeHtml(mDef.label)}</div>`;
      modContainer.appendChild(div);
    });
  }

  // Card: lista de dados pendentes de sincronização (mobile + desktop), máx 10 itens com paginação
  const pendingList = await getPendingSyncList();
  state.pendingSyncListForCard = pendingList;
  if (pendingList.length > 0 && (state.pendingSyncPage === undefined || state.pendingSyncPage < 0)) {
    state.pendingSyncPage = 0;
  }
  const wrapMobile = document.getElementById("dashPendingSyncWrap");
  const wrapDesktop = document.getElementById("dashPendingSyncWrapDesktop");
  const isDashboardRoot = state.view === "dashboard" && !state.pipelineAnimal;
  const showPendingCard = pendingList.length > 0 && isDashboardRoot && navigator.onLine;
  if (showPendingCard) {
    setPendingSyncCardVisible(true);
    renderPendingSyncCard();
  } else {
    state.pendingSyncPage = 0;
    setPendingSyncCardVisible(false);
    if (wrapMobile) { document.getElementById("dashPendingSyncList") && (document.getElementById("dashPendingSyncList").innerHTML = ""); }
    if (wrapDesktop) { document.getElementById("dashPendingSyncListDesktop") && (document.getElementById("dashPendingSyncListDesktop").innerHTML = ""); }
    const paginationMobile = document.getElementById("dashPendingSyncPagination");
    const paginationDesktop = document.getElementById("dashPendingSyncPaginationDesktop");
    if (paginationMobile) paginationMobile.innerHTML = "";
    if (paginationDesktop) paginationDesktop.innerHTML = "";
  }

  // Charts Stats (apenas fazenda atual / management_fazenda)
  const animaisRaw = (await idbGet("animais", "list")) || [];
  const animais = filterByCurrentFazenda(animaisRaw);
  const activeAnimais = animais.filter(a => !a.deleted);
  const total = activeAnimais.length;

  // --- CHART 1: SEXO (Donut) ---
  const machos = activeAnimais.filter(a => a.sexo === "M").length;
  const femeas = activeAnimais.filter(a => a.sexo === "F").length;

  // Update Text (centro + legenda)
  const elTotalSex = $("#chartTotalSex");
  if (elTotalSex) elTotalSex.innerHTML = `${total}<br><span style="font-size:10px;font-weight:400;color:#6b7280">Total</span>`;

  const lblM = $("#lblM"); if (lblM) lblM.textContent = machos;
  const lblF = $("#lblF"); if (lblF) lblF.textContent = femeas;

  // Chart.js doughnut (visual igual ao teste.html / print: centro, cores, bordas, legenda)
  if (typeof Chart !== "undefined") {
    const canvasMobile = document.getElementById("chartSexCanvas");
    if (canvasMobile) {
      if (state.chartSex) {
        state.chartSex.destroy();
        state.chartSex = null;
      }
      const centerDivMobile = canvasMobile.closest(".donutChartWrap")?.querySelector(".donutCenter");
      if (centerDivMobile) centerDivMobile.style.display = "none";
      // Mobile: legenda lateral (HTML chartLegendSex) — não esconder; Chart.js legend fica desligada
      state.chartSex = new Chart(canvasMobile, {
        type: "doughnut",
        data: {
          labels: ["Macho", "Fêmea"],
          datasets: [{
            data: [machos, femeas],
            backgroundColor: ["#2196f3", "#e91e63"],
            borderWidth: 0,
            borderRadius: 12,
            spacing: 8,
            hoverOffset: 2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "68%",
          plugins: {
            legend: { display: false },
            centerText: { valueFontSize: 18, labelFontSize: 10 }
          }
        },
        plugins: [chartCenterTextPlugin]
      });
    }
  }

  // --- CHART 2: CATEGORIA (Count) ---
  const catMap = {};
  activeAnimais.forEach(a => {
    const c = a.categoria || "Sem Categoria";
    catMap[c] = (catMap[c] || 0) + 1;
  });
  const catList = Object.entries(catMap)
    .map(([cat, count]) => ({ cat, count }))
    .sort((a, b) => b.count - a.count);

  const elListCat = $("#chartListCat");
  if (elListCat) {
    if (catList.length === 0) {
      elListCat.innerHTML = `<div style="text-align:center; color:#9ca3af; padding:20px;">Nenhum dado</div>`;
    } else {
      elListCat.innerHTML = "";
      const maxVal = catList[0].count;
      catList.slice(0, 5).forEach(item => {
        const visualPct = (item.count / maxVal) * 100;
        const row = document.createElement("div");
        row.innerHTML = `
                <div class="statRow">
                    <span class="statLabel">${item.cat}</span>
                    <span class="statVal">${item.count}</span>
                </div>
                <div class="statBarBg">
                    <div class="statBarFill" style="width: ${visualPct}%"></div>
                </div>
              `;
        elListCat.appendChild(row);
      });
    }
  }

  // --- CHART 3: PESO MÉDIO POR LOTE (KG) ---
  // Calculado a partir dos animais: para cada lote, média do peso_atual_kg dos animais que pertencem ao lote (list_lotes ou lote)
  const lotesListRaw = (await idbGet("lotes", "list")) || [];
  const lotesList = filterByCurrentFazenda(lotesListRaw);
  const toLoteIdFromAnimal = (id) => (id && typeof id === "object" && id._id != null) ? String(id._id) : String(id || "");

  const loteAggAll = lotesList
    .map(l => {
      const loteId = String(l._id || "");
      const noLote = activeAnimais.filter(a => {
        const norm = normalizeAnimal(a);
        const inList = norm.list_lotes && norm.list_lotes.some(lid => String(lid) === loteId);
        const animalLoteId = toLoteIdFromAnimal(a?.lote);
        return inList || animalLoteId === loteId;
      });
      const totalPeso = noLote.reduce((s, a) => s + toNumberOrZero(a.peso_atual_kg), 0);
      const avg = noLote.length > 0 ? totalPeso / noLote.length : 0;
      return { name: l.nome_lote || "Sem Nome", avg };
    })
    .sort((a, b) => b.avg - a.avg);

  // --- CHART: Peso médio por lote (KG) — barra vertical, estilo do print ---
  const wrapPesoLote = $("#chartListLote")?.querySelector(".chartPesoLoteWrap");
  const emptyPesoLote = $("#chartListLoteEmpty");
  if (wrapPesoLote && emptyPesoLote) {
    if (loteAggAll.length === 0) {
      wrapPesoLote.style.display = "none";
      emptyPesoLote.style.display = "block";
    } else {
      wrapPesoLote.style.display = "block";
      emptyPesoLote.style.display = "none";
      if (typeof Chart !== "undefined") {
        const canvasPeso = document.getElementById("chartPesoLoteCanvas");
        if (canvasPeso) {
          if (state.chartPesoLote) {
            state.chartPesoLote.destroy();
            state.chartPesoLote = null;
          }
          state.chartPesoLote = new Chart(canvasPeso, {
            type: "bar",
            data: {
              labels: loteAggAll.map(i => i.name),
              datasets: [{
                label: "Peso médio por lote (KG)",
                data: loteAggAll.map(i => i.avg),
                backgroundColor: "#4b5563",
                borderColor: "#4b5563",
                borderWidth: 0,
                borderRadius: { topLeft: 6, topRight: 6 },
                borderSkipped: false
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              indexAxis: "x",
              scales: {
                y: {
                  beginAtZero: true,
                  grid: { color: "rgba(0,0,0,0.06)" },
                  ticks: {
                    callback(value) {
                      return Number(value).toLocaleString("pt-BR");
                    }
                  }
                },
                x: {
                  grid: { display: false },
                  ticks: { maxRotation: 45, minRotation: 45 }
                }
              },
              plugins: {
                legend: {
                  display: true,
                  position: "bottom",
                  labels: {
                    usePointStyle: true,
                    pointStyle: "circle",
                    boxWidth: 8,
                    boxHeight: 8,
                    color: "#374151",
                    font: { size: 12, weight: "500" }
                  }
                }
              }
            }
          });
        }
      }
    }
  }

  // --- Desktop Dashboard: preencher mesmos dados ---
  const dashDate = $("#dashDesktopDate");
  if (dashDate) {
    const d = new Date();
    const opts = { day: "numeric", month: "long", year: "numeric" };
    dashDate.textContent = d.toLocaleDateString("pt-BR", opts);
  }
  const dashNameDesktop = $("#dashNameDesktop");
  if (dashNameDesktop) dashNameDesktop.textContent = name;
  const cardTotal = $("#dashDesktopCardTotal"); if (cardTotal) cardTotal.textContent = total;
  const totalLotes = Array.isArray(lotesList) ? lotesList.length : 0;
  const cardLotes = $("#dashDesktopCardLotes"); if (cardLotes) cardLotes.textContent = totalLotes;

  const elTotalSexD = $("#chartTotalSexDesktop");
  if (elTotalSexD) elTotalSexD.innerHTML = `${total}<br><span style="font-size:10px;font-weight:400;color:#6b7280">Total</span>`;
  const lblMD = $("#lblMDesktop"); if (lblMD) lblMD.textContent = machos;
  const lblFD = $("#lblFDesktop"); if (lblFD) lblFD.textContent = femeas;

  if (typeof Chart !== "undefined") {
    const canvasDesktop = document.getElementById("chartSexCanvasDesktop");
    if (canvasDesktop) {
      if (state.chartSexDesktop) {
        state.chartSexDesktop.destroy();
        state.chartSexDesktop = null;
      }
      const centerDivDesktop = canvasDesktop.closest(".donutChartWrap")?.querySelector(".donutCenter");
      if (centerDivDesktop) centerDivDesktop.style.display = "none";
      const legendWrapDesktop = $("#chartLegendSexDesktop");
      if (legendWrapDesktop) legendWrapDesktop.style.display = "none";
      state.chartSexDesktop = new Chart(canvasDesktop, {
        type: "doughnut",
        data: {
          labels: ["Macho", "Fêmea"],
          datasets: [{
            data: [machos, femeas],
            backgroundColor: ["#2196f3", "#e91e63"],
            borderWidth: 0,
            borderRadius: 12,
            spacing: 8,
            hoverOffset: 2
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: "68%",
          plugins: {
            legend: {
              position: "bottom",
              labels: {
                usePointStyle: true,
                pointStyle: "circle",
                boxWidth: 8,
                boxHeight: 8,
                padding: 12,
                color: "#374151",
                font: { size: 12, weight: "500" },
                generateLabels: (chart) => {
                  const ds = chart.data.datasets[0];
                  return (chart.data.labels || []).map((label, i) => ({
                    text: `${label} ${ds.data[i] ?? 0}`,
                    fillStyle: ds.backgroundColor[i],
                    index: i
                  }));
                }
              }
            }
          }
        },
        plugins: [chartCenterTextPlugin]
      });
    }
  }

  const elListCatD = $("#chartListCatDesktop");
  if (elListCatD) {
    if (catList.length === 0) {
      elListCatD.innerHTML = `<div style="text-align:center; color:#9ca3af; padding:20px;">Nenhum dado</div>`;
    } else {
      elListCatD.innerHTML = "";
      const maxVal = catList[0].count;
      catList.slice(0, 5).forEach(item => {
        const visualPct = (item.count / maxVal) * 100;
        const row = document.createElement("div");
        row.innerHTML = `<div class="statRow"><span class="statLabel">${item.cat}</span><span class="statVal">${item.count}</span></div><div class="statBarBg"><div class="statBarFill" style="width: ${visualPct}%"></div></div>`;
        elListCatD.appendChild(row);
      });
    }
  }

  const wrapPesoLoteD = $("#chartListLoteDesktop")?.querySelector(".chartPesoLoteWrap");
  const emptyPesoLoteD = $("#chartListLoteDesktopEmpty");
  if (wrapPesoLoteD && emptyPesoLoteD) {
    if (loteAggAll.length === 0) {
      wrapPesoLoteD.style.display = "none";
      emptyPesoLoteD.style.display = "block";
    } else {
      wrapPesoLoteD.style.display = "block";
      emptyPesoLoteD.style.display = "none";
      if (typeof Chart !== "undefined") {
        const canvasPesoD = document.getElementById("chartPesoLoteCanvasDesktop");
        if (canvasPesoD) {
          if (state.chartPesoLoteDesktop) {
            state.chartPesoLoteDesktop.destroy();
            state.chartPesoLoteDesktop = null;
          }
          state.chartPesoLoteDesktop = new Chart(canvasPesoD, {
            type: "bar",
            data: {
              labels: loteAggAll.map(i => i.name),
              datasets: [{
                label: "Peso médio por lote (KG)",
                data: loteAggAll.map(i => i.avg),
                backgroundColor: "#4b5563",
                borderColor: "#4b5563",
                borderWidth: 0,
                borderRadius: { topLeft: 6, topRight: 6 },
                borderSkipped: false
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              indexAxis: "x",
              scales: {
                y: {
                  beginAtZero: true,
                  grid: { color: "rgba(0,0,0,0.06)" },
                  ticks: {
                    callback(value) {
                      return Number(value).toLocaleString("pt-BR");
                    }
                  }
                },
                x: {
                  grid: { display: false },
                  ticks: { maxRotation: 45, minRotation: 45 }
                }
              },
              plugins: {
                legend: {
                  display: true,
                  position: "bottom",
                  labels: {
                    usePointStyle: true,
                    pointStyle: "circle",
                    boxWidth: 8,
                    boxHeight: 8,
                    color: "#374151",
                    font: { size: 12, weight: "500" }
                  }
                }
              }
            }
          });
        }
      }
    }
  }
}

async function openDashboard() {
  state.view = "dashboard";
  state.activeKey = null;
  state.animalView = "list";
  state.animalEditingId = null;

  // Hide all sections
  document.querySelectorAll(".moduleSection").forEach(el => el.hidden = true);

  // Explicitly hide and clear generic module view to prevent overlap/stale content
  const modView = document.getElementById("moduleView");
  if (modView) {
    modView.hidden = true;
    modView.innerHTML = ""; // Reset content
  }

  // Esconde containers de módulos de animais e garante form de animal de volta ao container (se estava no pipeline)
  moveAnimalFormBackToContainer();
  const animalContainer = $("#animalModuleContainer");
  if (animalContainer) animalContainer.hidden = true;
  const secList = $("#modAnimaisList");
  if (secList) secList.hidden = true;
  const secForm = $("#modAnimaisForm");
  if (secForm) secForm.hidden = true;

  // Show Dashboard (mobile e desktop; a visibilidade por viewport é feita via CSS)
  const dash = $("#modDashboard");
  if (dash) dash.hidden = false;
  const dashDesktop = document.getElementById("modDashboardDesktop");
  if (dashDesktop) dashDesktop.hidden = false;

  // Render Data
  await renderDashboard();

  // Modal da linha de produção (no dashboard): liga eventos e mostra modal ou passo atual
  ensurePipelineModalReady();

  renderSidebar();
  updateFabSyncVisibility();
  await saveNavigationState();
}

async function openModule() {
  await openDashboard();
}

// Controla visibilidade do FAB Sync (apenas na tela inicial do dashboard, não nos passos do pipeline)
function updateFabSyncVisibility() {
  const btn = document.getElementById("fabSync");
  if (!btn) return;
  const isDashboardRoot = state.view === "dashboard" && !state.pipelineAnimal;
  const canShowFab = isDashboardRoot;

  if (!canShowFab) {
    btn.hidden = true;
    btn.style.display = "none";
    btn.style.visibility = "hidden";
    return;
  }

  checkSyncStatus();
}

async function checkSyncStatus() {
  const btn = document.getElementById("fabSync");
  if (!btn) return;
  const isDashboardRoot = state.view === "dashboard" && !state.pipelineAnimal;
  const canShowFab = isDashboardRoot;

  if (!canShowFab) {
    btn.hidden = true;
    btn.style.display = "none";
    btn.style.visibility = "hidden";
    btn.style.opacity = "0";
    btn.style.pointerEvents = "none";
    setRefazerSyncButtonVisible(false);
    return;
  }

  if (!navigator.onLine) {
    btn.hidden = true;
    btn.style.display = "none";
    setRefazerSyncButtonVisible(false);
    return;
  }

  // Check if there are pending records (todas as filas: fazenda atual e transferências entre fazendas)
  try {
    const keys = await idbGetAllKeys("records");
    const queueKeys = (keys || []).filter(k => String(k).startsWith("queue:"));

    let hasPending = false;
    for (const k of queueKeys) {
      const q = await idbGet("records", k);
      if (Array.isArray(q) && q.length > 0) {
        hasPending = true;
        break;
      }
    }

    // Mostra FAB se tiver pendências (em qualquer fila)
    if (hasPending) {
      btn.hidden = false;
      btn.style.display = "flex";
      btn.style.visibility = "visible";
      btn.style.opacity = "1";
      btn.style.pointerEvents = "auto";
      playSyncAvailableSound();
      setRefazerSyncButtonVisible(false);
    } else {
      resetSyncNotifySound();
      btn.hidden = true;
      btn.style.display = "none";
      btn.style.visibility = "hidden";
      btn.style.opacity = "0";
      btn.style.pointerEvents = "none";
      setRefazerSyncButtonVisible(true);
    }
  } catch (e) {
    console.error("[checkSyncStatus] Error:", e);
    btn.hidden = true;
    btn.style.display = "none";
    setRefazerSyncButtonVisible(false);
  }
}

function setRefazerSyncButtonVisible(visible) {
  const btns = [
    document.getElementById("btnRefazerSyncInicial"),
    document.getElementById("btnRefazerSyncInicialMobile")
  ].filter(Boolean);
  btns.forEach((b) => {
    b.hidden = !visible;
    b.style.display = visible ? "" : "none";
  });
}

/**
 * Refaz a sincronização inicial (get_dados): atualiza dados do servidor.
 * Só deve ser chamado quando online e sem pendências. Usa o id salvo da URL (?id=) se existir.
 */
async function refazerSincronizacaoInicial() {
  if (!navigator.onLine) {
    toast("Você está offline. Conecte-se para atualizar os dados.");
    return;
  }
  const btns = [
    document.getElementById("btnRefazerSyncInicial"),
    document.getElementById("btnRefazerSyncInicialMobile")
  ].filter(Boolean);
  btns.forEach((b) => { b.disabled = true; });

  try {
    const bootstrapId = await idbGet("meta", "bootstrap_id");
    if (bootstrapId && String(bootstrapId).trim()) {
      const modulosUrl = API_CONFIG.getModulosUrl(String(bootstrapId).trim());
      const res = await fetch(modulosUrl);
      if (!res.ok) throw new Error(`get_modulos HTTP ${res.status}`);
      const data = await res.json();
      const fazendaId = String(data?.fazenda || "").trim();
      const colaborador = data?.colaborador;
      const ownerId = typeof colaborador === "object" && colaborador !== null
        ? String(colaborador._id || "").trim()
        : String(colaborador || "").trim();
      let rawModules = [];
      if (Array.isArray(data?.modules)) rawModules = data.modules;
      else if (data?.modules && typeof data.modules === "object") rawModules = [data.modules];
      const moduleConfigs = rawModules.map((m) => {
        if (typeof m === "string") return { modulo: m };
        if (m && typeof m === "object") return { ...m, abas: Array.isArray(m.abas) ? m.abas.map((a) => ({ ...a })) : [] };
        return null;
      }).filter(Boolean);
      ensureAbasCampos(moduleConfigs);
      const moduleKeys = moduleConfigs.length > 0
        ? moduleConfigs.map((m) => String(m.modulo || m.key || "").trim()).filter(Boolean)
        : ["animal"];
      state.ctx = { fazendaId, ownerId };
      state.modules = buildModules(moduleKeys);
      state.moduleConfigs = moduleConfigs;
      await idbSet("meta", "session_config", {
        modules: moduleKeys,
        moduleConfigs,
        ctx: { fazendaId, ownerId },
        bootstrap_id: bootstrapId,
        updatedAt: Date.now()
      });
      await idbSet("meta", "lastCtx", { fazendaId, ownerId, cachedAt: Date.now() });
    }

    showBoot("Sincronizando dados…", "Buscando dados do servidor e preparando modo offline.");
    await bootstrapData();
    state.bootstrapReady = true;
    hideBoot();
    renderSidebar();
    updateFabSyncVisibility();
    toast("Dados atualizados com sucesso.");
  } catch (e) {
    console.error("[refazerSincronizacaoInicial]", e);
    hideBoot();
    toast(e?.message || "Erro ao atualizar dados. Tente novamente.");
  } finally {
    btns.forEach((b) => { b.disabled = false; });
    updateFabSyncVisibility();
  }
}

// URLs e configurações agora vêm de config.js

/** Toca um beep curto quando há sincronização pendente (apenas uma vez até a fila esvaziar ou o usuário sincronizar). */
function playSyncAvailableSound() {
  if (window.__syncNotifySoundPlayed) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.15);
    window.__syncNotifySoundPlayed = true;
  } catch (_) {}
}

/** Reseta o flag do som para tocar de novo na próxima vez que houver pendência. */
function resetSyncNotifySound() {
  window.__syncNotifySoundPlayed = false;
}

/** Overlay de progresso da sincronização (0–100%). Criado dinamicamente para desktop e mobile. */
function getSyncProgressOverlay() {
  let el = document.getElementById("syncProgressOverlay");
  if (!el) {
    el = document.createElement("div");
    el.id = "syncProgressOverlay";
    el.style.cssText = "position:fixed;inset:0;z-index:999999;background:rgba(248,248,248,.92);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;";
    el.innerHTML = `
      <div class="syncProgressCard" style="background:#fff;border-radius:20px;box-shadow:0 20px 60px rgba(17,24,39,.16);padding:24px;min-width:280px;max-width:90%;text-align:center;">
        <div style="font-weight:800;font-size:14px;margin-bottom:8px;color:#111827;">Sincronizando</div>
        <div id="syncProgressLabel" style="font-size:12px;color:#6b7280;margin-bottom:16px;">Enviando dados...</div>
        <div style="height:12px;border-radius:999px;background:rgba(17,24,39,.08);overflow:hidden;">
          <div id="syncProgressBar" style="height:100%;width:0%;border-radius:999px;background:#edff77;transition:width .3s ease;"></div>
        </div>
        <div id="syncProgressPct" style="font-weight:800;font-size:14px;margin-top:8px;color:#111827;">0%</div>
      </div>`;
    document.body.appendChild(el);
  }
  return el;
}

function showSyncProgress(percent, label = "Enviando dados...") {
  const el = getSyncProgressOverlay();
  el.style.display = "flex";
  const bar = document.getElementById("syncProgressBar");
  const pct = document.getElementById("syncProgressPct");
  const lbl = document.getElementById("syncProgressLabel");
  if (bar) {
    bar.classList.remove("syncProgressBarIndeterminate");
    bar.style.width = Math.min(100, Math.max(0, percent)) + "%";
    bar.style.transform = "";
  }
  if (pct) pct.textContent = Math.round(percent) + "%";
  if (lbl) lbl.textContent = label;
}

/** Exibe o overlay de progresso em modo indeterminado (barra animada), ex.: durante polling "Sincronização em andamento". */
function showSyncProgressIndeterminate(label = "Aguardando conclusão no servidor...") {
  const el = getSyncProgressOverlay();
  el.style.display = "flex";
  const bar = document.getElementById("syncProgressBar");
  const pct = document.getElementById("syncProgressPct");
  const lbl = document.getElementById("syncProgressLabel");
  if (bar) {
    bar.classList.add("syncProgressBarIndeterminate");
    bar.style.width = "30%";
    bar.style.transform = "translateX(0)";
  }
  if (pct) pct.textContent = "";
  if (lbl) lbl.textContent = label;
}

function hideSyncProgress() {
  const el = document.getElementById("syncProgressOverlay");
  if (el) el.style.display = "none";
  const bar = document.getElementById("syncProgressBar");
  if (bar) bar.classList.remove("syncProgressBarIndeterminate");
}

function showSyncStatusBanner(text, isError = false) {
  const ids = [
    ["syncStatusBanner", "syncStatusText"],
    ["syncStatusBannerDesktop", "syncStatusTextDesktop"]
  ];
  ids.forEach(([bannerId, textId]) => {
    const el = document.getElementById(bannerId);
    const textEl = document.getElementById(textId);
    if (el && textEl) {
      textEl.textContent = text;
      el.style.background = isError ? "#fef2f2" : "#eff6ff";
      el.style.borderColor = isError ? "#fecaca" : "#bfdbfe";
      el.style.display = "block";
    }
  });
}

function hideSyncStatusBanner() {
  ["syncStatusBanner", "syncStatusBannerDesktop"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
}

/** Aplica resultado da sincronização (resultados) aos animais locais e atualiza UI.
 * @param options.clearMeta - se false, não limpa meta nem chama openDashboard (uso em lote: só o último aplica).
 * @param options.skipDeleteQueue - se true, atualiza animais mas não remove o registro da fila (resposta síncrona em lote). */
async function applySyncResult(result, qKey, options = {}) {
  const { clearMeta = true, skipDeleteQueue = false } = options;
  if (!result || !Array.isArray(result.resultados)) return;
  let animaisList = (await idbGet("animais", "list")) || [];

  for (const resultado of result.resultados) {
    if (resultado.op === "animal_create" && resultado.local_id && resultado.server_id) {
      const animalIndex = animaisList.findIndex(a => String(a?._id) === String(resultado.local_id));
      if (animalIndex !== -1) {
        const animal = animaisList[animalIndex];
        animal._id = resultado.server_id;
        delete animal._local;
        delete animal._sync;
        animaisList[animalIndex] = animal;
      }
    } else if (resultado.op === "animal_update" && resultado.status === "updated") {
      const targetId = resultado.targetId || resultado.id_local;
      animaisList.forEach((a, i) => {
        const match = String(a?._id) === String(targetId) || String(a?._id) === String(resultado.id_local);
        if (!match) return;
        const animal = { ...animaisList[i] };
        if (resultado.targetId && String(animal._id) !== String(resultado.targetId)) {
          animal._id = resultado.targetId;
        }
        delete animal._local;
        delete animal._sync;
        animaisList[i] = animal;
      });
    } else if (resultado.op === "animal_create_peso" && resultado.animal_peso) {
      const animalId = resultado.animal || resultado.targetId || resultado.id_local || resultado.animal_peso?.animal;
      if (!animalId) return;
      const animalIndex = animaisList.findIndex(a => String(a?._id) === String(animalId));
      if (animalIndex !== -1) {
        const animal = { ...animaisList[animalIndex] };
        animal.animal_peso = resultado.animal_peso;
        if (resultado.animal_peso.peso_atual_kg != null) animal.peso_atual_kg = resultado.animal_peso.peso_atual_kg;
        delete animal._local;
        delete animal._sync;
        animaisList[animalIndex] = animal;
      }
    }
  }

  // Remove duplicatas por _id: pode existir a mesma animal duas vezes (cópia servidor + cópia local pendente). Fica só uma, preferindo a já sincronizada.
  const byId = new Map();
  for (const a of animaisList) {
    const id = String(a?._id || "");
    if (!id) continue;
    const existing = byId.get(id);
    const isPending = String(a?._sync || "").toLowerCase() === "pending";
    if (!existing) {
      byId.set(id, a);
    } else {
      const existingPending = String(existing._sync || "").toLowerCase() === "pending";
      if (isPending && !existingPending) continue;
      byId.set(id, a);
    }
  }
  animaisList = Array.from(byId.values());

  await idbSet("animais", "list", animaisList);
  if (!skipDeleteQueue) {
    const pendingQKeysJson = await idbGet("meta", "sync_pending_qKeys");
    if (pendingQKeysJson) {
      try {
        const keysToDelete = JSON.parse(pendingQKeysJson);
        if (Array.isArray(keysToDelete)) {
          for (const k of keysToDelete) await idbDel("records", k);
        }
      } catch (_) {}
      await idbDel("meta", "sync_pending_qKeys");
    } else if (qKey) {
      await idbDel("records", qKey);
    }
  }
  if (clearMeta) {
    await idbDel("meta", "sync_pending_id");
    await idbDel("meta", "sync_pending_qKey");
    await idbDel("meta", "sync_pending_qKeys");
    resetSyncNotifySound();
    await openDashboard();
  }
}

function restoreFabSyncIcon() {
  const btn = document.getElementById("fabSync");
  if (!btn) return;
  btn.style.animation = "pulse-green 2s infinite";
  btn.innerHTML = `<div class="fabIcon"><svg width="30px" height="30px" viewBox="-0.1 -0.1 1.8 1.8" fill="none"
                        xmlns="http://www.w3.org/2000/svg">
                        <path width="30" height="30" fill="white" fill-opacity="0.01" d="M0 0H1.8V1.8H0V0z" />
                        <path
                            d="M1.65 1.162c0 0.207 -0.168 0.375 -0.375 0.375 -0.067 0 -0.13 -0.018 -0.185 -0.049A0.375 0.375 0 0 1 0.9 1.162c0 -0.096 0.036 -0.184 0.096 -0.251A0.374 0.374 0 0 1 1.275 0.787c0.207 0 0.375 0.168 0.375 0.375"
                            fill="#2F88FF" stroke="#111827" stroke-width="0.10" stroke-linecap="round"
                            stroke-linejoin="round" />
                        <path
                            d="M1.275 0.45v0.337a0.374 0.374 0 0 0 -0.279 0.124A0.373 0.373 0 0 0 0.9 1.162q0 0.033 0.005 0.064a0.375 0.375 0 0 0 0.185 0.263C0.99 1.519 0.858 1.537 0.713 1.537c-0.311 0 -0.563 -0.084 -0.563 -0.188V0.45"
                            stroke="#111827" stroke-width="0.10" stroke-linecap="round" stroke-linejoin="round" />
                        <path
                            d="M1.275 0.45c0 0.104 -0.252 0.188 -0.563 0.188S0.15 0.554 0.15 0.45s0.252 -0.188 0.563 -0.188 0.563 0.084 0.563 0.188"
                            fill="#2F88FF" stroke="#111827" stroke-width="0.10" stroke-linecap="round"
                            stroke-linejoin="round" />
                        <path d="M0.15 1.05c0 0.104 0.252 0.188 0.563 0.188 0.068 0 0.133 -0.004 0.193 -0.011"
                            stroke="#111827" stroke-width="0.10" stroke-linecap="round" stroke-linejoin="round" />
                        <path d="M0.15 0.75c0 0.104 0.252 0.188 0.563 0.188 0.103 0 0.2 -0.009 0.283 -0.026"
                            stroke="#111827" stroke-width="0.10" stroke-linecap="round" stroke-linejoin="round" />
                        <path d="M1.425 1.162a0.15 0.15 0 0 1 -0.15 0.15" stroke="white" stroke-width="0.10"
                            stroke-linecap="round" stroke-linejoin="round" />
                        <path d="M1.125 1.162a0.15 0.15 0 0 1 0.15 -0.15" stroke="white" stroke-width="0.10"
                            stroke-linecap="round" stroke-linejoin="round" />
                    </svg></div>`;
  updateFabSyncVisibility();
}

/** Polling do status da sincronização a cada 20s até receber o status. Retorna Promise que resolve quando concluir (sucesso ou erro). */
function startPollSyncStatus(idResponse, qKey) {
  return new Promise((resolvePoll) => {
    if (syncPollTimerId) {
      clearInterval(syncPollTimerId);
      syncPollTimerId = null;
    }
    syncPollDone = false;

    const done = () => {
      if (syncPollTimerId) {
        clearInterval(syncPollTimerId);
        syncPollTimerId = null;
      }
      resolvePoll();
    };

    const check = async () => {
    if (syncPollDone) return;
    try {
      const url = `${API_CONFIG.getUrl(API_CONFIG.ENDPOINTS.STATUS_OFFLINE)}?id_response=${encodeURIComponent(idResponse)}`;
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) {
        console.warn("[SYNC] Status check HTTP:", res.status);
        return;
      }
      const rawText = await res.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch (parseErr) {
        console.error("[SYNC] Erro ao consultar status: resposta do servidor não é JSON válido.", parseErr);
        console.error("[SYNC] Resposta bruta (primeiros 500 chars):", rawText.slice(0, 500));
        return;
      }

      // Novo formato: { dados: [...], qtd: "1" } — finalizado quando dados.length === qtd
      const dados = Array.isArray(data.dados) ? data.dados : [];
      const qtd = parseInt(data.qtd, 10) || 0;
      const finalizado = qtd > 0 && dados.length === qtd;

      if (finalizado && dados.length > 0) {
        if (syncPollDone) return;
        syncPollDone = true;
        if (syncPollTimerId) {
          clearInterval(syncPollTimerId);
          syncPollTimerId = null;
        }
        const resultados = mapStatusDadosToResultados(dados);
        await applySyncResult({ resultados }, qKey);
        hideSyncProgress();
        hideSyncStatusBanner();
        showSyncStatusBanner("Sincronização concluída com sucesso.", false);
        toast("Sincronização concluída! ✅");
        setTimeout(hideSyncStatusBanner, 3000);
        restoreFabSyncIcon();
        done();
        return;
      }

      // Formato legado: success + resultados
      const status = data.status || data.result?.status;
      const success = data.success === true || status === "completed" || status === "success" || status === "done";
      if (success && (data.resultados || data.result?.resultados)) {
        if (syncPollDone) return;
        syncPollDone = true;
        if (syncPollTimerId) {
          clearInterval(syncPollTimerId);
          syncPollTimerId = null;
        }
        const resultados = data.resultados || data.result?.resultados;
        const result = { ...data, resultados };
        await applySyncResult(result, qKey);
        hideSyncProgress();
        hideSyncStatusBanner();
        showSyncStatusBanner("Sincronização concluída com sucesso.", false);
        toast("Sincronização concluída! ✅");
        setTimeout(hideSyncStatusBanner, 3000);
        restoreFabSyncIcon();
        done();
        return;
      }

      if (data.success === false || data.status === "failed" || data.status === "error") {
        if (syncPollDone) return;
        syncPollDone = true;
        if (syncPollTimerId) {
          clearInterval(syncPollTimerId);
          syncPollTimerId = null;
        }
        hideSyncProgress();
        hideSyncStatusBanner();
        const msg = data.message || data.error || "Sincronização falhou.";
        showSyncStatusBanner(msg, true);
        toast("Erro ao sincronizar: " + msg);
        setTimeout(hideSyncStatusBanner, 5000);
        await idbDel("meta", "sync_pending_id");
        await idbDel("meta", "sync_pending_qKey");
        await idbDel("meta", "sync_pending_qKeys");
        restoreFabSyncIcon();
        done();
        return;
      }
    } catch (e) {
      console.error("[SYNC] Erro ao consultar status:", e);
    }
  };

  // Espera 10 segundos antes da primeira verificação
  (async () => {
    await new Promise(resolve => setTimeout(resolve, 10000));
    await check();
    if (!syncPollDone) {
      syncPollTimerId = setInterval(check, SYNC_CONFIG.POLL_INTERVAL_MS);
    }
  })();
  });
}

/** Converte array "dados" do status_offline para formato resultados (applySyncResult). */
function mapStatusDadosToResultados(dados) {
  if (!Array.isArray(dados)) return [];
  return dados.map(item => {
    if (item.op === "animal_create") {
      return {
        op: "animal_create",
        local_id: item.id_local || item.local_id,
        server_id: item.targetId
      };
    }
    if (item.op === "animal_update") {
      return {
        op: "animal_update",
        targetId: item.targetId,
        id_local: item.id_local || undefined,
        status: (item.status_sync === "completed") ? "updated" : item.status_sync
      };
    }
    return item;
  });
}

/** Aguarda todos os id_response retornarem status finalizado no status_offline. Retorna resultados na mesma ordem dos ids. */
function waitForAllSyncStatus(idResponses) {
  if (!idResponses || idResponses.length === 0) return Promise.resolve([]);
  const results = new Array(idResponses.length).fill(null);
  let resolvedCount = 0;

  const checkOne = async (idResponse, index) => {
    if (results[index] !== null) return;
    const url = `${API_CONFIG.getUrl(API_CONFIG.ENDPOINTS.STATUS_OFFLINE)}?id_response=${encodeURIComponent(idResponse)}`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return;
    const rawText = await res.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (_) {
      return;
    }
    const dados = Array.isArray(data.dados) ? data.dados : [];
    const qtd = parseInt(data.qtd, 10) || 0;
    const finalizado = qtd > 0 && dados.length === qtd;
    if (finalizado && dados.length > 0) {
      results[index] = mapStatusDadosToResultados(dados);
      resolvedCount += 1;
      return;
    }
    if (data.success === false || data.status === "failed" || data.status === "error") {
      throw new Error(data.message || data.error || "Sincronização falhou.");
    }
  };

  return new Promise((resolve, reject) => {
    let intervalId = null;
    const runCheck = async () => {
      try {
        for (let i = 0; i < idResponses.length; i++) {
          if (results[i] === null) await checkOne(idResponses[i], i);
        }
        if (resolvedCount === idResponses.length) {
          if (intervalId) clearInterval(intervalId);
          resolve(results.flat());
        }
      } catch (e) {
        if (intervalId) clearInterval(intervalId);
        reject(e);
      }
    };
    (async () => {
      await new Promise(r => setTimeout(r, 10000));
      await runCheck();
      if (resolvedCount < idResponses.length) {
        intervalId = setInterval(runCheck, SYNC_CONFIG.POLL_INTERVAL_MS);
      }
    })();
  });
}

/** Retorna true se há sincronização em andamento (polling ativo). */
async function isSyncInProgress() {
  const pendingId = await idbGet("meta", "sync_pending_id");
  return !!pendingId;
}

const dateToTimestampSync = (dateValue) => {
  if (!dateValue || String(dateValue).toLowerCase() === "nan" || String(dateValue).trim() === "") return null;
  const dateStr = String(dateValue).trim();
  if (!isNaN(Number(dateStr)) && dateStr.length > 10 && !dateStr.includes("-")) {
    const num = Number(dateStr);
    if (num > 0) return num;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(dateStr)) {
    const date = new Date(dateStr);
    if (!Number.isNaN(date.getTime()) && date.getTime() > 0) return date.getTime();
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const date = new Date(dateStr + "T00:00:00.000Z");
    if (!Number.isNaN(date.getTime()) && date.getTime() > 0) return date.getTime();
  }
  const parsed = new Date(dateStr);
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() > 0 ? parsed.getTime() : null;
};

/** Constrói array de operacoes para envio a partir de uma fila (queue). */
function buildOperacoesFromQueue(queue, dadosOp) {
  return queue.map(op => {
        // create_saida_animais_*: enviado como { op, data_hora, _id/id_local, payload } para o status poder remover da fila
        if (SAIDA_OFFLINE_OP_SET.has(op.op)) {
          const out = {
            op: op.op,
            data_hora: op.at || Date.now(),
            payload: { ...(op.payload || {}) },
          };
          if (op._id) {
            out.id_local = op._id;
          }
          return out;
        }
        // animal_create_peso: mesmo formato de payload que create_saida_animais; só animais e animal_peso preenchidos, resto null/""
        if (op.op === OFFLINE_OPS.ANIMAL_CREATE_PESO) {
          const p = op.payload || {};
          const animalPesoObj = {
            animal: p.animal,
            data_pesagem: p.data_pesagem,
            peso_atual_kg: p.peso_atual_kg,
            tipo_equipamento: p.tipo_equipamento || "Manual",
            momento_pesagem: p.momento_pesagem || "Pesagem regular",
            user: p.user,
          };
          if (op._id) animalPesoObj._id = op._id;
          else if (p._id) animalPesoObj._id = p._id;
          const out = {
            op: "animal_create_peso",
            data_hora: op.at || Date.now(),
            payload: {
              animais: p.animal ? [p.animal] : [],
              animal: p.animal || null,
              animal_peso: animalPesoObj,
              proprietario_destino: null,
              fazenda_destino: null,
              peso_saida: p.peso_atual_kg ?? null,
              nota_fiscal: "",
              data_aquisicao: null,
              valor: null,
              condicao_pagamento: "",
              movimentacao_saida_animal: null,
              movimentacao_entrada_animal: null,
              numero_gta: "",
              serie_gta: "",
              data_emissao_gta: null,
              data_validade_gta: null,
              uf_gta: "",
              fazenda_origem: null,
              user_atual: p.user || null,
              valor_saida: null,
            },
          };
          if (op._id) {
            out.id_local = op._id;
          }
          return out;
        }
        // Clona o payload e garante que proprietario está presente
        const payload = { ...op.payload };
        
        // Garante que o campo seja "proprietario" (não "owner")
        if (payload.owner && !payload.proprietario) {
          payload.proprietario = payload.owner;
        }
        // Remove campo "owner" se existir (já convertido para proprietario)
        delete payload.owner;
        
        // Converte sexo para formato correto (M ou F)
        if (payload.sexo) {
          const sexoUpper = String(payload.sexo).toUpperCase();
          if (sexoUpper === "MACHO" || sexoUpper === "M") {
            payload.sexo = "M";
          } else if (sexoUpper === "FEMEA" || sexoUpper === "F" || sexoUpper === "FÊMEA") {
            payload.sexo = "F";
          }
        }
        
        // Converte UF de sigla para nome completo
        if (payload.uf) {
          const ufSigla = String(payload.uf).toUpperCase();
          if (UF_MAP[ufSigla]) {
            payload.uf = UF_MAP[ufSigla];
          }
        }
        
        // Converte data_nascimento para timestamp (apenas se válida)
        if (payload.data_nascimento && String(payload.data_nascimento).toLowerCase() !== "nan") {
          const timestamp = dateToTimestampSync(payload.data_nascimento);
          if (timestamp !== null && timestamp > 0) {
            payload.data_nascimento = timestamp;
          } else {
            // Se não conseguir converter, remove o campo ou define como null
            delete payload.data_nascimento;
          }
        } else {
          // Remove se vazio ou "NaN"
          delete payload.data_nascimento;
        }
        
        // Garante que list_lotes seja um array
        if (!Array.isArray(payload.list_lotes)) {
          payload.list_lotes = payload.lote ? [payload.lote] : [];
        }

        // update_fazenda_new: destino fica em dados.fazenda_id; no payload vão fazenda_origem, pasto, list_lotes (fazenda_origem é preenchido em processQueue)
        if (dadosOp === "update_fazenda_new") {
          delete payload.fazenda;
        }
        
        // Remove apenas campos de sincronização local; preserva data_modificacao para o servidor comparar
        delete payload._local;
        delete payload._sync;
        
        const operacao = {
          op: op.op,
          data_hora: op.at || Date.now(),
          payload: payload
        };
        
        // Para animal_update e movimentações: adiciona targetId (id do animal)
        if (op.targetId && (op.op === "animal_update" || op.op === OFFLINE_OPS.MOVIMENTACAO_ENTRE_LOTES || op.op === OFFLINE_OPS.MOVIMENTACAO_ENTRE_PASTOS || op.op === OFFLINE_OPS.MOVIMENTACAO_ENTRE_FAZENDAS)) {
          operacao.targetId = op.targetId;
        }
        
        return operacao;
  });
}

/** Envia um payload de sincronização e trata resposta (síncrona ou assíncrona).
 * @param collectIdOnly - se true, não grava em meta e retorna { idResponse } para o caller coletar (envio em lote).
 * @returns true se iniciou polling (modo legado), ou { idResponse } quando collectIdOnly e servidor retornou id_response. */
async function sendSyncPayload(syncPayload, qKey, qKeysToDeleteForApply = null, collectIdOnly = false) {

  console.log(syncPayload);

  const response = await fetch(API_CONFIG.getUrl(API_CONFIG.ENDPOINTS.SYNC_DADOS), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(syncPayload)
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }
  const result = await response.json();
  const idResponse = result.id_response || result.response?.id_response;
  if (idResponse) {
    if (collectIdOnly) {
      return { idResponse };
    }
    await idbSet("meta", "sync_pending_id", idResponse);
    await idbSet("meta", "sync_pending_qKey", qKey);
    if (qKeysToDeleteForApply && qKeysToDeleteForApply.length > 0) {
      await idbSet("meta", "sync_pending_qKeys", JSON.stringify(qKeysToDeleteForApply));
    }
    showSyncProgressIndeterminate("Aguardando conclusão no servidor...");
    showSyncStatusBanner("Sincronização em andamento...");
    return true;
  }
  if (result.success && Array.isArray(result.resultados)) {
    if (collectIdOnly) {
      await applySyncResult(result, qKey, { clearMeta: false, skipDeleteQueue: true });
      return { idResponse: null };
    }
    if (qKeysToDeleteForApply && qKeysToDeleteForApply.length > 0) {
      await idbSet("meta", "sync_pending_qKeys", JSON.stringify(qKeysToDeleteForApply));
    }
    await applySyncResult(result, qKey);
  }
  if (result.erros && Array.isArray(result.erros) && result.erros.length > 0) {
    for (const erro of result.erros) {
      toast(`Erro ao sincronizar ${erro.local_id}: ${erro.erro || erro.message}`);
    }
  }
  if (result.success && !idResponse) {
    resetSyncNotifySound();
  } else if (!idResponse && !result.success) {
    throw new Error(result.message || "Erro ao processar sincronização");
  }
  return collectIdOnly ? { idResponse: null } : false;
}

async function processQueue() {
  if (!navigator.onLine) return;

  const btn = document.getElementById("fabSync");
  if (btn) {
    btn.style.animation = "spin 1s infinite linear";
    btn.innerHTML = `<div class="fabIcon">⏳</div>`;
  }

  showSyncProgress(0, "Preparando...");

  try {
    const keys = await idbGetAllKeys("records");
    const queueKeys = (keys || []).filter(k => String(k).startsWith("queue:"));
    if (queueKeys.length === 0) {
      hideSyncProgress();
      toast("Nenhum dado pendente para sincronizar.");
      return;
    }

    // Fazenda atual = management_fazenda da organização (não da URL), para classificar corretamente
    // "Fazenda atual" = alterações dentro da mesma fazenda; "transferência" = fila com fazenda_id diferente
    const org = await idbGet("organizacao", "current");
    const organizacaoId = org?._id || org?.organizacao || null;
    const managementFazendaId = (org?.colaborador?.management_fazenda && String(org.colaborador.management_fazenda).trim()) || "";
    const currentFazendaId = managementFazendaId || getCurrentFazendaId();

    const currentFarmKeys = queueKeys.filter(k => {
      const parts = k.split(":");
      const keyFazendaId = String(parts[1] || "").trim();
      return keyFazendaId === String(currentFazendaId).trim();
    });
    const transferKeys = queueKeys.filter(k => {
      const parts = k.split(":");
      const keyFazendaId = String(parts[1] || "").trim();
      return keyFazendaId !== String(currentFazendaId).trim();
    });

    const pastosListRaw = (await idbGet("pastos", "list")) || [];
    const colaboradorId = state.ctx.ownerId || "";

    // ---------- Fase 1: fazenda atual — envia CADA operação em requisição separada ----------
    if (currentFarmKeys.length > 0) {
      showSyncProgress(15, "Carregando alterações da fazenda atual...");

      const pastosDaFazenda = Array.isArray(pastosListRaw)
        ? pastosListRaw.filter((p) => String(p?.fazenda || "") === String(currentFazendaId))
        : [];

      const keysWithData = [];
      const opsSequenciais = [];

      for (const qKey of currentFarmKeys) {
        const queue = await idbGet("records", qKey);
        if (!Array.isArray(queue) || queue.length === 0) {
          await idbDel("records", qKey);
          continue;
        }
        const operacoes = buildOperacoesFromQueue(queue, "update_fazenda_old");
        if (operacoes.length === 0) {
          await idbDel("records", qKey);
          continue;
        }
        keysWithData.push(qKey);
        operacoes.forEach(op => {
          opsSequenciais.push({ qKey, op });
        });
      }

      const idResponsesFase1 = [];
      const indicesFase1 = [];
      for (let i = 0; i < opsSequenciais.length; i++) {
        const { qKey, op } = opsSequenciais[i];
        const syncPayload = {
          dados: {
            op: "update_fazenda_old",
            fazenda_id: currentFazendaId,
            colaborador_id: colaboradorId,
            organizacao_id: organizacaoId,
            timestamp: Date.now(),
            qtd_itens: 1,
            operacoes: [op],
            list_pasto: pastosDaFazenda
          }
        };

        const pct = 15 + ((i + 1) / Math.max(1, opsSequenciais.length)) * 25;
        showSyncProgress(pct, `Enviando alteração ${i + 1}/${opsSequenciais.length} da fazenda atual...`);

        const out = await sendSyncPayload(syncPayload, qKey, keysWithData, true);
        if (out && out.idResponse) {
          idResponsesFase1.push(out.idResponse);
          indicesFase1.push(i);
        }

        if (i < opsSequenciais.length - 1) {
          await new Promise(r => setTimeout(r, 3000));
        }
      }

      if (idResponsesFase1.length > 0) {
        showSyncProgressIndeterminate("Aguardando conclusão de todos no servidor...");
        showSyncStatusBanner("Sincronização em andamento...");
        const resultadosFase1 = await waitForAllSyncStatus(idResponsesFase1);
        const orderedResultados = new Array(opsSequenciais.length).fill(null);
        resultadosFase1.forEach((r, j) => {
          if (indicesFase1[j] != null) orderedResultados[indicesFase1[j]] = r;
        });
        const qKeysUnicos = [...new Set(opsSequenciais.map(x => x.qKey))];
        for (let k = 0; k < qKeysUnicos.length; k++) {
          const qKey = qKeysUnicos[k];
          const resultadosDoKey = opsSequenciais
            .map((s, idx) => (s.qKey === qKey ? orderedResultados[idx] : null))
            .filter(Boolean);
          await applySyncResult(
            { resultados: resultadosDoKey },
            qKey,
            { clearMeta: k === qKeysUnicos.length - 1 && transferKeys.length === 0 }
          );
        }
        if (transferKeys.length === 0) {
          hideSyncProgress();
          hideSyncStatusBanner();
          showSyncStatusBanner("Sincronização concluída com sucesso.", false);
          toast("Sincronização concluída! ✅");
          setTimeout(hideSyncStatusBanner, 3000);
          resetSyncNotifySound();
          restoreFabSyncIcon();
          return;
        }
      } else if (opsSequenciais.length > 0 && transferKeys.length === 0) {
        // Todas as respostas da fase 1 foram síncronas (já aplicadas em sendSyncPayload com skipDeleteQueue)
        for (const qKey of keysWithData) await idbDel("records", qKey);
        await idbDel("meta", "sync_pending_id");
        await idbDel("meta", "sync_pending_qKey");
        await idbDel("meta", "sync_pending_qKeys");
        resetSyncNotifySound();
        hideSyncProgress();
        showSyncStatusBanner("Sincronização concluída com sucesso.", false);
        toast("Sincronização concluída! ✅");
        setTimeout(hideSyncStatusBanner, 3000);
        restoreFabSyncIcon();
        await openDashboard();
        return;
      }

      if (opsSequenciais.length > 0 && transferKeys.length > 0) {
        showSyncProgress(45, "Fazenda atual sincronizada. Enviando transferências...");
      }
    }

    // ---------- Fase 2: transferências entre fazendas — envia todas, depois aguarda todos os status ----------
    const listFazendas = (await idbGet("fazenda", "list")) || [];
    const opsTransfer = [];
    for (let i = 0; i < transferKeys.length; i++) {
      const qKey = transferKeys[i];
      const queue = await idbGet("records", qKey);
      if (!Array.isArray(queue) || queue.length === 0) {
        await idbDel("records", qKey);
        continue;
      }
      const parts = qKey.split(":");
      const fazendaId = parts[1] || state.ctx.fazendaId;
      const colaboradorIdFazenda = parts[2] || state.ctx.ownerId || "";
      const destFarm = listFazendas.find((f) => String(f?._id || "") === String(fazendaId));
      const organizacaoIdNovaFazenda = destFarm
        ? (destFarm.organizacao_id || (typeof destFarm.organizacao === "object" ? destFarm.organizacao?._id : destFarm.organizacao) || null)
        : null;
      const organizacaoIdTransfer = organizacaoIdNovaFazenda || organizacaoId;
      const operacoes = buildOperacoesFromQueue(queue, "update_fazenda_new");
      if (operacoes.length === 0) {
        await idbDel("records", qKey);
        continue;
      }
      const pastosDaFazenda = Array.isArray(pastosListRaw)
        ? pastosListRaw.filter((p) => String(p?.fazenda || "") === String(fazendaId))
        : [];
      operacoes.forEach(op => {
        opsTransfer.push({ qKey, op, fazendaId, colaboradorIdFazenda, pastosDaFazenda, organizacao_id: organizacaoIdTransfer });
      });
    }

    const idResponsesFase2 = [];
    const indicesFase2 = [];
    for (let i = 0; i < opsTransfer.length; i++) {
      const { qKey, op, fazendaId, colaboradorIdFazenda, pastosDaFazenda, organizacao_id: organizacaoIdPayload } = opsTransfer[i];
      if (op.op === OFFLINE_OPS.MOVIMENTACAO_ENTRE_FAZENDAS && op.payload) {
        op.payload.fazenda_origem = currentFazendaId;
        op.payload.fazenda_destino = fazendaId;
      }
      const syncPayload = {
        dados: {
          op: "update_fazenda_new",
          fazenda_id: fazendaId,
          organizacao_id: organizacaoIdPayload,
          colaborador_id: colaboradorIdFazenda,
          timestamp: Date.now(),
          qtd_itens: 1,
          operacoes: [op],
          list_pasto: pastosDaFazenda
        }
      };
      const pct = 50 + ((i + 1) / Math.max(1, opsTransfer.length)) * 45;
      showSyncProgress(pct, `Enviando transferência ${i + 1}/${opsTransfer.length}...`);

      const out = await sendSyncPayload(syncPayload, qKey, null, true);
      if (out && out.idResponse) {
        idResponsesFase2.push(out.idResponse);
        indicesFase2.push(i);
      }
      if (i < opsTransfer.length - 1) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    if (idResponsesFase2.length > 0) {
      showSyncProgressIndeterminate("Aguardando conclusão de todos no servidor...");
      showSyncStatusBanner("Sincronização em andamento...");
      const resultadosFase2 = await waitForAllSyncStatus(idResponsesFase2);
      const orderedResultados2 = new Array(opsTransfer.length).fill(null);
      resultadosFase2.forEach((r, j) => {
        if (indicesFase2[j] != null) orderedResultados2[indicesFase2[j]] = r;
      });
      const qKeysUnicos2 = [...new Set(opsTransfer.map(x => x.qKey))];
      for (let k = 0; k < qKeysUnicos2.length; k++) {
        const qKey = qKeysUnicos2[k];
        const resultadosDoKey = opsTransfer
          .map((s, idx) => (s.qKey === qKey ? orderedResultados2[idx] : null))
          .filter(Boolean);
        await applySyncResult(
          { resultados: resultadosDoKey },
          qKey,
          { clearMeta: k === qKeysUnicos2.length - 1 }
        );
      }
    } else if (opsTransfer.length > 0) {
      const qKeysUnicos2 = [...new Set(opsTransfer.map(x => x.qKey))];
      for (const qKey of qKeysUnicos2) await idbDel("records", qKey);
      await idbDel("meta", "sync_pending_id");
      await idbDel("meta", "sync_pending_qKey");
      await idbDel("meta", "sync_pending_qKeys");
    }

    showSyncProgress(100, "Concluído!");
    setTimeout(hideSyncProgress, 500);
    hideSyncStatusBanner();
    showSyncStatusBanner("Sincronização concluída com sucesso.", false);
    toast("Sincronização concluída! ✅");
    setTimeout(hideSyncStatusBanner, 3000);
    resetSyncNotifySound();
    restoreFabSyncIcon();
  } catch (e) {
    console.error("Sync error:", e);
    toast("Erro ao sincronizar. Tente novamente.");
    showSyncProgress(0, "Erro.");
    setTimeout(hideSyncProgress, 800);
  } finally {
    if (btn) restoreFabSyncIcon();
    hideSyncProgress();
  }
}

// Adjusted init to load Dashboard first
async function init() {
  showBoot("Carregando…", "Preparando o modo offline.");
  setNetBadge();
  window.addEventListener("online", () => {
    setNetBadge();
    updateFabSyncVisibility();
    if (state.view === "dashboard" && !state.pipelineAnimal && navigator.onLine) {
      getPendingSyncList().then((list) => {
        if (list.length > 0 && navigator.onLine) {
          state.pendingSyncListForCard = list;
          setPendingSyncCardVisible(true);
          renderPendingSyncCard();
        }
      });
    }
  });
  window.addEventListener("offline", () => {
    setNetBadge();
    updateFabSyncVisibility();
    setPendingSyncCardVisible(false);
  });

  const parsed = await parseFromURL();

  if (parsed.fazendaId && parsed.ownerId) {
    const sessionPayload = {
      modules: parsed.modules,
      moduleConfigs: parsed.moduleConfigs,
      ctx: { fazendaId: parsed.fazendaId, ownerId: parsed.ownerId },
      updatedAt: Date.now()
    };
    if (parsed.initialSyncId) sessionPayload.bootstrap_id = parsed.initialSyncId;
    await idbSet("meta", "session_config", sessionPayload);
    if (parsed.initialSyncId) await idbSet("meta", "bootstrap_id", parsed.initialSyncId);
    const newUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, document.title, newUrl);

    state.ctx = { fazendaId: parsed.fazendaId, ownerId: parsed.ownerId };
    state.modules = buildModules(parsed.modules);
    state.moduleConfigs = parsed.moduleConfigs || [];
  } else {
    const saved = await idbGet("meta", "session_config");
    if (saved && saved.ctx && saved.modules) {
      state.ctx = saved.ctx;
      state.modules = buildModules(saved.modules);
      state.moduleConfigs = saved.moduleConfigs || [];
      if (saved.bootstrap_id) await idbSet("meta", "bootstrap_id", saved.bootstrap_id);
    } else {
      state.ctx = { fazendaId: "", ownerId: "" };
      state.modules = buildModules(["animal"]);
      state.moduleConfigs = [{ modulo: "animal" }];
    }
  }

  // Setup Sidebar (desktop: Início + módulos + usuário)
  renderSidebar();

  const dashDesktopCta = document.getElementById("dashDesktopCta");
  if (dashDesktopCta) {
    dashDesktopCta.onclick = () => {
      const pipelineBtnCreate = document.getElementById("pipelineBtnCreate");
      if (pipelineBtnCreate) pipelineBtnCreate.click();
    };
  }

  await registerSW();

  if (!state.ctx.fazendaId || !state.ctx.ownerId) {
    showBoot("Bem-vindo", "Configure no sistema principal.");
    return;
    // Dont return if just testing locally without params, but ok
  }

  await bootstrapData();

  state.bootstrapReady = true;

  // Verifica status de sincronização inicial
  updateFabSyncVisibility();

  // Initialize Sync Button Logic
  if (state.bootstrapReady) {
    updateFabSyncVisibility();
    const fab = document.getElementById("fabSync");
    if (fab) fab.onclick = processQueue;
  }

  // Opcional: restaura metadados de navegação (view/activeKey) para uso interno
  await restoreNavigationState();

  // Inicia no dashboard (modal da linha de produção fica abaixo do "Bem-vindo de volta")
  await openDashboard();

  // Botão "Atualizar dados" (refazer sincronização inicial): visível quando online e sem pendências
  ["btnRefazerSyncInicial", "btnRefazerSyncInicialMobile"].forEach((id) => {
    const el = document.getElementById(id);
    if (el && !el.__refazerBound) {
      el.__refazerBound = true;
      el.addEventListener("click", () => refazerSincronizacaoInicial());
    }
  });

  // Retomar polling de sincronização pendente (ex.: após refresh)
  const pendingId = await idbGet("meta", "sync_pending_id");
  const pendingQKey = await idbGet("meta", "sync_pending_qKey");
  if (pendingId && pendingQKey) {
    showSyncProgressIndeterminate("Aguardando conclusão no servidor...");
    showSyncStatusBanner("Sincronização em andamento...");
    startPollSyncStatus(pendingId, pendingQKey);
  }
}

init();
