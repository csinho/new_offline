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
  SYNC_CONFIG,
} from "./config.js";

const $ = (sel) => document.querySelector(sel);

// teste

const state = {
  modules: [],
  activeKey: null,
  activeFormRoot: null,
  advanced: false,
  ctx: { fazendaId: "", ownerId: "" },
  bootstrapReady: false,
  view: null, // "dashboard" | "module"

  // NOVO: controle de view do módulo animais
  animalView: "list", // "list" | "form"
  animalEditingId: null, // _id do animal em edição (ou null = criando)
  // Chart.js: instâncias do gráfico Sexo dos Animais (doughnut) para destruir ao atualizar
  chartSex: null,
  chartSexDesktop: null,
  // Gráfico de barras Peso médio por lote (KG)
  chartPesoLote: null,
  chartPesoLoteDesktop: null,
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
  // Borda do avatar no sidebar: verde = online, vermelho = offline
  const sidebarAvatar = $("#sidebarAvatar");
  if (sidebarAvatar) {
    if (online) sidebarAvatar.classList.remove("offline");
    else sidebarAvatar.classList.add("offline");
  }
  // Avatar no dashboard (mobile)
  const avatar = $("#dashAvatar");
  if (avatar) {
    if (online) avatar.classList.remove("offline");
    else avatar.classList.add("offline");
  }
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
      
      const data = await response.json();
      
      // Extrai fazenda, user e modules da resposta (mantém compat com owner antigo)
      const fazendaId = String(data?.fazenda || "").trim();
      const ownerId = String(data?.user || data?.owner || "").trim();
      const modulesArray = Array.isArray(data?.modules) ? data.modules : [];
      const modules = modulesArray.length > 0 ? modulesArray : ["animal"];
      
      return {
        modules,
        fazendaId,
        ownerId,
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
  const ownerId = (u.searchParams.get("user") || u.searchParams.get("owner") || "").trim();

  return {
    modules: modules.length ? modules : ["animal"],
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

  // listas
  if (!Array.isArray(out.list_lotes)) out.list_lotes = out.lote ? [String(out.lote)] : [];
  out.list_lotes = out.list_lotes.map(id => String(id)).filter(Boolean);
  out.lote = out.list_lotes.length > 0 ? out.list_lotes[0] : (out.lote ? String(out.lote) : "");
  // animal 1:1 pasto (id único)
  out.pasto = String(out.pasto || "");
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
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // JSON parse separado pra identificar o erro corretamente
    try {
      data = await res.json();
    } catch (e) {
      throw new Error(`Falha ao ler JSON: ${e?.message || e}`);
    }

    // Novo formato: organizacao { _id, user, list_fazendas: [ { fazenda: {...} }, ... ] }
    // Antigo: data.fazenda + data.user|data.owner (uma fazenda só)
    let organizacaoRaw = null;
    let listFazendaObjects = [];
    let fazendaCurrentRaw = null;
    let ownerRaw = null;

    if (data?.organizacao) {
      organizacaoRaw = data.organizacao;
      ownerRaw = data.organizacao.user ?? null;
      if (ownerRaw?.management_fazenda && !state.ctx.fazendaId) {
        state.ctx = { ...state.ctx, fazendaId: String(ownerRaw.management_fazenda).trim() };
      }
      const listFazendas = Array.isArray(data.organizacao.list_fazendas) ? data.organizacao.list_fazendas : [];
      listFazendaObjects = listFazendas.map((item) => item?.fazenda).filter(Boolean);
      const fazendaIdCtx = String(state.ctx.fazendaId || "").trim();
      const userMgmtFazenda = ownerRaw && String(ownerRaw.management_fazenda || "").trim();
      const entry = listFazendas.find(
        (item) => String(item?.fazenda?._id || "") === fazendaIdCtx || String(item?.fazenda?._id || "") === userMgmtFazenda
      );
      fazendaCurrentRaw = entry?.fazenda ?? listFazendaObjects[0] ?? null;
    } else {
      fazendaCurrentRaw = data?.fazenda || null;
      ownerRaw = data?.user ?? data?.owner ?? null;
      if (fazendaCurrentRaw) listFazendaObjects = [fazendaCurrentRaw];
    }

    // Listas agregadas: TODOS os itens de TODAS as fazendas
    const allAnimaisRaw = listFazendaObjects.reduce((acc, f) => acc.concat(Array.isArray(f?.list_animais) ? f.list_animais : []), []);
    const allLotesRaw = listFazendaObjects.reduce((acc, f) => acc.concat(Array.isArray(f?.list_lotes) ? f.list_lotes : []), []);
    const allPastosRaw = listFazendaObjects.reduce((acc, f) => acc.concat(Array.isArray(f?.list_pasto) ? f.list_pasto : []), []);
    const allVacinacaoRaw = listFazendaObjects.reduce((acc, f) => acc.concat(Array.isArray(f?.list_vacinacao) ? f.list_vacinacao : []), []);

    const owner = toCloneable(ownerRaw);
    const fazendaCurrent = toCloneable(fazendaCurrentRaw);
    const organizacao = organizacaoRaw ? toCloneable(organizacaoRaw) : null;
    const listFazendasClone = listFazendaObjects.map((f) => toCloneable(f));

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
    const proprietarios = toCloneable(Array.isArray(fazendaCurrentRaw?.list_proprietarios) ? fazendaCurrentRaw.list_proprietarios : []);

    // ✅ Gravação com debug por etapa (pra não “sumir” o erro)
    try {
      if (organizacao) await idbSet("organizacao", "current", organizacao);
      await idbSet("fazenda", "list", listFazendasClone);
      await idbSet("fazenda", "current", fazendaCurrent);
      await idbSet("owner", "current", owner);
      await idbSet("animais", "list", animais);
      await idbSet("lotes", "list", lotes);
      await idbSet("pastos", "list", pastos);
      await idbSet("vacinacao", "list", vacinacao);
      await idbSet("fazenda", "list_proprietarios", proprietarios);

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
    console.error("[BOOT] falhou:", err, { url });

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
      `Detalhe: ${err?.message || err}`
    );
    state.bootstrapReady = false;
    return;
  }
}

// ---------------- Sidebar ----------------
function renderSidebar() {
  const nav = $("#moduleNav");
  if (!nav) return;
  nav.innerHTML = "";

  // Dashboard — fora da timeline (separado)
  const inicioItem = document.createElement("div");
  const isDashboard = state.view === "dashboard";
  inicioItem.className = "navItem" + (isDashboard ? " active" : "");
  inicioItem.innerHTML = `<span class="navIcon">🏠</span><span class="navLabel">Dashboard</span>`;
  inicioItem.onclick = async () => {
    state.view = "dashboard";
    state.activeKey = null;
    renderSidebar();
    await openDashboard();
  };
  nav.appendChild(inicioItem);

  // Timeline: só os módulos (1, 2, 3...) — ordem da requisição = ordem da esteira
  const timelineWrap = document.createElement("div");
  timelineWrap.className = "navTimeline";
  let step = 1;
  for (const m of state.modules) {
    const mDef = MODULE_CATALOG[m.key] || m;
    const icon = mDef.icon || "📦";
    const item = document.createElement("div");
    item.className = "navItem" + (state.view === "module" && m.key === state.activeKey ? " active" : "");
    item.innerHTML = `<span class="navTimelineDot" aria-hidden="true">${step}</span><span class="navIcon">${icon}</span><span class="navLabel">${escapeHtml(m.label)}</span>`;
    item.onclick = async () => {
      await openModule(m.key);
    };
    timelineWrap.appendChild(item);
    step++;
  }
  nav.appendChild(timelineWrap);

  renderSidebarUser();
}

async function renderSidebarUser() {
  const avatarEl = $("#sidebarAvatar");
  const nameEl = $("#sidebarUserName");
  const farmEl = $("#sidebarFarmName");
  if (!avatarEl && !nameEl && !farmEl) return;

  const sessionOwner = await idbGet("owner", "current");
  let owner = sessionOwner;
  if (!owner && state.ctx?.ownerId) {
    const owners = (await idbGet("fazenda", "list_proprietarios")) || [];
    owner = owners.find(o => String(o._id) === String(state.ctx.ownerId));
  }
  const name = owner?.nome || "Usuário";
  const firstLetter = name.charAt(0).toUpperCase();

  const fazenda = await idbGet("fazenda", "current");
  const farmName = fazenda?.name || "—";

  if (avatarEl) {
    avatarEl.textContent = firstLetter;
    if (navigator.onLine) avatarEl.classList.remove("offline");
    else avatarEl.classList.add("offline");
  }
  if (nameEl) nameEl.textContent = name;
  if (farmEl) farmEl.textContent = farmName;
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

function animalDisplayName(a) {
  const name = String(a?.nome_completo || "").trim();
  if (name) return name;
  const br = String(a?.brinco_padrao || "").trim();
  return br ? `Animal ${br}` : "Animal";
}

async function renderAnimalList() {
  const secList = $("#modAnimaisList");
  const secForm = $("#modAnimaisForm");
  const animalContainer = $("#animalModuleContainer");

  // Garante que o container está visível
  if (animalContainer) animalContainer.hidden = false;
  
  // Garante visibilidade interna
  if (secList) secList.hidden = false;
  if (secForm) secForm.hidden = true;

  // Header principal esconde pois a lista já tem seu próprio greeting
  setPageHeadVisible(false);

  // Remove o botão "Home" se existir (não deve aparecer no mobile)
  const backDiv = document.getElementById("mobileBackDash");
  if (backDiv) {
    backDiv.remove();
  }

  // Aguarda um frame para garantir que o DOM está pronto
  await new Promise(resolve => requestAnimationFrame(resolve));

  // Dados do cache
  const fazenda = await idbGet("fazenda", "current");
  const farmName = fazenda?.name || "—";
  const farmLabel = $("#farmCurrent");
  if (farmLabel) farmLabel.textContent = farmName;

  const allRaw = (await idbGet("animais", "list")) || [];
  const all = filterByCurrentFazenda(allRaw);
  const pastosRaw = (await idbGet("pastos", "list")) || [];
  const pastos = filterByCurrentFazenda(pastosRaw);
  const pastoById = Object.fromEntries((pastos || []).map(p => [String(p._id || ""), p.nome || "—"]));
  const searchEl = $("#animalSearch");
  const searchElDesktop = $("#animalSearchDesktop");
  const cardsList = $("#animalCardsList");
  const tableBody = $("#animalTableBody");
  const isDesktop = typeof window !== "undefined" && window.innerWidth >= 800;
  const searchVal = normText(isDesktop ? (searchElDesktop ? searchElDesktop.value : "") : (searchEl ? searchEl.value : ""));

  // No desktop só existe tableBody; no mobile só existe cardsList. Só retorna se nenhum dos dois existir.
  if (!cardsList && !tableBody) {
    setTimeout(async () => {
      const retryCards = $("#animalCardsList");
      const retryTable = $("#animalTableBody");
      if (retryCards || retryTable) await renderAnimalList();
    }, 100);
    return;
  }

  const q = searchVal;

  let list = Array.isArray(all) ? all.slice() : [];
  list = list.map(normalizeAnimal);

  // Filtro padrão: apenas não deletados (removemos lógica de "mortos" vs "ativos")
  list = list.filter(a => !a.deleted);

  // Busca
  if (q) {
    list = list.filter(a => {
      const br = normText(a?.brinco_padrao);
      const nm = normText(a?.nome_completo);
      return br.includes(q) || nm.includes(q);
    });
  }

  // Ordenação
  list.sort((a, b) => {
    const an = Number(String(a?.brinco_padrao || "").replace(/\D+/g, ""));
    const bn = Number(String(b?.brinco_padrao || "").replace(/\D+/g, ""));
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
    return String(a?.brinco_padrao || "").localeCompare(String(b?.brinco_padrao || ""));
  });

  // Renderiza Cards Mobile
  if (cardsList) {
    cardsList.innerHTML = "";
    
    if (list.length === 0) {
      cardsList.innerHTML = `
        <div style="text-align: center; padding: 40px 20px; color: var(--muted);">
          <p style="font-size: 14px; font-weight: 600;">Nenhum animal encontrado</p>
          <p style="font-size: 13px; margin-top: 8px;">Tente ajustar sua busca</p>
        </div>
      `;
    } else {
      for (const a of list) {
        const card = document.createElement("div");
        card.className = `animalCard ${a.sexo === "M" ? "male" : "female"}`;
        card.dataset.id = a._id || "";

        // Determina texto de detalhes (raça, peso e pasto)
        const raca = escapeHtml(a?.raca || "—");
        const peso = fmtKg(a?.peso_atual_kg);
        const pastoNome = pastoById[String(a?.pasto || "")] || "—";
        const details = `${raca} • ${peso} • Pasto: ${escapeHtml(pastoNome)}`;

        // Flag de sincronização
        const syncFlag = a._sync === "pending" ? '<span style="font-size: 10px; color: #f59e0b; margin-left: 4px;">⏳</span>' : '';
        
        card.innerHTML = `
          <div class="animalCardIcon">🐮</div>
          <div class="animalCardContent">
            <div class="animalCardBrinco">${escapeHtml(a?.brinco_padrao || "—")}${syncFlag}</div>
            <div class="animalCardDetails">${details}</div>
          </div>
        `;

        card.onclick = async () => {
          await openAnimalFormForEdit(a._id);
        };

        cardsList.appendChild(card);
      }
    }
  }

  // Tabela Desktop: preenche linhas com paginação (10 itens por página quando há >= 10 itens)
  const ITEMS_PER_PAGE = 10;
  const paginationEl = $("#animalTablePagination");
  if (tableBody) {
    tableBody.innerHTML = "";
    if (list.length === 0) {
      tableBody.innerHTML = `
        <tr><td colspan="8" style="text-align: center; padding: 32px; color: var(--muted); font-size: 13px;">Nenhum animal encontrado. Tente ajustar a busca.</td></tr>
      `;
      if (paginationEl) {
        paginationEl.hidden = true;
        paginationEl.innerHTML = "";
      }
    } else {
      const totalItems = list.length;
      const showPagination = totalItems >= ITEMS_PER_PAGE;
      if (!showPagination) {
        if (state.animalListDesktopPage !== undefined) state.animalListDesktopPage = 1;
      }
      const totalPages = showPagination ? Math.ceil(totalItems / ITEMS_PER_PAGE) : 1;
      let page = showPagination ? (state.animalListDesktopPage || 1) : 1;
      if (page < 1) page = 1;
      if (page > totalPages) page = totalPages;
      state.animalListDesktopPage = page;

      const start = (page - 1) * ITEMS_PER_PAGE;
      const pageList = showPagination ? list.slice(start, start + ITEMS_PER_PAGE) : list;

      for (const a of pageList) {
        const tr = document.createElement("tr");
        tr.dataset.id = a._id || "";
        const statusClass = a._sync === "pending" ? "pending" : "synced";
        const statusText = a._sync === "pending" ? "Pendente" : "Sincronizado";
        const pastoNome = pastoById[String(a?.pasto || "")] || "—";
        tr.innerHTML = `
          <td>${escapeHtml(a?.brinco_padrao || "—")}</td>
          <td>${escapeHtml(a?.nome_completo || "—")}</td>
          <td>${fmtDateDisplay(a?.data_nascimento)}</td>
          <td>${escapeHtml(renderSex(a?.sexo))}</td>
          <td>${escapeHtml(a?.categoria || "—")}</td>
          <td>${escapeHtml(fmtKg(a?.peso_atual_kg))}</td>
          <td>${escapeHtml(pastoNome)}</td>
          <td><span class="animalTableStatus ${statusClass}">${statusText}</span></td>
        `;
        tr.onclick = async () => {
          await openAnimalFormForEdit(a._id);
        };
        tableBody.appendChild(tr);
      }

      if (paginationEl) {
        if (showPagination) {
          paginationEl.hidden = false;
          paginationEl.innerHTML = `
            <button type="button" class="paginationBtn" id="animalPaginationPrev" ${page <= 1 ? "disabled" : ""}>Anterior</button>
            <span class="paginationInfo">Página ${page} de ${totalPages}</span>
            <button type="button" class="paginationBtn" id="animalPaginationNext" ${page >= totalPages ? "disabled" : ""}>Próxima</button>
          `;
          const prevBtn = $("#animalPaginationPrev");
          const nextBtn = $("#animalPaginationNext");
          if (prevBtn && page > 1) {
            prevBtn.onclick = () => {
              state.animalListDesktopPage = page - 1;
              renderAnimalList();
            };
          }
          if (nextBtn && page < totalPages) {
            nextBtn.onclick = () => {
              state.animalListDesktopPage = page + 1;
              renderAnimalList();
            };
          }
        } else {
          paginationEl.hidden = true;
          paginationEl.innerHTML = "";
        }
      }
    }
  }

  // Bind Search (mobile): atualiza lista e mantém desktop em sync
  if (searchEl && !searchEl.__bound) {
    searchEl.__bound = true;
    searchEl.addEventListener("input", async () => {
      if (searchElDesktop) searchElDesktop.value = searchEl.value;
      await renderAnimalList();
    });
  }

  // Bind Search Button (mobile)
  const searchBtn = document.querySelector(".animalSearchBtn");
  if (searchBtn && !searchBtn.__bound) {
    searchBtn.__bound = true;
    searchBtn.onclick = async () => {
      await renderAnimalList();
    };
  }

  // Bind Search Desktop: atualiza lista e mantém mobile em sync
  if (searchElDesktop && !searchElDesktop.__bound) {
    searchElDesktop.__bound = true;
    searchElDesktop.addEventListener("input", async () => {
      if (searchEl) searchEl.value = searchElDesktop.value;
      await renderAnimalList();
    });
  }

  // Bind Create Animal Button (mobile)
  const btnCreateAnimal = $("#btnCreateAnimal");
  if (btnCreateAnimal && !btnCreateAnimal.__bound) {
    btnCreateAnimal.__bound = true;
    btnCreateAnimal.addEventListener("click", async () => {
      await openAnimalFormForCreate();
    });
  }

  // Bind Create Animal Button (desktop)
  const btnCreateAnimalDesktop = $("#btnCreateAnimalDesktop");
  if (btnCreateAnimalDesktop && !btnCreateAnimalDesktop.__bound) {
    btnCreateAnimalDesktop.__bound = true;
    btnCreateAnimalDesktop.addEventListener("click", async () => {
      await openAnimalFormForCreate();
    });
  }

  // Bind Back Button
  const backBtn = $("#animalBackBtn");
  if (backBtn && !backBtn.__bound) {
    backBtn.__bound = true;
    backBtn.onclick = async () => {
      await openDashboard();
    };
  }
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

  // extras
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

  // genealogia
  const maeCad = $("#maeCad")?.checked ? "1" : "0";
  const paiCad = $("#paiCad")?.checked ? "1" : "0";
  const mae = $("#animalMae")?.value ?? "";
  const pai = $("#animalPai")?.value ?? "";

  // aquisição
  const gta = $("#animalGta")?.value ?? "";
  const uf = $("#animalUf")?.value ?? "";

  // tipo entrada (chip ativo)
  const entry = document.querySelector("#tipoEntradaChips .chip.active")?.dataset?.value || "Compra";

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

    mae_cadastrada: maeCad,
    pai_cadastrado: paiCad,
    mae_vinculo: mae,
    pai_vinculo: pai,

    gta,
    uf,
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

  if ($("#maeCad")) $("#maeCad").checked = data.mae_cadastrada === "1" || data.mae_cadastrada === true;
  if ($("#paiCad")) $("#paiCad").checked = data.pai_cadastrado === "1" || data.pai_cadastrada === true;
  if ($("#animalMae")) $("#animalMae").value = String(data.mae_vinculo || "");
  if ($("#animalPai")) $("#animalPai").value = String(data.pai_vinculo || "");

  if ($("#animalGta")) $("#animalGta").value = String(data.gta || "");
  if ($("#animalUf")) $("#animalUf").value = String(data.uf || "");

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
  // UF (Estados)
  const selUf = $("#animalUf");
  if (selUf) {
    selUf.innerHTML = [
      `<option value="" selected disabled>Selecione o estado</option>`,
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
  const proprietarios = (await idbGet("fazenda", "list_proprietarios")) || [];
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

  // chips tipo entrada
  const chipWrap = $("#tipoEntradaChips");
  if (chipWrap) {
    chipWrap.querySelectorAll(".chip").forEach(chip => {
      chip.addEventListener("click", () => {
        chipWrap.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
        chip.classList.add("active");
        // Checkmark é adicionado via CSS :after, não precisa manipular texto
        updateSaveButtonState();
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
        document.querySelectorAll(".btnSaveAnimal").forEach((b) => {
          b.disabled = false;
          b.textContent = "Salvar Animal";
        });
        updateSaveButtonState();
      }
    });
  });

  // Validação em tempo real dos campos obrigatórios
  const requiredFields = [
    "#animalOwnerSelect",
    "#animalBrinco",
    "#animalSexo",
    "#animalNasc",
    "#animalCategoria",
    "#animalRaca"
  ];
  
  requiredFields.forEach(selector => {
    const field = $(selector);
    if (field && !field.__validationBound) {
      field.__validationBound = true;
      field.addEventListener("input", updateSaveButtonState);
      field.addEventListener("change", updateSaveButtonState);
    }
  });

  const nascEl = $("#animalNasc");
  if (nascEl && !nascEl.__idadeBound) {
    nascEl.__idadeBound = true;
    nascEl.addEventListener("input", updateAnimalIdadeDisplay);
    nascEl.addEventListener("change", updateAnimalIdadeDisplay);
  }

  updateAnimalIdadeDisplay();
  updateSaveButtonState();

  // botões voltar
  const backIds = ["btnVoltarLista", "btnVoltarLista2", "btnVoltarLista3", "btnVoltarTopo"];
  backIds.forEach(id => {
    const b = $("#" + id);
    if (b && !b.__bound) {
      b.__bound = true;
      b.addEventListener("click", async (e) => {
        e.preventDefault(); // prevenir behavior indesejado
        await openAnimalList();
      });
    }
  });

  // salvar (top)
  const btnSave = $("#btnSave");
  if (btnSave) {
    btnSave.onclick = async () => {
      await saveAnimalFromForm();
    };
  }

  // salvar (bottom - mobile)
  // Botão salvar já está configurado em bindAnimalFormUIOnce

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
  state.animalView = "list";
  state.animalEditingId = null;

  // atualiza “módulo” com layout da lista
  const m = MODULE_CATALOG["animal"];
  setPageHeadTexts(m.pageTitle, m.pageSub);
  setPageHeadVisible(false);

  const secList = $("#modAnimaisList");
  const secForm = $("#modAnimaisForm");
  if (secList) secList.hidden = false;
  if (secForm) secForm.hidden = true;

  // Aguarda um frame para garantir que o DOM está atualizado
  await new Promise(resolve => requestAnimationFrame(resolve));
  
  await renderAnimalList();

  // Esconde FAB Sync no módulo animal
  const fabSync = document.getElementById("fabSync");
  if (fabSync) {
    fabSync.hidden = true;
    fabSync.style.display = "none";
    fabSync.style.visibility = "hidden";
    fabSync.style.opacity = "0";
    fabSync.style.pointerEvents = "none";
  }

  // Salva estado de navegação
  await saveNavigationState();
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
  if (secForm) secForm.hidden = false;

  bindAnimalFormUIOnce();
  populateFixedDropdowns(); // Popula dropdowns fixos (UF, Raça, etc.)
  await fillOwnersAndLotesInForm();

  // advanced state - sempre inicia desligado
  state.advanced = false;
  const tgl = $("#toggleAdvanced");
  if (tgl) tgl.checked = false;
  applyAdvancedVisibility();

  // default owner - primeiro da lista (já selecionado em fillOwnersAndLotesInForm)
  const proprietarios = (await idbGet("fazenda", "list_proprietarios")) || [];
  const defaultOwner = proprietarios.length > 0 ? proprietarios[0]._id : (state.ctx.ownerId || "");
  
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
    mae_cadastrada: "0",
    pai_cadastrado: "0",
    mae_vinculo: "",
    pai_vinculo: "",
    gta: "",
    uf: "",
  };

  await writeAnimalFormByIds(initData);

  // título no header (se você quiser diferenciar)
  setPageHeadTexts("Informações do animal", "Cadastre ou atualize aqui");

  // Garante que FAB Sync está escondido no form
  const fabSync2 = document.getElementById("fabSync");
  if (fabSync2) {
    fabSync2.hidden = true;
    fabSync2.style.display = "none";
    fabSync2.style.visibility = "hidden";
    fabSync2.style.opacity = "0";
    fabSync2.style.pointerEvents = "none";
  }

  // Salva estado de navegação
  await saveNavigationState();
}

async function openAnimalFormForEdit(animalId) {
  if (await isSyncInProgress()) {
    toast("Aguarde a finalização da sincronização para editar animais.");
    return;
  }

  const all = (await idbGet("animais", "list")) || [];
  const a = (Array.isArray(all) ? all : []).find(x => String(x?._id) === String(animalId));

  if (!a) {
    toast("Não foi possível abrir: animal não encontrado no cache.");
    return;
  }

  state.view = "module";
  state.activeKey = "animal";
  state.animalView = "form";
  state.animalEditingId = String(animalId);

  // Esconde FAB Sync imediatamente ao abrir o form
  const fabSync = document.getElementById("fabSync");
  if (fabSync) {
    fabSync.hidden = true;
    fabSync.style.display = "none"; // Força esconder também via CSS
  }

  setPageHeadVisible(true);
  setPageHeadTexts("Informações do animal", `Editando: ${animalDisplayName(a)}`);

  const secList = $("#modAnimaisList");
  const secForm = $("#modAnimaisForm");
  if (secList) secList.hidden = true;
  if (secForm) secForm.hidden = false;

  bindAnimalFormUIOnce();
  populateFixedDropdowns(); // Popula dropdowns fixos (UF, Raça, etc.)
  await fillOwnersAndLotesInForm();

  // advanced state - sempre inicia desligado
  state.advanced = false;
  const tgl = $("#toggleAdvanced");
  if (tgl) tgl.checked = false;
  applyAdvancedVisibility();

  // mapeia do seu objeto (cache) para campos do form (proprietario = dono do animal, usado no dropdown)
  const data = normalizeAnimal(a);
  const rawOwner = data.proprietario ?? data.owner ?? state.ctx.ownerId ?? "";
  const ownerId = (typeof rawOwner === "object" && rawOwner !== null && rawOwner._id)
    ? String(rawOwner._id).trim()
    : String(rawOwner || "").trim();
  const mapped = {
    owner: ownerId,
    entry_type: data.entry_type || "Compra",
    animal_type: data.animal_type || "Físico",
    brinco_padrao: data.brinco_padrao || "",
    sexo: data.sexo || "",
    peso_atual_kg: toNumberOrZero(data.peso_atual_kg),
    data_nascimento: (data.data_nascimento && String(data.data_nascimento).toLowerCase() !== "nan" && String(data.data_nascimento).trim() !== "") 
      ? String(data.data_nascimento).trim() 
      : "",
    categoria: data.categoria || "",
    raca: data.raca || "",

    nome_completo: data.nome_completo || "",
    finalidade: data.finalidade || "",
    peso_nascimento: toNumberOrZero(data.peso_nascimento),
    sisbov: data.sisbov || "",
    identificacao_eletronica: data.identificacao_eletronica || "",
    rgd: data.rgd || "",
    rgn: data.rgn || "",
    list_lotes: Array.isArray(data.list_lotes) ? data.list_lotes : (data.lote ? [data.lote] : []),
    lote: data.lote || (data.list_lotes && data.list_lotes[0]) || "",
    pasto: data.pasto || "",
    observacoes: data.observacoes || data.observacoes || "",

    mae_cadastrada: data.mae_cadastrada || "0",
    pai_cadastrado: data.pai_cadastrado || "0",
    mae_vinculo: data.mae_vinculo || "",
    pai_vinculo: data.pai_vinculo || "",

    gta: data.gta || "",
    uf: data.uf || "",
  };

  await writeAnimalFormByIds(mapped);

  // Garante que FAB Sync está escondido no form
  const fabSync3 = document.getElementById("fabSync");
  if (fabSync3) {
    fabSync3.hidden = true;
    fabSync3.style.display = "none";
    fabSync3.style.visibility = "hidden";
    fabSync3.style.opacity = "0";
    fabSync3.style.pointerEvents = "none";
  }

  // Salva estado de navegação
  await saveNavigationState();
}

// ---------------- Save: CREATE or UPDATE offline (com validação de brinco) ----------------

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
      queue.push({ op: "animal_create", at: Date.now(), payload: record });
      await idbSet("records", qKey, queue);

      // Atualiza dashboard e listagem
      await renderDashboard();
      await renderAnimalList();
      
      toast("Animal salvo offline.");
      
      // Aguarda um pouco para mostrar o loading
      await new Promise(resolve => setTimeout(resolve, 500));
      
      await openAnimalList();
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
    queue.push({ op: "animal_update", at: Date.now(), payload: updated, targetId: editingId });
    await idbSet("records", qKey, queue);

    // Atualiza dashboard e listagem
    await renderDashboard();
    await renderAnimalList();

    toast("Animal atualizado offline.");
    
    // Aguarda um pouco para mostrar o loading
    await new Promise(resolve => setTimeout(resolve, 500));
    
    await openAnimalList();
  } finally {
    // Esconde loading
    if (bootOverlay) {
      bootOverlay.style.display = "none";
    }
  }
}

// ---------------- Render módulo ativo ----------------
async function renderActiveModule() {
  const m = state.modules.find(x => x.key === state.activeKey) || state.modules[0];
  if (!m) return;

  // placeholder BioID
  const btnBio = $("#btnBioId");
  if (btnBio) btnBio.onclick = () => toast("BioID (placeholder)");

  if (!state.bootstrapReady) {
    const view = $("#moduleView");
    if (view) {
      view.innerHTML = `
        <div class="card">
          <b>Modo offline não está pronto</b>
          <div style="color:#6b7280;margin-top:6px;">
            Abra uma vez com internet com os parâmetros corretos para sincronizar os dados.
          </div>
        </div>
      `;
    }
    return;
  }

  // 1. Controle de visibilidade global (Container vs Generic View)
  const animalContainer = $("#animalModuleContainer");
  const moduleView = $("#moduleView");

  if (m.key === "animal") {
    // Exibe container fixo de animais
    if (animalContainer) animalContainer.hidden = false;
    if (moduleView) moduleView.hidden = true;

    // Renderiza a sub-view correta (lista ou form)
    if (state.animalView === "form") {
      if (state.animalEditingId) await openAnimalFormForEdit(state.animalEditingId);
      else await openAnimalFormForCreate();
    } else {
      await openAnimalList();
    }
    
    // Atualiza visibilidade do FAB Sync
    updateFabSyncVisibility();
    return;
  }

  // Outros módulos: esconde animais, mostra view genérica
  if (animalContainer) animalContainer.hidden = true;
  if (moduleView) moduleView.hidden = false;

  setPageHeadVisible(true);

  // Módulo Movimentações (Entre lotes, Entre pastos, Entre fazendas)
  if (m.key === "movimentacao") {
    setPageHeadVisible(false);
    await renderMovimentacoesModule(moduleView);
    updateFabSyncVisibility();
    return;
  }

  // Módulo Saída de Animais (Venda, Morte, Empréstimo, Ajuste inventário, Doação)
  if (m.key === "saida_animais") {
    setPageHeadVisible(false);
    await renderSaidaAnimaisModule(moduleView);
    return;
  }

  // default render
  setPageHeadTexts(m.pageTitle || m.label, m.pageSub || "");

  if (moduleView) {
    moduleView.innerHTML = `
      <div class="card">
        <b>${escapeHtml(m.label)}</b>
        <div style="color:#6b7280;margin-top:6px;margin-bottom:16px;">Módulo ainda não desenhado no novo layout.</div>
        <button class="btn secondary" id="btnBackToDashGeneric" style="width:100%">🔙 Voltar ao Dashboard</button>
      </div>
    `;
    const btn = moduleView.querySelector("#btnBackToDashGeneric");
    if (btn) btn.onclick = openDashboard;
  }
}

// ---------------- Movimentações (módulo Lotes) ----------------
const MOV_TAB = { LOTES: "lotes", PASTOS: "pastos", FAZENDAS: "fazendas" };

async function renderMovimentacoesModule(container) {
  if (!container) return;

  container.hidden = false;
  container.innerHTML = `
    <div class="movPage">
      <div class="movTabs" role="tablist">
        <button type="button" class="movTab active" data-tab="lotes" role="tab">Entre lotes</button>
        <button type="button" class="movTab" data-tab="pastos" role="tab">Entre pastos</button>
        <button type="button" class="movTab" data-tab="fazendas" role="tab">Entre fazendas</button>
      </div>

      <div class="movContent movTabLotes" id="movContentLotes">
        <div class="movHead">
          <div>
            <h1 class="movTitle">Movimentação entre lotes</h1>
            <p class="movSub">Altere os animais da fazenda de um lote para outro</p>
          </div>
          <button type="button" class="btn primary movBtnTransferir" id="movBtnTransferir" aria-label="Abrir confirmação de transferência">
            <span class="movBtnTransferirIcon" aria-hidden="true">⇄</span> Transferir
          </button>
        </div>

        <div class="movCards">
          <div class="movCard movCardHighlight">
            <label class="movCardLabel"><span class="movCardIcon">📍</span> Seleção do lote de origem</label>
            <select id="movLoteOrigem" class="movSelect">
              <option value="">Selecione o lote de origem</option>
            </select>
          </div>
          <div class="movCard">
            <label class="movCardLabel"><span class="movCardIcon">◆</span> Seleção do lote de destino</label>
            <select id="movLoteDestino" class="movSelect">
              <option value="">Selecione o lote de destino</option>
            </select>
          </div>
        </div>

        <div class="movCard movCardTable">
          <h2 class="movCardTitle"><span class="movCardIcon">🐮</span> Lista de animais</h2>
          <div class="movTableWrap animalTableWrap">
            <table class="movTable animalTable">
              <thead>
                <tr>
                  <th class="movThCheck"><label class="movCheckWrap"><input type="checkbox" id="movSelectAll" aria-label="Selecionar todos" /><span class="movCheckbox"></span></label></th>
                  <th>Brinco</th>
                  <th>Sexo</th>
                  <th>Raça</th>
                  <th>Peso</th>
                </tr>
              </thead>
              <tbody id="movTableBody">
                <tr><td colspan="5" class="movTableEmpty">Selecione um lote de origem para listar os animais.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="movContent movTabPastos" id="movContentPastos" hidden>
        <div class="movHead">
          <div>
            <h1 class="movTitle">Movimentação entre pastos</h1>
            <p class="movSub">Altere os animais da fazenda de um pasto para outro</p>
          </div>
          <button type="button" class="btn primary movBtnTransferir" id="movBtnTransferirPastos" aria-label="Abrir confirmação de transferência">
            <span class="movBtnTransferirIcon" aria-hidden="true">⇄</span> Transferir
          </button>
        </div>

        <div class="movCards">
          <div class="movCard movCardHighlight">
            <label class="movCardLabel"><span class="movCardIcon">📍</span> Seleção do pasto de origem</label>
            <select id="movPastoOrigem" class="movSelect">
              <option value="">Selecione o pasto de origem</option>
            </select>
          </div>
          <div class="movCard">
            <label class="movCardLabel"><span class="movCardIcon">◆</span> Seleção do pasto de destino</label>
            <select id="movPastoDestino" class="movSelect">
              <option value="">Selecione o pasto de destino</option>
            </select>
          </div>
        </div>

        <div class="movCard movCardTable">
          <h2 class="movCardTitle"><span class="movCardIcon">🐮</span> Lista de animais</h2>
          <div class="movTableWrap animalTableWrap">
            <table class="movTable animalTable">
              <thead>
                <tr>
                  <th class="movThCheck"><label class="movCheckWrap"><input type="checkbox" id="movSelectAllPastos" aria-label="Selecionar todos" /><span class="movCheckbox"></span></label></th>
                  <th>Brinco</th>
                  <th>Sexo</th>
                  <th>Raça</th>
                  <th>Peso</th>
                </tr>
              </thead>
              <tbody id="movTableBodyPastos">
                <tr><td colspan="5" class="movTableEmpty">Selecione um pasto de origem para listar os animais.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="movContent movTabFazendas" id="movContentFazendas" hidden>
        <div class="movHead">
          <div>
            <h1 class="movTitle">Movimentação entre fazendas</h1>
            <p class="movSub">Altere os animais de uma fazenda para outra</p>
          </div>
          <button type="button" class="btn primary movBtnTransferir" id="movBtnTransferirFazendas" aria-label="Abrir confirmação de transferência">
            <span class="movBtnTransferirIcon" aria-hidden="true">⇄</span> Transferir
          </button>
        </div>

        <div class="movCards">
          <div class="movCard movCardHighlight">
            <label class="movCardLabel"><span class="movCardIcon">📍</span> Seleção da fazenda de origem</label>
            <div id="movFazendaOrigemNome" class="movFazendaNome">—</div>
            <p class="movCardHint" style="margin-top: 8px; color: #6b7280; font-size: 0.875rem;">Agora, selecione o Lote ou Pasto de origem:</p>
            <div class="movToggleGroup" style="margin-top: 12px; display: flex; gap: 8px;">
              <button type="button" class="movToggleBtn" id="movToggleLoteOrigem" data-type="lote">Lote</button>
              <button type="button" class="movToggleBtn movToggleBtnActive" id="movTogglePastoOrigem" data-type="pasto">Pasto</button>
            </div>
            <select id="movLoteOrigemFazenda" class="movSelect" style="display: none; margin-top: 12px;">
              <option value="">Selecione o lote de origem</option>
            </select>
            <select id="movPastoOrigemFazenda" class="movSelect" style="margin-top: 12px;">
              <option value="">Selecione o pasto de origem</option>
            </select>
          </div>
          <div class="movCard">
            <label class="movCardLabel"><span class="movCardIcon">◆</span> Seleção da fazenda de destino</label>
            <select id="movFazendaDestino" class="movSelect">
              <option value="">Selecione a fazenda de destino</option>
            </select>
            <p class="movCardHint" style="margin-top: 12px; color: #6b7280; font-size: 0.875rem;">Agora, selecione o Lote ou Pasto de destino:</p>
            <div class="movToggleGroup" style="margin-top: 12px; display: flex; gap: 8px;">
              <button type="button" class="movToggleBtn movToggleBtnActive" id="movToggleLoteDestino" data-type="lote">Lote</button>
              <button type="button" class="movToggleBtn" id="movTogglePastoDestino" data-type="pasto">Pasto</button>
            </div>
            <select id="movLoteDestinoFazenda" class="movSelect" style="margin-top: 12px;">
              <option value="">Selecione o lote de destino</option>
            </select>
            <select id="movPastoDestinoFazenda" class="movSelect" style="display: none; margin-top: 12px;">
              <option value="">Selecione o pasto de destino</option>
            </select>
          </div>
        </div>

        <div class="movCard movCardTable">
          <h2 class="movCardTitle"><span class="movCardIcon">🐮</span> Lista de animais</h2>
          <div class="movTableWrap animalTableWrap">
            <table class="movTable animalTable">
              <thead>
                <tr>
                  <th class="movThCheck"><label class="movCheckWrap"><input type="checkbox" id="movSelectAllFazendas" aria-label="Selecionar todos" /><span class="movCheckbox"></span></label></th>
                  <th>Brinco</th>
                  <th>Sexo</th>
                  <th>Raça</th>
                  <th>Peso</th>
                </tr>
              </thead>
              <tbody id="movTableBodyFazendas">
                <tr><td colspan="5" class="movTableEmpty">Selecione um lote ou pasto de origem para listar os animais.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- Modal confirmação transferência (oculto até clicar em Transferir) -->
    <div id="movModalOverlay" class="movModalOverlay" style="display:none;">
      <div class="movModal" role="dialog" aria-labelledby="movModalTitle" aria-modal="true">
        <div class="movModalHeader">
          <div class="movModalHeaderText">
            <h2 id="movModalTitle" class="movModalTitle">Confirmar Transferência</h2>
            <p class="movModalSub">Revise os detalhes antes de confirmar a movimentação dos animais.</p>
          </div>
          <button type="button" class="movModalClose" id="movModalClose" aria-label="Fechar">×</button>
        </div>
        <div class="movModalBody">
          <div class="movModalCards">
            <div class="movModalCard movModalCardOrigem">
              <span class="movModalCardIcon" aria-hidden="true">⊕</span>
              <span class="movModalCardLabel">Origem</span>
              <span class="movModalCardVal" id="movModalOrigem">—</span>
            </div>
            <div class="movModalArrow" aria-hidden="true">→</div>
            <div class="movModalCard movModalCardDestino">
              <span class="movModalCardIcon movModalCardIconDestino" aria-hidden="true">◎</span>
              <span class="movModalCardLabel">Destino</span>
              <span class="movModalCardVal" id="movModalDestino">—</span>
            </div>
          </div>
          <div class="movModalListSection">
            <h3 class="movModalListTitle"><span class="movModalListIcon" aria-hidden="true">🐮</span> Lista de animais <span id="movModalAnimaisCount">0</span></h3>
            <div class="movModalListWrap">
              <div id="movModalAnimais" class="movModalAnimaisList"></div>
            </div>
          </div>
          <div class="movModalWarning">
            <span class="movModalWarningIcon" aria-hidden="true">⚠</span>
            <p>Por favor, confira se as informações estão corretas. Essa ação não poderá ser desfeita!</p>
          </div>
        </div>
        <div class="movModalFooter">
          <button type="button" class="btn secondary movModalBtnCancel" id="movModalCancelar"><span aria-hidden="true">×</span> Cancelar</button>
          <button type="button" class="btn primary movModalBtnConfirm" id="movModalConfirmar"><span class="movModalBtnConfirmIcon" aria-hidden="true">⇄</span> Confirmar Transferência</button>
        </div>
      </div>
    </div>
  `;

  const tabLotes = container.querySelector('[data-tab="lotes"]');
  const tabPastos = container.querySelector('[data-tab="pastos"]');
  const tabFazendas = container.querySelector('[data-tab="fazendas"]');
  const contentLotes = document.getElementById("movContentLotes");
  const contentPastos = document.getElementById("movContentPastos");
  const contentFazendas = document.getElementById("movContentFazendas");

  function setActiveTab(tabKey) {
    [tabLotes, tabPastos, tabFazendas].forEach(t => t && t.classList.remove("active"));
    const active = container.querySelector(`[data-tab="${tabKey}"]`);
    if (active) active.classList.add("active");
    if (contentLotes) contentLotes.hidden = tabKey !== "lotes";
    if (contentPastos) contentPastos.hidden = tabKey !== "pastos";
    if (contentFazendas) contentFazendas.hidden = tabKey !== "fazendas";
  }

  tabLotes && (tabLotes.onclick = () => setActiveTab("lotes"));
  tabPastos && (tabPastos.onclick = () => setActiveTab("pastos"));
  tabFazendas && (tabFazendas.onclick = () => setActiveTab("fazendas"));

  const lotesRaw = (await idbGet("lotes", "list")) || [];
  const pastosRaw = (await idbGet("pastos", "list")) || [];
  const lotes = filterByCurrentFazenda(lotesRaw);
  const pastos = filterByCurrentFazenda(pastosRaw);
  const selOrigem = container.querySelector("#movLoteOrigem");
  const selDestino = container.querySelector("#movLoteDestino");
  const tbody = container.querySelector("#movTableBody");
  const selectAll = container.querySelector("#movSelectAll");
  const btnTransferir = container.querySelector("#movBtnTransferir");
  const selPastoOrigem = container.querySelector("#movPastoOrigem");
  const selPastoDestino = container.querySelector("#movPastoDestino");
  const tbodyPastos = container.querySelector("#movTableBodyPastos");
  const selectAllPastos = container.querySelector("#movSelectAllPastos");
  const btnTransferirPastos = container.querySelector("#movBtnTransferirPastos");
  const modalOverlay = container.querySelector("#movModalOverlay");
  const modalClose = container.querySelector("#movModalClose");
  const modalCancelar = container.querySelector("#movModalCancelar");
  const modalConfirmar = container.querySelector("#movModalConfirmar");

  if (!selOrigem || !selDestino || !tbody) return;

  selOrigem.innerHTML = '<option value="">Selecione o lote de origem</option>' +
    lotes.map(l => `<option value="${escapeHtml(l._id)}">${escapeHtml(l.nome_lote || "—")}</option>`).join("");

  if (selPastoOrigem) {
    selPastoOrigem.innerHTML = '<option value="">Selecione o pasto de origem</option>' +
      (pastos || []).map(p => `<option value="${escapeHtml(p._id)}">${escapeHtml(p.nome || "—")}</option>`).join("");
  }

  let animaisDoLote = [];
  let selectedIds = new Set();
  let animaisDoPasto = [];
  let selectedIdsPastos = new Set();

  function getSelectedAnimals() {
    return animaisDoLote.filter(a => selectedIds.has(String(a._id)));
  }

  function updateTransferirButton() {
    const dest = selDestino && selDestino.value;
    const canTransfer = !!dest && selectedIds.size > 0;
    if (btnTransferir) {
      btnTransferir.classList.toggle("movBtnTransferir--disabled", !canTransfer);
      btnTransferir.setAttribute("aria-disabled", canTransfer ? "false" : "true");
    }
  }
  updateTransferirButton();

  function renderTable(animais) {
    animaisDoLote = animais;
    tbody.innerHTML = "";
    if (animais.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="movTableEmpty">Nenhum animal neste lote.</td></tr>';
      selectAll && (selectAll.checked = false);
      selectedIds.clear();
      updateTransferirButton();
      return;
    }
    animais.forEach(a => {
      const tr = document.createElement("tr");
      tr.dataset.id = a._id || "";
      const id = String(a._id || "");
      const checked = selectedIds.has(id);
      tr.innerHTML = `
        <td class="movTdCheck"><label class="movCheckWrap"><input type="checkbox" class="movRowCheck" data-id="${escapeHtml(id)}" ${checked ? "checked" : ""} /><span class="movCheckbox"></span></label></td>
        <td>${escapeHtml(a?.brinco_padrao || "—")}</td>
        <td>${escapeHtml(renderSex(a?.sexo))}</td>
        <td>${escapeHtml(a?.raca || "—")}</td>
        <td>${escapeHtml(fmtKg(a?.peso_atual_kg))}</td>
      `;
      const cb = tr.querySelector(".movRowCheck");
      if (cb) {
        cb.addEventListener("change", () => {
          if (cb.checked) selectedIds.add(id); else selectedIds.delete(id);
          selectAll && (selectAll.checked = selectedIds.size === animais.length);
          updateTransferirButton();
        });
      }
      tbody.appendChild(tr);
    });
    selectAll && (selectAll.checked = selectedIds.size === animais.length);
    updateTransferirButton();
  }

  selectAll && selectAll.addEventListener("change", () => {
    if (selectAll.checked) animaisDoLote.forEach(a => selectedIds.add(String(a._id)));
    else selectedIds.clear();
    tbody.querySelectorAll(".movRowCheck").forEach(cb => { cb.checked = selectAll.checked; });
    updateTransferirButton();
  });

  function updateTransferirPastosButton() {
    const dest = selPastoDestino && selPastoDestino.value;
    const canTransfer = !!dest && selectedIdsPastos.size > 0;
    if (btnTransferirPastos) {
      btnTransferirPastos.classList.toggle("movBtnTransferir--disabled", !canTransfer);
      btnTransferirPastos.setAttribute("aria-disabled", canTransfer ? "false" : "true");
    }
  }
  updateTransferirPastosButton();

  function renderTablePastos(animais) {
    if (!tbodyPastos) return;
    animaisDoPasto = animais;
    tbodyPastos.innerHTML = "";
    if (animais.length === 0) {
      tbodyPastos.innerHTML = '<tr><td colspan="5" class="movTableEmpty">Nenhum animal neste pasto.</td></tr>';
      if (selectAllPastos) selectAllPastos.checked = false;
      selectedIdsPastos.clear();
      updateTransferirPastosButton();
      return;
    }
    animais.forEach(a => {
      const tr = document.createElement("tr");
      tr.dataset.id = a._id || "";
      const id = String(a._id || "");
      const checked = selectedIdsPastos.has(id);
      tr.innerHTML = `
        <td class="movTdCheck"><label class="movCheckWrap"><input type="checkbox" class="movRowCheck movRowCheckPastos" data-id="${escapeHtml(id)}" ${checked ? "checked" : ""} /><span class="movCheckbox"></span></label></td>
        <td>${escapeHtml(a?.brinco_padrao || "—")}</td>
        <td>${escapeHtml(renderSex(a?.sexo))}</td>
        <td>${escapeHtml(a?.raca || "—")}</td>
        <td>${escapeHtml(fmtKg(a?.peso_atual_kg))}</td>
      `;
      const cb = tr.querySelector(".movRowCheck");
      if (cb) {
        cb.addEventListener("change", () => {
          if (cb.checked) selectedIdsPastos.add(id); else selectedIdsPastos.delete(id);
          if (selectAllPastos) selectAllPastos.checked = selectedIdsPastos.size === animais.length;
          updateTransferirPastosButton();
        });
      }
      tbodyPastos.appendChild(tr);
    });
    if (selectAllPastos) selectAllPastos.checked = selectedIdsPastos.size === animais.length;
    updateTransferirPastosButton();
  }

  if (selectAllPastos) {
    selectAllPastos.addEventListener("change", () => {
      if (selectAllPastos.checked) animaisDoPasto.forEach(a => selectedIdsPastos.add(String(a._id)));
      else selectedIdsPastos.clear();
      if (tbodyPastos) tbodyPastos.querySelectorAll(".movRowCheckPastos").forEach(cb => { cb.checked = selectAllPastos.checked; });
      updateTransferirPastosButton();
    });
  }

  if (selPastoOrigem) {
    selPastoOrigem.addEventListener("change", async () => {
      const originId = selPastoOrigem.value;
      selectedIdsPastos.clear();
      const allRaw = (await idbGet("animais", "list")) || [];
      const all = filterByCurrentFazenda(allRaw);
      const list = all.filter(a => !a.deleted && String(a?.pasto || "") === String(originId)).map(normalizeAnimal);
      renderTablePastos(list);

      const destinos = (pastos || []).filter(p => String(p._id) !== String(originId));
      if (selPastoDestino) {
        selPastoDestino.innerHTML = '<option value="">Selecione o pasto de destino</option>' +
          destinos.map(p => `<option value="${escapeHtml(p._id)}">${escapeHtml(p.nome || "—")}</option>`).join("");
        selPastoDestino.value = "";
      }
      updateTransferirPastosButton();
    });
  }
  if (selPastoDestino) selPastoDestino.addEventListener("change", updateTransferirPastosButton);

  selOrigem.addEventListener("change", async () => {
    const originId = selOrigem.value;
    selectedIds.clear();
    const allRaw = (await idbGet("animais", "list")) || [];
    const all = filterByCurrentFazenda(allRaw);
    const list = all.filter(a => {
      const norm = normalizeAnimal(a);
      const inLote = norm.list_lotes && norm.list_lotes.some(lid => String(lid) === String(originId));
      return !a.deleted && (inLote || String(a?.lote || "") === String(originId));
    }).map(normalizeAnimal);
    renderTable(list);

    const destinos = lotes.filter(l => String(l._id) !== String(originId));
    selDestino.innerHTML = '<option value="">Selecione o lote de destino</option>' +
      destinos.map(l => `<option value="${escapeHtml(l._id)}">${escapeHtml(l.nome_lote || "—")}</option>`).join("");
    selDestino.value = "";
    updateTransferirButton();
  });

  selDestino && selDestino.addEventListener("change", updateTransferirButton);

  function openTransferModal() {
    const destId = selDestino && selDestino.value;
    const selected = getSelectedAnimals();
    if (!destId || selected.length === 0) return;
    const origemNome = lotes.find(l => String(l._id) === String(selOrigem.value))?.nome_lote || "—";
    const destinoNome = lotes.find(l => String(l._id) === String(destId))?.nome_lote || "—";

    const modalOrigem = container.querySelector("#movModalOrigem");
    const modalDestino = container.querySelector("#movModalDestino");
    const countEl = container.querySelector("#movModalAnimaisCount");
    const listEl = container.querySelector("#movModalAnimais");
    if (modalOrigem) modalOrigem.textContent = origemNome;
    if (modalDestino) modalDestino.textContent = destinoNome;
    if (countEl) countEl.textContent = selected.length;
    if (listEl) {
      listEl.innerHTML = selected.map(a => {
        const tag = escapeHtml(a?.brinco_padrao || "—");
        const name = escapeHtml((a?.nome_completo || "").trim() || "—");
        const raca = escapeHtml(a?.raca || "—");
        const peso = escapeHtml(fmtKg(a?.peso_atual_kg));
        const sexo = escapeHtml(renderSex(a?.sexo));
        return `<div class="movModalAnimalRow">
          <div class="movModalAnimalId">#${tag} ${name !== "—" ? name : ""}</div>
          <span class="movModalAnimalRaca">${raca}</span>
          <span class="movModalAnimalPeso">${peso}</span>
          <span class="movModalAnimalSexo">${sexo}</span>
        </div>`;
      }).join("");
    }

    if (modalOverlay) {
      modalOverlay.dataset.destId = destId;
      modalOverlay.style.display = "flex";
    }
  }

  container.addEventListener("click", (e) => {
    const btnPastos = e.target.closest("#movBtnTransferirPastos");
    if (btnPastos) {
      e.preventDefault();
      e.stopPropagation();
      const destId = selPastoDestino && selPastoDestino.value;
      const selected = animaisDoPasto.filter(a => selectedIdsPastos.has(String(a._id)));
      if (!destId || selected.length === 0) {
        toast("Selecione pelo menos um animal e o pasto de destino.");
        return;
      }
      const origemNome = (pastos || []).find(p => String(p._id) === String(selPastoOrigem?.value))?.nome || "—";
      const destinoNome = (pastos || []).find(p => String(p._id) === String(destId))?.nome || "—";
      const modalOrigem = container.querySelector("#movModalOrigem");
      const modalDestino = container.querySelector("#movModalDestino");
      const countEl = container.querySelector("#movModalAnimaisCount");
      const listEl = container.querySelector("#movModalAnimais");
      if (modalOrigem) modalOrigem.textContent = origemNome;
      if (modalDestino) modalDestino.textContent = destinoNome;
      if (countEl) countEl.textContent = selected.length;
      if (listEl) {
        listEl.innerHTML = selected.map(a => {
          const tag = escapeHtml(a?.brinco_padrao || "—");
          const name = escapeHtml((a?.nome_completo || "").trim() || "—");
          const raca = escapeHtml(a?.raca || "—");
          const peso = escapeHtml(fmtKg(a?.peso_atual_kg));
          const sexo = escapeHtml(renderSex(a?.sexo));
          return `<div class="movModalAnimalRow">
            <div class="movModalAnimalId">#${tag} ${name !== "—" ? name : ""}</div>
            <span class="movModalAnimalRaca">${raca}</span>
            <span class="movModalAnimalPeso">${peso}</span>
            <span class="movModalAnimalSexo">${sexo}</span>
          </div>`;
        }).join("");
      }
      if (modalOverlay) {
        modalOverlay.dataset.context = "pastos";
        modalOverlay.dataset.destId = destId;
        modalOverlay.style.display = "flex";
      }
      return;
    }
    const btn = e.target.closest("#movBtnTransferir");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const destId = selDestino && selDestino.value;
    const selected = getSelectedAnimals();
    if (!destId || selected.length === 0) {
      toast("Selecione pelo menos um animal e o lote de destino.");
      return;
    }
    openTransferModal();
  });

  function closeTransferModal() {
    if (modalOverlay) modalOverlay.style.display = "none";
  }
  modalClose && modalClose.addEventListener("click", closeTransferModal);
  modalCancelar && modalCancelar.addEventListener("click", closeTransferModal);

  modalConfirmar && modalConfirmar.addEventListener("click", async () => {
    const context = modalOverlay && modalOverlay.dataset.context;
    const destId = modalOverlay && modalOverlay.dataset.destId;

    if (context === "pastos") {
      const selected = animaisDoPasto.filter(a => selectedIdsPastos.has(String(a._id)));
      if (!destId || selected.length === 0) {
        closeTransferModal();
        if (modalOverlay) delete modalOverlay.dataset.context;
        return;
      }
      const list = (await idbGet("animais", "list")) || [];
      const ids = new Set(selected.map(a => String(a._id)));
      const qKey = `queue:${state.ctx.fazendaId || ""}:${state.ctx.ownerId || ""}:animal`;
      const queue = (await idbGet("records", qKey)) || [];

      for (let i = 0; i < list.length; i++) {
        if (!ids.has(String(list[i]._id))) continue;
        const prev = list[i];
        const updated = normalizeAnimal({
          ...prev,
          pasto: destId,
          _local: prev._local || true,
          _sync: "pending",
          data_modificacao: prev.data_modificacao,
        });
        list[i] = updated;
        queue.push({ op: "animal_update", at: Date.now(), payload: updated, targetId: prev._id });
      }

      await idbSet("animais", "list", list);
      await idbSet("records", qKey, queue);

      closeTransferModal();
      if (modalOverlay) delete modalOverlay.dataset.context;
      toast("Transferência de pasto registrada offline. " + selected.length + " animal(is) na fila para sincronizar.");

      selectedIdsPastos.clear();
      const originPastoId = selPastoOrigem && selPastoOrigem.value;
      const allRaw = (await idbGet("animais", "list")) || [];
      const all = filterByCurrentFazenda(allRaw);
      const refreshedPastos = all.filter(a => !a.deleted && String(a?.pasto || "") === String(originPastoId)).map(normalizeAnimal);
      renderTablePastos(refreshedPastos);
      updateTransferirPastosButton();
      return;
    }

    const selected = getSelectedAnimals();
    if (!destId || selected.length === 0) {
      closeTransferModal();
      return;
    }

    const list = (await idbGet("animais", "list")) || [];
    const ids = new Set(selected.map(a => String(a._id)));
    const qKey = `queue:${state.ctx.fazendaId || ""}:${state.ctx.ownerId || ""}:animal`;
    const queue = (await idbGet("records", qKey)) || [];

    for (let i = 0; i < list.length; i++) {
      if (!ids.has(String(list[i]._id))) continue;
      const prev = list[i];
      const updated = normalizeAnimal({
        ...prev,
        list_lotes: [destId],
        lote: destId,
        _local: prev._local || true,
        _sync: "pending",
        data_modificacao: prev.data_modificacao,
      });
      list[i] = updated;
      queue.push({ op: "animal_update", at: Date.now(), payload: updated, targetId: prev._id });
    }

    await idbSet("animais", "list", list);
    await idbSet("records", qKey, queue);

    closeTransferModal();
    toast("Transferência registrada offline. " + selected.length + " animal(is) na fila para sincronizar.");

    selectedIds.clear();
    const originId = selOrigem.value;
    const allRaw = (await idbGet("animais", "list")) || [];
    const all = filterByCurrentFazenda(allRaw);
    const refreshed = all.filter(a => {
      const norm = normalizeAnimal(a);
      const inLote = norm.list_lotes && norm.list_lotes.some(lid => String(lid) === String(originId));
      return !a.deleted && (inLote || String(a?.lote || "") === String(originId));
    }).map(normalizeAnimal);
    renderTable(refreshed);
    updateTransferirButton();
  });

  if (modalOverlay) {
    modalOverlay.addEventListener("click", (e) => {
      if (e.target === modalOverlay) closeTransferModal();
    });
  }

  // ========== MOVIMENTAÇÃO ENTRE FAZENDAS ==========
  const btnTransferirFazendas = container.querySelector("#movBtnTransferirFazendas");
  const fazendaOrigemNome = container.querySelector("#movFazendaOrigemNome");
  const toggleLoteOrigem = container.querySelector("#movToggleLoteOrigem");
  const togglePastoOrigem = container.querySelector("#movTogglePastoOrigem");
  const selLoteOrigemFazenda = container.querySelector("#movLoteOrigemFazenda");
  const selPastoOrigemFazenda = container.querySelector("#movPastoOrigemFazenda");
  const selFazendaDestino = container.querySelector("#movFazendaDestino");
  const toggleLoteDestino = container.querySelector("#movToggleLoteDestino");
  const togglePastoDestino = container.querySelector("#movTogglePastoDestino");
  const selLoteDestinoFazenda = container.querySelector("#movLoteDestinoFazenda");
  const selPastoDestinoFazenda = container.querySelector("#movPastoDestinoFazenda");
  const tbodyFazendas = container.querySelector("#movTableBodyFazendas");
  const selectAllFazendas = container.querySelector("#movSelectAllFazendas");

  let animaisFazendas = [];
  let selectedIdsFazendas = new Set();
  let origemTipo = "pasto"; // "lote" ou "pasto"
  let fazendaAtualId = "";
  let fazendaAtualNome = "";

  async function initMovimentacaoFazendas() {
    const owner = await idbGet("owner", "current");
    const fazendaAtual = await idbGet("fazenda", "current");
    const listFazendas = (await idbGet("fazenda", "list")) || [];
    
    fazendaAtualId = String(owner?.management_fazenda || state.ctx.fazendaId || fazendaAtual?._id || "").trim();
    fazendaAtualNome = fazendaAtual?.name || "Fazenda atual";
    
    if (fazendaOrigemNome) fazendaOrigemNome.textContent = fazendaAtualNome;

    const fazendasDestino = listFazendas.filter(f => String(f._id || "") !== fazendaAtualId);
    if (selFazendaDestino) {
      selFazendaDestino.innerHTML = '<option value="">Selecione a fazenda de destino</option>' +
        fazendasDestino.map(f => `<option value="${escapeHtml(f._id)}">${escapeHtml(f.name || "—")}</option>`).join("");
    }

    const fazendaAtualObj = listFazendas.find(f => String(f._id) === fazendaAtualId) || fazendaAtual;
    const lotesOrigem = Array.isArray(fazendaAtualObj?.list_lotes) ? fazendaAtualObj.list_lotes : [];
    const pastosOrigem = Array.isArray(fazendaAtualObj?.list_pasto) ? fazendaAtualObj.list_pasto : [];

    if (selLoteOrigemFazenda) {
      selLoteOrigemFazenda.innerHTML = '<option value="">Selecione o lote de origem</option>' +
        lotesOrigem.map(l => `<option value="${escapeHtml(l._id)}">${escapeHtml(l.nome_lote || "—")}</option>`).join("");
    }
    if (selPastoOrigemFazenda) {
      selPastoOrigemFazenda.innerHTML = '<option value="">Selecione o pasto de origem</option>' +
        pastosOrigem.map(p => `<option value="${escapeHtml(p._id)}">${escapeHtml(p.nome || "—")}</option>`).join("");
    }
  }

  function updateToggleButtons(origem) {
    if (origem) {
      toggleLoteOrigem?.classList.toggle("movToggleBtnActive", origemTipo === "lote");
      togglePastoOrigem?.classList.toggle("movToggleBtnActive", origemTipo === "pasto");
      selLoteOrigemFazenda && (selLoteOrigemFazenda.style.display = origemTipo === "lote" ? "block" : "none");
      selPastoOrigemFazenda && (selPastoOrigemFazenda.style.display = origemTipo === "pasto" ? "block" : "none");
      if (origemTipo === "lote") {
        selPastoOrigemFazenda && (selPastoOrigemFazenda.value = "");
      } else {
        selLoteOrigemFazenda && (selLoteOrigemFazenda.value = "");
      }
    } else {
      const loteAtivo = toggleLoteDestino?.classList.contains("movToggleBtnActive");
      const pastoAtivo = togglePastoDestino?.classList.contains("movToggleBtnActive");
      selLoteDestinoFazenda && (selLoteDestinoFazenda.style.display = loteAtivo ? "block" : "none");
      selPastoDestinoFazenda && (selPastoDestinoFazenda.style.display = pastoAtivo ? "block" : "none");
    }
    updateTransferirFazendasButton();
  }

  toggleLoteOrigem?.addEventListener("click", () => {
    origemTipo = "lote";
    selectedIdsFazendas.clear();
    renderTableFazendas([]);
    updateToggleButtons(true);
  });

  togglePastoOrigem?.addEventListener("click", () => {
    origemTipo = "pasto";
    selectedIdsFazendas.clear();
    renderTableFazendas([]);
    updateToggleButtons(true);
  });

  toggleLoteDestino?.addEventListener("click", () => {
    toggleLoteDestino.classList.add("movToggleBtnActive");
    togglePastoDestino?.classList.remove("movToggleBtnActive");
    updateToggleButtons(false);
  });

  togglePastoDestino?.addEventListener("click", () => {
    togglePastoDestino.classList.add("movToggleBtnActive");
    toggleLoteDestino?.classList.remove("movToggleBtnActive");
    updateToggleButtons(false);
  });

  async function loadAnimaisOrigem() {
    const origemId = origemTipo === "lote" 
      ? (selLoteOrigemFazenda?.value || "")
      : (selPastoOrigemFazenda?.value || "");
    
    if (!origemId) {
      renderTableFazendas([]);
      return;
    }

    const all = (await idbGet("animais", "list")) || [];
    let list = [];
    
    if (origemTipo === "lote") {
      list = all.filter(a => {
        if (a.deleted) return false;
        if (String(a.fazenda || "") !== fazendaAtualId) return false;
        const norm = normalizeAnimal(a);
        const inLote = norm.list_lotes && norm.list_lotes.some(lid => String(lid) === String(origemId));
        return inLote || String(a?.lote || "") === String(origemId);
      }).map(normalizeAnimal);
    } else {
      list = all.filter(a => {
        if (a.deleted) return false;
        if (String(a.fazenda || "") !== fazendaAtualId) return false;
        return String(a?.pasto || "") === String(origemId);
      }).map(normalizeAnimal);
    }
    
    renderTableFazendas(list);
  }

  selLoteOrigemFazenda?.addEventListener("change", loadAnimaisOrigem);
  selPastoOrigemFazenda?.addEventListener("change", loadAnimaisOrigem);

  selFazendaDestino?.addEventListener("change", async () => {
    const fazendaDestinoId = selFazendaDestino?.value || "";
    if (!fazendaDestinoId) {
      selLoteDestinoFazenda && (selLoteDestinoFazenda.innerHTML = '<option value="">Selecione o lote de destino</option>');
      selPastoDestinoFazenda && (selPastoDestinoFazenda.innerHTML = '<option value="">Selecione o pasto de destino</option>');
      updateTransferirFazendasButton();
      return;
    }

    const listFazendas = (await idbGet("fazenda", "list")) || [];
    const fazendaDestino = listFazendas.find(f => String(f._id) === fazendaDestinoId);
    
    if (fazendaDestino) {
      const lotesDestino = Array.isArray(fazendaDestino.list_lotes) ? fazendaDestino.list_lotes : [];
      const pastosDestino = Array.isArray(fazendaDestino.list_pasto) ? fazendaDestino.list_pasto : [];
      
      if (selLoteDestinoFazenda) {
        selLoteDestinoFazenda.innerHTML = '<option value="">Selecione o lote de destino</option>' +
          lotesDestino.map(l => `<option value="${escapeHtml(l._id)}">${escapeHtml(l.nome_lote || "—")}</option>`).join("");
      }
      if (selPastoDestinoFazenda) {
        selPastoDestinoFazenda.innerHTML = '<option value="">Selecione o pasto de destino</option>' +
          pastosDestino.map(p => `<option value="${escapeHtml(p._id)}">${escapeHtml(p.nome || "—")}</option>`).join("");
      }
    }
    updateTransferirFazendasButton();
  });

  selLoteDestinoFazenda?.addEventListener("change", updateTransferirFazendasButton);
  selPastoDestinoFazenda?.addEventListener("change", updateTransferirFazendasButton);

  function renderTableFazendas(animais) {
    if (!tbodyFazendas) return;
    animaisFazendas = animais;
    tbodyFazendas.innerHTML = "";
    if (animais.length === 0) {
      tbodyFazendas.innerHTML = '<tr><td colspan="5" class="movTableEmpty">Nenhum animal encontrado.</td></tr>';
      if (selectAllFazendas) selectAllFazendas.checked = false;
      selectedIdsFazendas.clear();
      updateTransferirFazendasButton();
      return;
    }
    animais.forEach(a => {
      const tr = document.createElement("tr");
      tr.dataset.id = a._id || "";
      const id = String(a._id || "");
      const checked = selectedIdsFazendas.has(id);
      tr.innerHTML = `
        <td class="movTdCheck"><label class="movCheckWrap"><input type="checkbox" class="movRowCheck movRowCheckFazendas" data-id="${escapeHtml(id)}" ${checked ? "checked" : ""} /><span class="movCheckbox"></span></label></td>
        <td>${escapeHtml(a?.brinco_padrao || "—")}</td>
        <td>${escapeHtml(renderSex(a?.sexo))}</td>
        <td>${escapeHtml(a?.raca || "—")}</td>
        <td>${escapeHtml(fmtKg(a?.peso_atual_kg))}</td>
      `;
      const cb = tr.querySelector(".movRowCheck");
      if (cb) {
        cb.addEventListener("change", () => {
          if (cb.checked) selectedIdsFazendas.add(id); else selectedIdsFazendas.delete(id);
          if (selectAllFazendas) selectAllFazendas.checked = selectedIdsFazendas.size === animais.length;
          updateTransferirFazendasButton();
        });
      }
      tbodyFazendas.appendChild(tr);
    });
    if (selectAllFazendas) selectAllFazendas.checked = selectedIdsFazendas.size === animais.length;
    updateTransferirFazendasButton();
  }

  selectAllFazendas?.addEventListener("change", () => {
    if (selectAllFazendas.checked) animaisFazendas.forEach(a => selectedIdsFazendas.add(String(a._id)));
    else selectedIdsFazendas.clear();
    tbodyFazendas?.querySelectorAll(".movRowCheckFazendas").forEach(cb => { cb.checked = selectAllFazendas.checked; });
    updateTransferirFazendasButton();
  });

  function updateTransferirFazendasButton() {
    const fazendaDestinoId = selFazendaDestino?.value || "";
    const loteDestinoId = selLoteDestinoFazenda?.value || "";
    const pastoDestinoId = selPastoDestinoFazenda?.value || "";
    const hasDestino = !!fazendaDestinoId && (!!loteDestinoId || !!pastoDestinoId);
    const canTransfer = hasDestino && selectedIdsFazendas.size > 0;
    if (btnTransferirFazendas) {
      btnTransferirFazendas.classList.toggle("movBtnTransferir--disabled", !canTransfer);
      btnTransferirFazendas.setAttribute("aria-disabled", canTransfer ? "false" : "true");
    }
  }
  updateTransferirFazendasButton();

  btnTransferirFazendas?.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    
    const fazendaDestinoId = selFazendaDestino?.value || "";
    const loteDestinoId = selLoteDestinoFazenda?.value || "";
    const pastoDestinoId = selPastoDestinoFazenda?.value || "";
    const selected = animaisFazendas.filter(a => selectedIdsFazendas.has(String(a._id)));
    
    if (!fazendaDestinoId || selected.length === 0 || (!loteDestinoId && !pastoDestinoId)) {
      toast("Selecione pelo menos um animal, a fazenda de destino e um lote ou pasto.");
      return;
    }

    const listFazendas = (await idbGet("fazenda", "list")) || [];
    const fazendaDestino = listFazendas.find(f => String(f._id) === fazendaDestinoId);
    const origemNome = origemTipo === "lote" 
      ? (lotes.find(l => String(l._id) === selLoteOrigemFazenda?.value)?.nome_lote || "—")
      : (pastos.find(p => String(p._id) === selPastoOrigemFazenda?.value)?.nome || "—");
    
    let destinoNome = fazendaDestino?.name || "—";
    if (loteDestinoId) {
      const loteDestino = fazendaDestino?.list_lotes?.find(l => String(l._id) === loteDestinoId);
      destinoNome += ` - ${loteDestino?.nome_lote || "Lote"}`;
    }
    if (pastoDestinoId) {
      const pastoDestino = fazendaDestino?.list_pasto?.find(p => String(p._id) === pastoDestinoId);
      destinoNome += ` - ${pastoDestino?.nome || "Pasto"}`;
    }

    const modalOrigem = container.querySelector("#movModalOrigem");
    const modalDestino = container.querySelector("#movModalDestino");
    const countEl = container.querySelector("#movModalAnimaisCount");
    const listEl = container.querySelector("#movModalAnimais");
    if (modalOrigem) modalOrigem.textContent = `${fazendaAtualNome} - ${origemNome}`;
    if (modalDestino) modalDestino.textContent = destinoNome;
    if (countEl) countEl.textContent = selected.length;
    if (listEl) {
      listEl.innerHTML = selected.map(a => {
        const tag = escapeHtml(a?.brinco_padrao || "—");
        const name = escapeHtml((a?.nome_completo || "").trim() || "—");
        const raca = escapeHtml(a?.raca || "—");
        const peso = escapeHtml(fmtKg(a?.peso_atual_kg));
        const sexo = escapeHtml(renderSex(a?.sexo));
        return `<div class="movModalAnimalRow">
          <div class="movModalAnimalId">#${tag} ${name !== "—" ? name : ""}</div>
          <span class="movModalAnimalRaca">${raca}</span>
          <span class="movModalAnimalPeso">${peso}</span>
          <span class="movModalAnimalSexo">${sexo}</span>
        </div>`;
      }).join("");
    }
    if (modalOverlay) {
      modalOverlay.dataset.context = "fazendas";
      modalOverlay.dataset.fazendaDestinoId = fazendaDestinoId;
      modalOverlay.dataset.loteDestinoId = loteDestinoId || "";
      modalOverlay.dataset.pastoDestinoId = pastoDestinoId || "";
      modalOverlay.style.display = "flex";
    }
  });

  modalConfirmar?.addEventListener("click", async () => {
    const context = modalOverlay?.dataset.context;
    if (context !== "fazendas") return;

    const fazendaDestinoId = modalOverlay?.dataset.fazendaDestinoId || "";
    const loteDestinoId = modalOverlay?.dataset.loteDestinoId || "";
    const pastoDestinoId = modalOverlay?.dataset.pastoDestinoId || "";
    const selected = animaisFazendas.filter(a => selectedIdsFazendas.has(String(a._id)));

    if (!fazendaDestinoId || selected.length === 0) {
      closeTransferModal();
      if (modalOverlay) delete modalOverlay.dataset.context;
      return;
    }

    const list = (await idbGet("animais", "list")) || [];
    const ids = new Set(selected.map(a => String(a._id)));
    const qKey = `queue:${fazendaDestinoId}:${state.ctx.ownerId || ""}:animal`;
    const queue = (await idbGet("records", qKey)) || [];

    for (let i = 0; i < list.length; i++) {
      if (!ids.has(String(list[i]._id))) continue;
      const prev = list[i];
      const listLotesNovo = loteDestinoId ? [loteDestinoId] : [];
      const pastoNovo = pastoDestinoId || "";
      
      const updated = normalizeAnimal({
        ...prev,
        fazenda: fazendaDestinoId,
        list_lotes: listLotesNovo,
        lote: loteDestinoId || "",
        pasto: pastoNovo,
        _local: prev._local || true,
        _sync: "pending",
        data_modificacao: prev.data_modificacao,
      });
      list[i] = updated;
      queue.push({ op: "animal_update", at: Date.now(), payload: updated, targetId: prev._id });
    }

    await idbSet("animais", "list", list);
    await idbSet("records", qKey, queue);

    closeTransferModal();
    if (modalOverlay) delete modalOverlay.dataset.context;
    toast("Transferência entre fazendas registrada offline. " + selected.length + " animal(is) na fila para sincronizar.");

    selectedIdsFazendas.clear();
    await loadAnimaisOrigem();
    updateTransferirFazendasButton();
    updateFabSyncVisibility();
  });

  await initMovimentacaoFazendas();
}

