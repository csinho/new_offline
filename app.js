import { idbGet, idbSet, idbClear, idbDel } from "./idb.js";

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
};

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
  const dot = $("#netDot");
  const lbl = $("#netLabel");
  if (dot) dot.style.background = online ? "#22c55e" : "#ef4444";
  if (lbl) lbl.textContent = online ? "online" : "offline";
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

function hideBoot() {
  const o = $("#bootOverlay");
  if (!o) return;
  o.style.display = "none";
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

// ---------------- URL / modules ----------------
const MODULE_CATALOG = {
  animal_create: {
    key: "animal_create",
    label: "Animais",
    icon: "🐮", // Added icon
    pageTitle: "Animais",
    pageSub: "Gerencie todos os seus animais com facilidade",
    storageKey: "animais", // store do IDB
  },
  vaccine: {
    key: "vaccine",
    label: "Vacinação",
    icon: "💉",
    pageTitle: "Vacinação",
    pageSub: "Registre vacinas offline",
    storageKey: "vacinacao",
  },
  lotes: {
    key: "lotes",
    label: "Lotes",
    icon: "📦",
    pageTitle: "Gerenciar Lotes",
    pageSub: "Organize seus animais em lotes",
    storageKey: "lotes",
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

function parseFromURL() {
  const u = new URL(location.href);
  const rawModules = (u.searchParams.get("modules") || "").trim();
  const modules = rawModules.split(",").map((s) => s.trim()).filter(Boolean);
  const fazendaId = (u.searchParams.get("fazenda") || "").trim();
  const ownerId = (u.searchParams.get("owner") || "").trim();

  return {
    modules: modules.length ? modules : ["animal_create"],
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
function getEndpointUrl({ fazendaId, ownerId }) {
  // Pode trocar por env/config depois
  const base = "https://app.bovichain.com/version-0342o/api/1.1/wf/get_dados";
  const u = new URL(base);
  u.searchParams.set("fazenda", fazendaId);
  u.searchParams.set("owner", ownerId);
  return u.toString();
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
  out.data_nascimento = out.data_nascimento ? String(out.data_nascimento) : "";

  // flags
  out.deleted = !!out.deleted;
  out.ativo = out.ativo !== false;
  out.morto = !!out.morto;

  // Preserva flags de sincronização local
  if (a._local !== undefined) out._local = a._local;
  if (a._sync !== undefined) out._sync = String(a._sync || "");

  // números
  out.peso_atual_kg = toNumberOrZero(out.peso_atual_kg);
  out.peso_nascimento = toNumberOrZero(out.peso_nascimento);

  // listas
  if (!Array.isArray(out.list_lotes)) out.list_lotes = [];
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
      "Use: ?modules=animal_create&fazenda=<id>&owner=<id>"
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

    // Normaliza
    const fazendaRaw = data?.fazenda || null;
    const ownerRaw = data?.owner || null;

    const animaisRaw = fazendaRaw?.list_animais || [];
    const lotesRaw = fazendaRaw?.list_lotes || [];
    const vacinacaoRaw = fazendaRaw?.list_vacinacao || [];
    const proprietariosRaw = fazendaRaw?.list_proprietarios || [];

    // ✅ Sanitiza/clone-safe (evita DataCloneError / undefined etc)
    const fazenda = toCloneable(fazendaRaw);
    const owner = toCloneable(ownerRaw);

    // normaliza listas
    const animaisServidor = toCloneable(
      (Array.isArray(animaisRaw) ? animaisRaw : []).map(normalizeAnimal)
    );
    
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
    
    // Mescla: animais do servidor + animais locais pendentes
    // Remove duplicatas baseado no _id (prioriza servidor se houver conflito)
    const animaisMap = new Map();
    
    // Primeiro adiciona animais do servidor (exceto os que têm IDs locais)
    animaisServidor.forEach(a => {
      if (a?._id) {
        const id = String(a._id);
        // Só adiciona animais do servidor que não são locais
        if (!id.startsWith("local:")) {
          animaisMap.set(id, a);
        }
      }
    });
    
    // Depois adiciona TODOS os animais locais pendentes (sempre preserva)
    // Isso garante que animais criados localmente nunca sejam perdidos
    animaisLocaisPendentes.forEach(a => {
      const id = String(a?._id || "");
      if (id) {
        // Animais locais sempre são adicionados, mesmo que já exista no servidor
        // porque são versões locais pendentes de sincronização
        animaisMap.set(id, a);
      }
    });
    
    // Garante que animais locais pendentes sejam preservados
    const animaisFinal = Array.from(animaisMap.values());
    
    // Verifica se todos os animais locais pendentes foram preservados
    const idsLocaisPendentes = new Set(animaisLocaisPendentes.map(a => String(a?._id || "")));
    const idsFinais = new Set(animaisFinal.map(a => String(a?._id || "")));
    const todosPreservados = Array.from(idsLocaisPendentes).every(id => idsFinais.has(id));
    
    if (!todosPreservados) {
      console.warn("[BOOT] Alguns animais locais pendentes não foram preservados!");
    }
    
    // IMPORTANTE: Normaliza os animais locais pendentes ANTES de aplicar toCloneable
    // Isso garante que _local e _sync sejam preservados
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
    
    const lotes = toCloneable(
      (Array.isArray(lotesRaw) ? lotesRaw : []).map(normalizeLote)
    );
    const vacinacao = toCloneable(Array.isArray(vacinacaoRaw) ? vacinacaoRaw : []);
    const proprietarios = toCloneable(Array.isArray(proprietariosRaw) ? proprietariosRaw : []);

    // ✅ Gravação com debug por etapa (pra não “sumir” o erro)
    try {
      await idbSet("fazenda", "current", fazenda);
      await idbSet("owner", "current", owner);
      await idbSet("animais", "list", animais);
      
      // Verifica se foi salvo corretamente
      const verificaSalvamento = await idbGet("animais", "list");
      
      const animaisLocaisSalvos = Array.isArray(verificaSalvamento) 
        ? verificaSalvamento.filter(a => {
            const id = String(a?._id || "").toLowerCase();
            const isLocal = a?._local === true || id.startsWith("local:");
            const isPending = String(a?._sync || "").toLowerCase() === "pending";
            return isLocal && isPending;
          })
        : [];
      
      await idbSet("lotes", "list", lotes);
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

  for (const m of state.modules) {
    const item = document.createElement("div");
    item.className = "navItem" + (m.key === state.activeKey ? " active" : "");
    item.innerHTML = `<span class="navIcon"></span><span>${escapeHtml(m.label)}</span>`;
    item.onclick = async () => {
      state.activeKey = m.key;

      // reset view do módulo animais ao trocar de módulo
      if (m.key === "animal_create") {
        state.animalView = "list";
        state.animalEditingId = null;
      }

      renderSidebar();
      await renderActiveModule();
    };
    nav.appendChild(item);
  }
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
  if (!iso) return "";
  // se já for yyyy-mm-dd, retorna
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function dateInputToISO(dateStr) {
  if (!dateStr) return "";
  // salva como ISO Z meia-noite local
  const d = new Date(dateStr + "T03:00:00.000Z"); // mantém seu padrão BR (-03)
  if (Number.isNaN(d.getTime())) return "";
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

  const all = (await idbGet("animais", "list")) || [];
  const searchEl = $("#animalSearch");
  const cardsList = $("#animalCardsList");

  if (!cardsList) {
    // Tenta novamente após um pequeno delay se não encontrou
    setTimeout(async () => {
      const retryCardsList = $("#animalCardsList");
      if (retryCardsList) {
        await renderAnimalList();
      }
    }, 100);
    return;
  }

  const q = normText(searchEl ? searchEl.value : "");

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
          <p style="font-size: 16px; font-weight: 600;">Nenhum animal encontrado</p>
          <p style="font-size: 14px; margin-top: 8px;">Tente ajustar sua busca</p>
        </div>
      `;
    } else {
      for (const a of list) {
        const card = document.createElement("div");
        card.className = `animalCard ${a.sexo === "M" ? "male" : "female"}`;
        card.dataset.id = a._id || "";

        // Determina texto de detalhes (raça e peso)
        const raca = escapeHtml(a?.raca || "—");
        const peso = fmtKg(a?.peso_atual_kg);
        const details = `${raca} • ${peso}`;

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

  // Bind Search
  if (searchEl && !searchEl.__bound) {
    searchEl.__bound = true;
    searchEl.addEventListener("input", async () => {
      await renderAnimalList();
    });
  }

  // Bind Search Button
  const searchBtn = document.querySelector(".animalSearchBtn");
  if (searchBtn && !searchBtn.__bound) {
    searchBtn.__bound = true;
    searchBtn.onclick = async () => {
      await renderAnimalList();
    };
  }

  // Bind Create Animal Button
  const btnCreateAnimal = $("#btnCreateAnimal");
  if (btnCreateAnimal && !btnCreateAnimal.__bound) {
    btnCreateAnimal.__bound = true;
    btnCreateAnimal.addEventListener("click", async () => {
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
  const lote = $("#animalLote")?.value ?? "";
  const pasto = $("#animalPasto")?.value ?? "";
  const obs = $("#animalObs")?.value ?? "";

  // genealogia
  const maeCad = $("#maeCad")?.checked ? "1" : "0";
  const paiCad = $("#paiCad")?.checked ? "1" : "0";
  const mae = $("#animalMae")?.value ?? "";
  const pai = $("#animalPai")?.value ?? "";

  // aquisição
  const gta = $("#animalGta")?.value ?? "";
  const uf = $("#animalUf")?.value ?? "BA";

  // tipo entrada (chip ativo)
  const entry = document.querySelector("#tipoEntradaChips .chip.active")?.dataset?.value || "Compra";

  return {
    owner,
    entry_type: entry,
    animal_type: $("#animalTipo")?.value ?? "Físico",
    brinco_padrao: brinco,
    sexo,
    peso_atual_kg: toNumberOrZero(pesoAtual),
    data_nascimento: dateInputToISO(nasc),
    categoria,
    raca,

    nome_completo: nome,
    finalidade,
    peso_nascimento: toNumberOrZero(pesoNasc),
    sisbov,
    identificacao_eletronica: eletronica,
    rgd,
    rgn,
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

function writeAnimalFormByIds(data = {}) {
  const fazendaNome = $("#fazendaSelecionadaNome");
  if (fazendaNome) fazendaNome.textContent = ($("#farmCurrent")?.textContent || "—");

  if ($("#animalOwnerSelect")) $("#animalOwnerSelect").value = String(data.owner || "");
  if ($("#animalTipo")) $("#animalTipo").value = String(data.animal_type || "Físico");
  if ($("#animalBrinco")) $("#animalBrinco").value = String(data.brinco_padrao || "");
  if ($("#animalSexo")) $("#animalSexo").value = String(data.sexo || "");
  if ($("#animalPesoAtual")) $("#animalPesoAtual").value = String(toNumberOrZero(data.peso_atual_kg));
  if ($("#animalNasc")) $("#animalNasc").value = isoToDateInput(data.data_nascimento || "");
  if ($("#animalCategoria")) $("#animalCategoria").value = String(data.categoria || "");
  if ($("#animalRaca")) $("#animalRaca").value = String(data.raca || "");

  if ($("#animalNome")) $("#animalNome").value = String(data.nome_completo || "");
  if ($("#animalFinalidade")) $("#animalFinalidade").value = String(data.finalidade || "");
  if ($("#animalPesoNasc")) $("#animalPesoNasc").value = String(toNumberOrZero(data.peso_nascimento));
  if ($("#animalSisbov")) $("#animalSisbov").value = String(data.sisbov || "");
  if ($("#animalEletronica")) $("#animalEletronica").value = String(data.identificacao_eletronica || "");
  if ($("#animalRgd")) $("#animalRgd").value = String(data.rgd || "");
  if ($("#animalRgn")) $("#animalRgn").value = String(data.rgn || "");
  if ($("#animalLote")) $("#animalLote").value = String(data.lote || "");
  if ($("#animalPasto")) $("#animalPasto").value = String(data.pasto || "");
  if ($("#animalObs")) $("#animalObs").value = String(data.observacoes || "");

  if ($("#maeCad")) $("#maeCad").checked = data.mae_cadastrada === "1" || data.mae_cadastrada === true;
  if ($("#paiCad")) $("#paiCad").checked = data.pai_cadastrado === "1" || data.pai_cadastrada === true;
  if ($("#animalMae")) $("#animalMae").value = String(data.mae_vinculo || "");
  if ($("#animalPai")) $("#animalPai").value = String(data.pai_vinculo || "");

  if ($("#animalGta")) $("#animalGta").value = String(data.gta || "");
  if ($("#animalUf")) $("#animalUf").value = String(data.uf || "BA");

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
  const btnSaveBottom = $("#btnSaveBottom");
  if (!btnSaveBottom) return;
  
  const check = validateAnimalFormRequired();
  if (check.ok) {
    btnSaveBottom.disabled = false;
    btnSaveBottom.style.opacity = "1";
    btnSaveBottom.style.cursor = "pointer";
  } else {
    btnSaveBottom.disabled = true;
    btnSaveBottom.style.opacity = "0.5";
    btnSaveBottom.style.cursor = "not-allowed";
  }
}

async function fillOwnersAndLotesInForm() {
  const proprietarios = (await idbGet("fazenda", "list_proprietarios")) || [];
  const lotes = (await idbGet("lotes", "list")) || [];

  const selOwner = $("#animalOwnerSelect");
  const selLote = $("#animalLote");

  if (selOwner) {
    selOwner.innerHTML = [
      `<option value="">Selecione…</option>`,
      ...proprietarios.map(p => `<option value="${escapeHtml(p._id)}">${escapeHtml(p.nome || "—")}</option>`)
    ].join("");

    // Seleciona o primeiro proprietário por padrão (index 1 pois 0 é placeholder)
    if (proprietarios.length > 0) {
      selOwner.selectedIndex = 1;
      // Dispara evento para atualizar validação do botão salvar
      selOwner.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  if (selLote) {
    selLote.innerHTML = [
      `<option value="">Lote</option>`,
      ...lotes.map(l => `<option value="${escapeHtml(l._id)}">${escapeHtml(l.nome_lote || "—")}</option>`)
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

  // Botão salvar fixo - validação e estado
  const btnSaveBottom = $("#btnSaveBottom");
  if (btnSaveBottom && !btnSaveBottom.__bound) {
    btnSaveBottom.__bound = true;
    btnSaveBottom.addEventListener("click", async () => {
      const check = validateAnimalFormRequired();
      if (!check.ok) {
        toast(`Campo obrigatório: ${check.key}`);
        return;
      }
      
      // Mostra loading
      const btn = $("#btnSaveBottom");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Salvando...";
      }
      
      try {
        await saveAnimalFromForm();
      } finally {
        const btnFinal = $("#btnSaveBottom");
        if (btnFinal) {
          btnFinal.disabled = false;
          btnFinal.textContent = "Salvar Animal";
        }
      }
    });
  }

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

  // Atualiza estado inicial do botão
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
      await idbSet("meta", "animal_create_advanced", state.advanced ? "1" : "0");
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
  const m = MODULE_CATALOG["animal_create"];
  setPageHeadTexts(m.pageTitle, m.pageSub);
  setPageHeadVisible(false);

  const secList = $("#modAnimaisList");
  const secForm = $("#modAnimaisForm");
  if (secList) secList.hidden = false;
  if (secForm) secForm.hidden = true;

  // Aguarda um frame para garantir que o DOM está atualizado
  await new Promise(resolve => requestAnimationFrame(resolve));
  
  await renderAnimalList();

  // Esconde FAB Sync no módulo animal_create
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
  state.view = "module";
  state.activeKey = "animal_create";
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
    lote: "",
    pasto: "",
    observacoes: "",
    mae_cadastrada: "0",
    pai_cadastrado: "0",
    mae_vinculo: "",
    pai_vinculo: "",
    gta: "",
    uf: "BA",
  };

  writeAnimalFormByIds(initData);

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
  const all = (await idbGet("animais", "list")) || [];
  const a = (Array.isArray(all) ? all : []).find(x => String(x?._id) === String(animalId));

  if (!a) {
    toast("Não foi possível abrir: animal não encontrado no cache.");
    return;
  }

  state.view = "module";
  state.activeKey = "animal_create";
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
  await fillOwnersAndLotesInForm();

  // advanced state - sempre inicia desligado
  state.advanced = false;
  const tgl = $("#toggleAdvanced");
  if (tgl) tgl.checked = false;
  applyAdvancedVisibility();

  // mapeia do seu objeto (cache) para campos do form
  const data = normalizeAnimal(a);
  const mapped = {
    owner: data.owner || state.ctx.ownerId || "",
    entry_type: data.entry_type || "Compra",
    animal_type: data.animal_type || "Físico",
    brinco_padrao: data.brinco_padrao || "",
    sexo: data.sexo || "",
    peso_atual_kg: toNumberOrZero(data.peso_atual_kg),
    data_nascimento: data.data_nascimento || "",
    categoria: data.categoria || "",
    raca: data.raca || "",

    nome_completo: data.nome_completo || "",
    finalidade: data.finalidade || "",
    peso_nascimento: toNumberOrZero(data.peso_nascimento),
    sisbov: data.sisbov || "",
    identificacao_eletronica: data.identificacao_eletronica || "",
    rgd: data.rgd || "",
    rgn: data.rgn || "",
    lote: data.lote || "",
    pasto: data.pasto || "",
    observacoes: data.observacoes || data.observacoes || "",

    mae_cadastrada: data.mae_cadastrada || "0",
    pai_cadastrado: data.pai_cadastrado || "0",
    mae_vinculo: data.mae_vinculo || "",
    pai_vinculo: data.pai_vinculo || "",

    gta: data.gta || "",
    uf: data.uf || "BA",
  };

  writeAnimalFormByIds(mapped);

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
      const record = normalizeAnimal({
        _id: `local:${uuid()}`,
        _local: true,
        _sync: "pending",
        fazenda: state.ctx.fazendaId,
        organizacao: org,
        deleted: false,
        ativo: true,
        morto: false,
        ...data,
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

  if (m.key === "animal_create") {
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

  // default render
  setPageHeadVisible(true);
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

// ---------------- SW ----------------
async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try { await navigator.serviceWorker.register("./sw.js"); } catch { }
}

// ---------------- init ----------------
// ========================================================
// DASHBOARD LOGIC
// ========================================================

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

  // Check for pending sync items to show indicator in header
  const allAnimais = (await idbGet("animais", "list")) || [];
  const hasPending = allAnimais.some(a => a._sync === "pending");

  if (elName) {
    elName.innerHTML = escapeHtml(name) + (hasPending ? " <span style='font-size:14px; vertical-align:middle' title='Dados pendentes'>☁️</span>" : "");
  }
  if (elAvatar) elAvatar.textContent = firstLetter;

  // 2. Modules Carousel
  const modContainer = $("#dashModules");
  if (modContainer) {
    modContainer.innerHTML = ""; // clear
    state.modules.forEach(mod => {
      // Use catalog definition OR fallback to mod properties (from buildModules)
      // If mod from buildModules didn't have icon, use default
      let mDef = MODULE_CATALOG[mod.key];

      if (!mDef) {
        // Fallback object if not in catalog
        mDef = {
          key: mod.key,
          label: mod.label || prettifyKey(mod.key),
          icon: "📦" // Default icon
        };
      }

      const div = document.createElement("div");
      div.className = "dashModCard";
      div.onclick = () => openModule(mod.key);

      div.innerHTML = `
        <div class="dashModIcon">${mDef.icon}</div>
        <div class="dashModTitle">${mDef.label}</div>
      `;
      modContainer.appendChild(div);
    });
  }

  // 3. Charts Stats
  const animais = (await idbGet("animais", "list")) || [];
  const activeAnimais = animais.filter(a => !a.deleted);
  const total = activeAnimais.length;

  // --- CHART 1: SEXO (Donut) ---
  const machos = activeAnimais.filter(a => a.sexo === "M").length;
  const femeas = activeAnimais.filter(a => a.sexo === "F").length;

  // Update Text
  const elTotalSex = $("#chartTotalSex");
  if (elTotalSex) elTotalSex.innerHTML = `${total}<br><span style="font-size:10px;font-weight:400;color:#6b7280">Total</span>`;

  const lblM = $("#lblM"); if (lblM) lblM.textContent = machos;
  const lblF = $("#lblF"); if (lblF) lblF.textContent = femeas;

  // Update Visual Path
  const pctM = total > 0 ? (machos / total) * 100 : 0;
  const pathSexM = document.querySelector("#chartPathSexM");
  if (pathSexM) {
    pathSexM.style.strokeDasharray = `${pctM}, 100`;
    pathSexM.style.animation = 'none';
    pathSexM.offsetHeight;
    pathSexM.style.animation = 'progress 1s ease-out forwards';
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

  // --- CHART 3: PESO JMEDIO POR LOTE (Avg Weight) ---
  // User Requested: Use data directly from 'lotes' table (nome_lote, peso_medio)
  const lotesList = (await idbGet("lotes", "list")) || [];

  const loteAgg = lotesList
    .map(l => ({
      name: l.nome_lote || "Sem Nome",
      avg: parseFloat(l.peso_medio) || 0
    }))
    .filter(i => i.avg > 0)
    .sort((a, b) => b.avg - a.avg);

  const elListLote = $("#chartListLote");
  if (elListLote) {
    if (loteAgg.length === 0) {
      elListLote.innerHTML = `<div style="text-align:center; color:#9ca3af; padding:20px;">Nenhum dado de peso</div>`;
    } else {
      elListLote.innerHTML = "";
      const maxAvg = loteAgg[0].avg;
      loteAgg.slice(0, 5).forEach(item => { // Top 5
        const visualPct = (item.avg / maxAvg) * 100;

        const row = document.createElement("div");
        row.innerHTML = `
                <div class="statRow">
                    <span class="statLabel">${escapeHtml(item.name)}</span>
                    <span class="statVal">${item.avg.toFixed(1)} kg</span>
                </div>
                <div class="statBarBg">
                    <div class="statBarFill" style="width: ${visualPct}%"></div>
                </div>
              `;
        elListLote.appendChild(row);
      });
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

  // Show Dashboard
  const dash = $("#modDashboard");
  if (dash) dash.hidden = false;

  // Render Data
  await renderDashboard();

  // Reset module nav active state
  document.querySelectorAll(".navItem").forEach(n => n.classList.remove("active"));

  // Atualiza visibilidade do FAB Sync
  updateFabSyncVisibility();

  // Salva estado de navegação
  await saveNavigationState();
}

async function openModule(moduleKey) {
  // Logic from renderActiveModule but simplified for switching
  state.activeKey = moduleKey;
  state.view = "module";
  
  // Atualiza visibilidade do FAB Sync
  updateFabSyncVisibility();

  // Hide Dashboard
  const dash = $("#modDashboard");
  if (dash) dash.hidden = true;

  // Show generic container logic
  // Re-run renderActiveModule to handle the specific module's view (list/form etc)
  await renderActiveModule();

  // Salva estado de navegação
  await saveNavigationState();
}

// ---------------- Sync Logic ----------------
// Helper function to get all keys from a store (inline implementation)
async function getAllKeysFromStore(store) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("offline_builder_db", 2);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(store, "readonly");
      const st = tx.objectStore(store);
      const keysReq = st.getAllKeys();
      keysReq.onsuccess = () => resolve(keysReq.result);
      keysReq.onerror = () => reject(keysReq.error);
    };
    req.onerror = () => reject(req.error);
  });
}

// Controla visibilidade do FAB Sync baseado na página atual
function updateFabSyncVisibility() {
  const btn = document.getElementById("fabSync");
  if (!btn) return;

  // Só mostra o FAB Sync no dashboard
  // NÃO mostra no módulo animal_create (nem na listagem, nem nos formulários)
  const isDashboard = state.view === "dashboard";
  const isAnimalModule = state.activeKey === "animal_create" || (state.view === "module" && state.activeKey === "animal_create");
  
  // Se não estiver no dashboard OU estiver no módulo animal_create, esconde
  if (!isDashboard || isAnimalModule) {
    btn.hidden = true;
    btn.style.display = "none"; // Força esconder também via CSS
    btn.style.visibility = "hidden"; // Força esconder também via visibility
    return;
  }

  // Se estiver no dashboard, chama checkSyncStatus para verificar pendências
  // checkSyncStatus vai verificar se está online e se há registros pendentes
  checkSyncStatus();
}

async function checkSyncStatus() {
  const btn = document.getElementById("fabSync");
  if (!btn) return;

  // Só mostra no dashboard - esconde em qualquer outro lugar (incluindo módulo animal_create)
  const isDashboard = state.view === "dashboard";
  const isAnimalModule = state.activeKey === "animal_create" || (state.view === "module" && state.activeKey === "animal_create");
  
  if (!isDashboard || isAnimalModule) {
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

  // Check if there are pending records
  // We scan all keys starting with "queue:" in "records" store
  try {
    // Use inline function to avoid module loading issues
    const keys = await getAllKeysFromStore("records");
    const queueKeys = keys.filter(k => k.startsWith("queue:"));

    let hasPending = false;
    for (const k of queueKeys) {
      const q = await idbGet("records", k);
      if (Array.isArray(q) && q.length > 0) {
        hasPending = true;
        break;
      }
    }

    // Só mostra se estiver no dashboard E tiver pendências
    if (hasPending) {
      btn.hidden = false;
      btn.style.display = "flex";
      btn.style.visibility = "visible";
      btn.style.opacity = "1";
      btn.style.pointerEvents = "auto";
    } else {
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

async function processQueue() {
  if (!navigator.onLine) return;

  const btn = document.getElementById("fabSync");
  if (btn) {
    btn.style.animation = "spin 1s infinite linear"; // Change to spin
    btn.innerHTML = `<div class="fabIcon">⏳</div>`;
  }

  try {
    // Use inline function to avoid module loading issues
    const keys = await getAllKeysFromStore("records");
    const queueKeys = keys.filter(k => k.startsWith("queue:"));

    for (const qKey of queueKeys) {
      const queue = await idbGet("records", qKey);
      if (!Array.isArray(queue) || queue.length === 0) {
        await idbDel("records", qKey);
        continue;
      }
      // Simulate network delay
      await new Promise(r => setTimeout(r, 1500));

      // Success! Clear queue
      await idbDel("records", qKey);
    }

    toast("Sincronização concluída! ✅");
    // Reload data to reflect server state if needed
    // await bootstrapData(); 

  } catch (e) {
    console.error("Sync error:", e);
    toast("Erro ao sincronizar. Tente novamente.");
  } finally {
    if (btn) {
      btn.style.animation = "pulse-green 2s infinite";
      // Atualiza visibilidade após sincronização
    updateFabSyncVisibility();
    
    // Atualiza visibilidade após sincronização
    updateFabSyncVisibility();
    
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
    }
    updateFabSyncVisibility();
  }
}

// Adjusted init to load Dashboard first
async function init() {
  setNetBadge();
  window.addEventListener("online", () => { setNetBadge(); updateFabSyncVisibility(); });
  window.addEventListener("offline", () => { setNetBadge(); updateFabSyncVisibility(); });

  const parsed = parseFromURL();

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
      state.modules = buildModules(["animal_create"]);
    }
  }

  // Setup Sidebar (still useful for desktop or backup)
  renderSidebar();
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
      // Restaura o módulo ativo
      state.view = "module";
      const dash = $("#modDashboard");
      if (dash) dash.hidden = true;
      
      await renderActiveModule();
      
      // Se for módulo de animais e estava em form, restaura
      if (state.activeKey === "animal_create" && state.animalView === "form") {
        if (state.animalEditingId) {
          await openAnimalFormForEdit(state.animalEditingId);
        } else {
          await openAnimalFormForCreate();
        }
      }
    } else {
      // Fallback para dashboard se estado inválido
      await openDashboard();
    }
  } else {
    // START AT DASHBOARD (primeira vez ou sem estado salvo)
    await openDashboard();
  }
}

init();