// ---------------- Saída de Animais (módulo) ----------------
const SAIDA_ANIMAIS_TABS = [
  { id: "venda", label: "Venda", title: "Saída por venda de animais", sub: "Crie e gerencie as vendas de animais da sua fazenda", btnNew: "Nova venda" },
  { id: "morte", label: "Morte", title: "Saída por morte de animais", sub: "Registre óbitos dos animais da sua fazenda", btnNew: "Nova morte" },
  { id: "emprestimo", label: "Empréstimo", title: "Saída por empréstimo", sub: "Registre empréstimos de animais da sua fazenda", btnNew: "Novo empréstimo" },
  { id: "ajuste", label: "Ajuste inventário", title: "Ajuste de inventário", sub: "Ajustes de inventário de animais", btnNew: "Novo ajuste" },
  { id: "doacao", label: "Doação", title: "Saída por doação", sub: "Registre doações de animais da sua fazenda", btnNew: "Nova doação" }
];

async function renderSaidaAnimaisModule(container) {
  if (!container) return;

  container.hidden = false;
  const tabsHtml = SAIDA_ANIMAIS_TABS.map((tab, i) =>
    `<button type="button" class="saTab ${i === 0 ? "active" : ""}" data-tab="${tab.id}" role="tab">${escapeHtml(tab.label)}</button>`
  ).join("");
  const contentsHtml = SAIDA_ANIMAIS_TABS.map((tab, i) => `
    <div class="saContent saTabContent" id="saContent${tab.id}" ${i > 0 ? "hidden" : ""}>
      <h2 class="saTitle">${escapeHtml(tab.title)}</h2>
      <p class="saSub">${escapeHtml(tab.sub)}</p>
      <div class="saActionBar">
        <div class="saSearchWrap">
          <span class="saSearchIcon" aria-hidden="true">&#128269;</span>
          <input type="text" class="saSearch" placeholder="Buscar" aria-label="Buscar" />
        </div>
        <button type="button" class="btn primary saBtnNew" data-tab="${tab.id}" aria-label="${escapeHtml(tab.btnNew)}">
          <span class="saBtnNewIcon" aria-hidden="true">+</span> ${escapeHtml(tab.btnNew)}
        </button>
        <button type="button" class="saFilterBtn" aria-label="Filtros" title="Filtros">
          <svg class="saFilterIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h10M4 18h7"/></svg>
        </button>
      </div>
      <div class="saCard saEmptyState">
        <div class="saEmptyIcon" aria-hidden="true">🔍</div>
        <p class="saEmptyTitle">Nenhum resultado encontrado</p>
        <p class="saEmptySub">Sua busca não encontrou nenhum resultado. Tente novamente ou adicione um novo item.</p>
        <button type="button" class="btn primary saBtnNew saBtnNewCenter" data-tab="${tab.id}">
          <span class="saBtnNewIcon" aria-hidden="true">+</span> ${escapeHtml(tab.btnNew)}
        </button>
      </div>
    </div>
  `).join("");

  container.innerHTML = `
    <div class="saPage">
      <div class="saTabs" role="tablist">
        ${tabsHtml}
      </div>
      ${contentsHtml}
    </div>
  `;

  const saTabs = container.querySelectorAll(".saTab");
  const saContents = container.querySelectorAll(".saContent");

  container.querySelectorAll(".saTab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.dataset.tab;
      saTabs.forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      saContents.forEach((c) => {
        const isTarget = c.id === "saContent" + tabId;
        c.hidden = !isTarget;
      });
    });
  });

  container.querySelectorAll(".saBtnNew, .saBtnNewCenter").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.dataset.tab;
      const tab = SAIDA_ANIMAIS_TABS.find((t) => t.id === tabId);
      if (tab) toast(`Em breve: ${tab.btnNew}`);
    });
  });
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
      const opType = op?.op || "animal_update";
      let label = opType === "animal_create" ? "Novo animal" : "Atualização de animal";
      if (opType === "animal_update" && isTransfer) label = "Transferência entre fazendas";
      const payload = op?.payload || {};
      let oldAnimal = null;
      if (opType === "animal_update" && (op.targetId || payload._id)) {
        const animalId = op.targetId || payload._id;
        oldAnimal = animaisList.find(a => String(a?._id) === String(animalId));
      }
      const nome = String(payload.nome_completo || (oldAnimal && oldAnimal.nome_completo) || "").trim();
      const brinco = String(payload.brinco || payload.brinco_padrao || (oldAnimal && (oldAnimal.brinco || oldAnimal.brinco_padrao)) || "").trim();
      const detail = nome || brinco || "—";
      items.push({
        queueOrder: globalIndex++,
        queueKey: qKey,
        queueIndex: i,
        op: opType,
        label,
        detail
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
  if (title) title.textContent = `${group.label} (${group.items.length})`;
  if (body) {
    body.innerHTML = group.items.map((item, i) =>
      `<div class="dashPendingSyncModalItem"><span class="dashPendingSyncModalItemNum">${i + 1}</span><span class="dashPendingSyncModalItemText">${escapeHtml(item.detail)}</span></div>`
    ).join("");
  }
  overlay.style.display = "flex";
}

/** Renderiza apenas o card de pendências (lista agrupada + paginação), usado ao trocar de página. */
function renderPendingSyncCard() {
  const list = state.pendingSyncListForCard || [];
  const groups = groupPendingSyncByLabel(list);
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
    `<div class="dashPendingSyncItem dashPendingSyncGroupRow" data-group-index="${groupIndex}" role="button" tabindex="0"><span class="dashPendingSyncOrder">${displayIndex}</span><span class="dashPendingSyncLabel">${escapeHtml(group.label)}</span><span class="dashPendingSyncDetail">${group.items.length} item(ns)</span></div>`;

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
    // Fallback: try to find in list_proprietarios
    const ownerId = state.ctx.ownerId;
    const owners = (await idbGet("fazenda", "list_proprietarios")) || [];
    owner = owners.find(o => String(o._id) === String(ownerId));
  }

  const name = owner?.nome || "Usuário";
  const firstLetter = name.charAt(0).toUpperCase();

  const elName = $("#dashName");
  const elAvatar = $("#dashAvatar");

  // Check for pending sync items to show indicator in header (apenas fazenda atual)
  const allAnimaisRaw = (await idbGet("animais", "list")) || [];
  const allAnimais = filterByCurrentFazenda(allAnimaisRaw);
  const hasPending = allAnimais.some(a => a._sync === "pending");

  if (elName) {
    elName.innerHTML = escapeHtml(name) + (hasPending ? " <span style='font-size:13px; vertical-align:middle' title='Dados pendentes'>☁️</span>" : "");
  }
  if (elAvatar) {
    elAvatar.textContent = firstLetter;
    // Atualiza status da bolinha baseado no status online/offline
    const online = navigator.onLine;
    if (online) {
      elAvatar.classList.remove("offline");
    } else {
      elAvatar.classList.add("offline");
    }
  }

  // Atualiza bloco do usuário no sidebar (desktop)
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
  if (pendingList.length > 0) {
    if (wrapMobile) wrapMobile.style.display = "block";
    if (wrapDesktop) wrapDesktop.style.display = "block";
    renderPendingSyncCard();
  } else {
    state.pendingSyncPage = 0;
    if (wrapMobile) { wrapMobile.style.display = "none"; document.getElementById("dashPendingSyncList") && (document.getElementById("dashPendingSyncList").innerHTML = ""); }
    if (wrapDesktop) { wrapDesktop.style.display = "none"; document.getElementById("dashPendingSyncListDesktop") && (document.getElementById("dashPendingSyncListDesktop").innerHTML = ""); }
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

  const loteAggAll = lotesList
    .map(l => {
      const loteId = String(l._id || "");
      const noLote = activeAnimais.filter(a => {
        const norm = normalizeAnimal(a);
        const inList = norm.list_lotes && norm.list_lotes.some(lid => String(lid) === loteId);
        return inList || String(a?.lote || "") === loteId;
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

  // Esconde containers de módulos de animais para garantir que não apareçam junto com o dashboard
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

  // Atualiza sidebar para marcar "Início" como ativo
  renderSidebar();

  // Atualiza visibilidade do FAB Sync
  updateFabSyncVisibility();

  // Salva estado de navegação
  await saveNavigationState();
}

async function openModule(moduleKey) {
  state.activeKey = moduleKey;
  state.view = "module";
  if (moduleKey === "animal") {
    state.animalView = "list";
    state.animalEditingId = null;
  }

  renderSidebar();
  updateFabSyncVisibility();

  const dash = $("#modDashboard");
  if (dash) dash.hidden = true;
  const dashDesktop = document.getElementById("modDashboardDesktop");
  if (dashDesktop) dashDesktop.hidden = true;

  await renderActiveModule();

  // Salva estado de navegação
  await saveNavigationState();
}

// Controla visibilidade do FAB Sync baseado na página atual
function updateFabSyncVisibility() {
  const btn = document.getElementById("fabSync");
  if (!btn) return;

  // Mostra o FAB Sync no dashboard e no módulo Movimentações (entre lotes/pastos/fazendas)
  // NÃO mostra no módulo animal (nem na listagem, nem nos formulários)
  const isDashboard = state.view === "dashboard";
  const isLotesModule = state.view === "module" && state.activeKey === "movimentacao";
  const isAnimalModule = state.activeKey === "animal" || (state.view === "module" && state.activeKey === "animal");
  const canShowFab = (isDashboard || isLotesModule) && !isAnimalModule;

  if (!canShowFab) {
    btn.hidden = true;
    btn.style.display = "none";
    btn.style.visibility = "hidden";
    return;
  }

  // Verifica pendências e mostra/esconde o botão
  checkSyncStatus();
}

async function checkSyncStatus() {
  const btn = document.getElementById("fabSync");
  if (!btn) return;

  // Mostra no dashboard ou no módulo Movimentações. Esconde no módulo animal.
  const isDashboard = state.view === "dashboard";
  const isLotesModule = state.view === "module" && state.activeKey === "movimentacao";
  const isAnimalModule = state.activeKey === "animal" || (state.view === "module" && state.activeKey === "animal");
  const canShowFab = (isDashboard || isLotesModule) && !isAnimalModule;

  if (!canShowFab) {
    btn.hidden = true;
    btn.style.display = "none";
    btn.style.visibility = "hidden";
    btn.style.opacity = "0";
    btn.style.pointerEvents = "none";
    return;
  }

  if (!navigator.onLine) {
    btn.hidden = true;
    btn.style.display = "none";
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

    // Mostra se tiver pendências (em qualquer fila, inclusive transferência entre fazendas)
    if (hasPending) {
      btn.hidden = false;
      btn.style.display = "flex";
      btn.style.visibility = "visible";
      btn.style.opacity = "1";
      btn.style.pointerEvents = "auto";
      playSyncAvailableSound();
    } else {
      resetSyncNotifySound();
      btn.hidden = true;
      btn.style.display = "none";
      btn.style.visibility = "hidden";
      btn.style.opacity = "0";
      btn.style.pointerEvents = "none";
    }
  } catch (e) {
    console.error("[checkSyncStatus] Error:", e);
    btn.hidden = true;
    btn.style.display = "none";
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

/** Aplica resultado da sincronização (resultados) aos animais locais e atualiza UI. */
async function applySyncResult(result, qKey) {
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
  const pendingQKeysJson = await idbGet("meta", "sync_pending_qKeys");
  if (pendingQKeysJson) {
    try {
      const keysToDelete = JSON.parse(pendingQKeysJson);
      if (Array.isArray(keysToDelete)) {
        for (const k of keysToDelete) await idbDel("records", k);
      }
    } catch (_) {}
    await idbDel("meta", "sync_pending_qKeys");
  } else {
    await idbDel("records", qKey);
  }
  await idbDel("meta", "sync_pending_id");
  await idbDel("meta", "sync_pending_qKey");
  resetSyncNotifySound();
  await openDashboard();
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
        // Converte "dados" para o formato esperado por applySyncResult (resultados)
        const resultados = dados.map(item => {
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

        // update_fazenda_new: list_lotes e pasto devem ser apenas os novos valores da nova fazenda (nada da fazenda antiga)
        if (dadosOp === "update_fazenda_new") {
          payload.list_lotes = Array.isArray(payload.list_lotes) ? payload.list_lotes : [];
          payload.pasto = String(payload.pasto || "").trim();
          payload.lote = payload.list_lotes.length > 0 ? payload.list_lotes[0] : "";
        }
        
        // Remove apenas campos de sincronização local; preserva data_modificacao para o servidor comparar
        delete payload._local;
        delete payload._sync;
        
        const operacao = {
          op: op.op,
          data_hora: op.at || Date.now(),
          payload: payload
        };
        
        // Para UPDATE, adiciona targetId
        if (op.op === "animal_update" && op.targetId) {
          operacao.targetId = op.targetId;
        }
        
        return operacao;
  });
}

/** Envia um payload de sincronização e trata resposta (síncrona ou assíncrona). Retorna true se iniciou polling. */
async function sendSyncPayload(syncPayload, qKey, qKeysToDeleteForApply = null) {
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
  return false;
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
    const managementFazendaId = (org?.user?.management_fazenda && String(org.user.management_fazenda).trim()) || "";
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
    const userId = state.ctx.ownerId || "";

    // ---------- Fase 1: tudo da fazenda atual em um único disparo ----------
    if (currentFarmKeys.length > 0) {
      showSyncProgress(15, "Carregando alterações da fazenda atual...");
      const allOperacoes = [];
      const keysWithData = [];
      for (const qKey of currentFarmKeys) {
        const queue = await idbGet("records", qKey);
        if (!Array.isArray(queue) || queue.length === 0) {
          await idbDel("records", qKey);
          continue;
        }
        const operacoes = buildOperacoesFromQueue(queue, "update_fazenda_old");
        allOperacoes.push(...operacoes);
        keysWithData.push(qKey);
      }
      if (allOperacoes.length > 0) {
        const pastosDaFazenda = Array.isArray(pastosListRaw)
          ? pastosListRaw.filter((p) => String(p?.fazenda || "") === String(currentFazendaId))
          : [];
        const syncPayload = {
          dados: {
            op: "update_fazenda_old",
            fazenda_id: currentFazendaId,
            user_id: userId,
            timestamp: Date.now(),
            qtd_itens: allOperacoes.length,
            operacoes: allOperacoes,
            list_pasto: pastosDaFazenda
          }
        };
        showSyncProgress(40, "Enviando alterações da fazenda atual...");
        const startedPolling = await sendSyncPayload(syncPayload, keysWithData[0], keysWithData);
        if (startedPolling) {
          await startPollSyncStatus(await idbGet("meta", "sync_pending_id"), keysWithData[0]);
          if (btn) restoreFabSyncIcon();
          // Se ainda há transferências pendentes, continua para a Fase 2; senão encerra
          if (transferKeys.length === 0) {
            showSyncProgress(100, "Concluído!");
            setTimeout(hideSyncProgress, 500);
            resetSyncNotifySound();
            toast("Sincronização concluída! ✅");
            return;
          }
          showSyncProgress(45, "Fazenda atual sincronizada. Enviando transferências...");
        }
        // Chaves já removidas por applySyncResult quando resposta síncrona
      }
    }

    // ---------- Fase 2: cada transferência entre fazendas em disparo separado (espera um terminar para enviar o próximo) ----------
    for (let i = 0; i < transferKeys.length; i++) {
      const qKey = transferKeys[i];
      showSyncProgress(50 + (i / Math.max(1, transferKeys.length)) * 25, `Processando transferência ${i + 1}/${transferKeys.length}...`);
      const queue = await idbGet("records", qKey);
      if (!Array.isArray(queue) || queue.length === 0) {
        await idbDel("records", qKey);
        continue;
      }
      const parts = qKey.split(":");
      const fazendaId = parts[1] || state.ctx.fazendaId;
      const userIdFazenda = parts[2] || state.ctx.ownerId || "";
      const operacoes = buildOperacoesFromQueue(queue, "update_fazenda_new");
      const pastosDaFazenda = Array.isArray(pastosListRaw)
        ? pastosListRaw.filter((p) => String(p?.fazenda || "") === String(fazendaId))
        : [];
      const syncPayload = {
        dados: {
          op: "update_fazenda_new",
          fazenda_id: fazendaId,
          user_id: userIdFazenda,
          timestamp: Date.now(),
          qtd_itens: operacoes.length,
          operacoes,
          list_pasto: pastosDaFazenda
        }
      };
      showSyncProgress(75, "Enviando transferência entre fazendas...");
      const startedPolling = await sendSyncPayload(syncPayload, qKey, null);
      if (startedPolling) {
        await startPollSyncStatus(await idbGet("meta", "sync_pending_id"), qKey);
      }
    }

    showSyncProgress(100, "Concluído!");
    setTimeout(hideSyncProgress, 500);
    resetSyncNotifySound();
    toast("Sincronização concluída! ✅");
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
  window.addEventListener("online", () => { setNetBadge(); updateFabSyncVisibility(); });
  window.addEventListener("offline", () => { setNetBadge(); updateFabSyncVisibility(); });

  const parsed = await parseFromURL();

  if (parsed.fazendaId && parsed.ownerId) {
    await idbSet("meta", "session_config", {
      modules: parsed.modules,
      ctx: { fazendaId: parsed.fazendaId, ownerId: parsed.ownerId },
      updatedAt: Date.now()
    });
    const newUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, document.title, newUrl);

    state.ctx = { fazendaId: parsed.fazendaId, ownerId: parsed.ownerId };
    state.modules = buildModules(parsed.modules);
  } else {
    const saved = await idbGet("meta", "session_config");
    if (saved && saved.ctx && saved.modules) {
      state.ctx = saved.ctx;
      state.modules = buildModules(saved.modules);
    } else {
      state.ctx = { fazendaId: "", ownerId: "" };
      state.modules = buildModules(["animal"]);
    }
  }

  // Setup Sidebar (desktop: Início + módulos + usuário)
  renderSidebar();

  const dashDesktopCta = document.getElementById("dashDesktopCta");
  if (dashDesktopCta) {
    dashDesktopCta.onclick = async () => {
      await openModule("animal");
      state.animalView = "form";
      state.animalEditingId = null;
      await renderActiveModule();
      await openAnimalFormForCreate();
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

  // Restaura estado de navegação salvo
  const restored = await restoreNavigationState();
  
  if (restored && state.view && state.bootstrapReady) {
    // Restaura a navegação salva
    if (state.view === "dashboard") {
      await openDashboard();
    } else if (state.view === "module" && state.activeKey) {
      // Restaura o módulo ativo (esconde dashboard mobile e desktop)
      state.view = "module";
      const dash = $("#modDashboard");
      if (dash) dash.hidden = true;
      const dashDesktop = document.getElementById("modDashboardDesktop");
      if (dashDesktop) dashDesktop.hidden = true;

      await renderActiveModule();
      
      // Se for módulo de animais e estava em form, restaura
      if (state.activeKey === "animal" && state.animalView === "form") {
        if (state.animalEditingId) {
          await openAnimalFormForEdit(state.animalEditingId);
        } else {
          await openAnimalFormForCreate();
        }
      }
      renderSidebar();
    } else {
      // Fallback para dashboard se estado inválido
      await openDashboard();
    }
  } else {
    // START AT DASHBOARD (primeira vez ou sem estado salvo)
    await openDashboard();
  }

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
