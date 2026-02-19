import { idbGet, idbSet, idbClear } from "./idb.js";

const $ = (sel) => document.querySelector(sel);

const state = {
  modules: [],
  activeKey: null,
  activeFormRoot: null,
  advanced: false,
  ctx: { fazendaId: "", ownerId: "" },
  bootstrapReady: false,

  // NOVO: controle de view do módulo animais
  animalView: "list", // "list" | "form"
  animalEditingId: null, // _id do animal em edição (ou null = criando)
};

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
  alert("passei aqui");
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
  showBoot("Sincronizando dados…", "Buscando dados do Bubble e preparando modo offline.");

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
    const animais = toCloneable(
      (Array.isArray(animaisRaw) ? animaisRaw : []).map(normalizeAnimal)
    );
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

  // Garante visibilidade interna
  if (secList) secList.hidden = false;
  if (secForm) secForm.hidden = true;

  // Header principal esconde pois a lista já tem seu próprio greeting
  setPageHeadVisible(false);

  // Botão Voltar para Dashboard (Mobile)
  if (state.view === "module") {
    const backBtnConfig = {
      text: "← Voltar",
      onclick: openDashboard
    };
    // Se houver um lugar melhor, podemos injetar. Por enquanto, vou injetar no topo da lista se não existir.
    let backDiv = document.getElementById("mobileBackDash");
    if (!backDiv) {
      backDiv = document.createElement("div");
      backDiv.id = "mobileBackDash";
      backDiv.className = "mobileMsg"; // Reuse minimal style or create new
      backDiv.style.padding = "10px 0";
      backDiv.style.cursor = "pointer";
      backDiv.style.fontWeight = "600";
      backDiv.style.color = "var(--text)";
      backDiv.innerHTML = `<span style="font-size:18px; vertical-align:middle; margin-right:4px;">Home</span>`;
      backDiv.onclick = openDashboard;

      const container = $("#animalModuleContainer");
      if (container) container.insertBefore(backDiv, container.firstChild);
    }
  }

  // Dados do cache
  const fazenda = await idbGet("fazenda", "current");
  const farmName = fazenda?.name || "—";
  const farmLabel = $("#farmCurrent");
  if (farmLabel) farmLabel.textContent = farmName;

  const all = (await idbGet("animais", "list")) || [];
  const searchEl = $("#animalSearch");
  const tbody = $("#animalTbody");
  const countPill = $("#animalCountPill");

  if (!tbody) return;

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

  if (countPill) {
    const n = list.length;
    countPill.textContent = `${n} ${n === 1 ? "Animal" : "Animais"}`;
  }

  // Renderiza Tabela
  tbody.innerHTML = "";
  for (const a of list) {
    const tr = document.createElement("tr");
    tr.dataset.id = a._id || "";

    const statusOn = (a.ativo && !a.morto && !a.deleted);
    let statusLabel = statusOn ? "Ativo" : (a.morto ? "Morto" : "Inativo");
    const statusClass = statusOn ? "statusBadge" : "statusBadge off";

    // Sync pending indicator
    if (a._sync === "pending") {
      statusLabel += " 🕒"; // Clock icon for pending
    }

    // Colunas reduzidas: Brinco, Sexo, Raça, Peso, Status
    tr.innerHTML = `
      <td data-label="Brinco">${escapeHtml(a?.brinco_padrao || "—")}</td>
      <td data-label="Sexo">${escapeHtml(renderSex(a?.sexo))}</td>
      <td data-label="Raça">${escapeHtml(a?.raca || "—")}</td>
      <td data-label="Peso">${escapeHtml(fmtKg(a?.peso_atual_kg))}</td>
      <td data-label="Status"><span class="${statusClass}">${escapeHtml(statusLabel)}</span></td>
    `;

    tr.onclick = async () => {
      await openAnimalFormForEdit(a._id);
    };

    tbody.appendChild(tr);
  }

  // Bind Search
  if (searchEl && !searchEl.__bound) {
    searchEl.__bound = true;
    searchEl.addEventListener("input", async () => {
      await renderAnimalList();
    });
  }

  // Bind Novo Animal
  const btnNovo = $("#btnNovoAnimal");
  if (btnNovo && !btnNovo.__bound) {
    btnNovo.__bound = true;
    btnNovo.onclick = async () => openAnimalFormForCreate();
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
  const etiquetas = $("#animalEtiquetas")?.value ?? "";
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
    etiquetas,
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
  if ($("#animalEtiquetas")) $("#animalEtiquetas").value = String(data.etiquetas || "");
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

    // Seleciona o primeiro proprietário se houver (index 1 pois 0 é placeholder)
    if (proprietarios.length > 0) {
      selOwner.selectedIndex = 1;
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

  // tabs
  const tabs = secForm.querySelectorAll(".tab");
  const panels = {
    dados: $("#tab-dados"),
    genealogia: $("#tab-genealogia"),
    aquisicao: $("#tab-aquisicao"),
  };

  function setTab(key) {
    tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === key));
    Object.entries(panels).forEach(([k, el]) => {
      if (!el) return;
      el.classList.toggle("active", k === key);
    });
  }

  tabs.forEach(t => {
    t.addEventListener("click", () => setTab(t.dataset.tab));
  });

  // chips tipo entrada
  const chipWrap = $("#tipoEntradaChips");
  if (chipWrap) {
    chipWrap.querySelectorAll(".chip").forEach(chip => {
      chip.addEventListener("click", () => {
        chipWrap.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
        chip.classList.add("active");
        chipWrap.querySelectorAll(".chip .box").forEach(b => b.textContent = "");
        chip.querySelector(".box") && (chip.querySelector(".box").textContent = "✓");
      });
    });
  }

  // botões voltar
  const backIds = ["btnVoltarLista", "btnVoltarLista2", "btnVoltarLista3", "btnVoltarTopo"];
  backIds.forEach(id => {
    const b = $("#" + id);
    if (b) b.addEventListener("click", async (e) => {
      e.preventDefault(); // prevenir behavior indesejado
      await openAnimalList();
    });
  });

  // salvar (top)
  const btnSave = $("#btnSave");
  if (btnSave) {
    btnSave.onclick = async () => {
      await saveAnimalFromForm();
    };
  }

  // salvar (bottom - mobile)
  const btnSaveBottom = $("#btnSaveBottom");
  if (btnSaveBottom) {
    btnSaveBottom.onclick = async () => {
      await saveAnimalFromForm();
    };
  }

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

  await renderAnimalList();
}

async function openAnimalFormForCreate() {
  state.animalView = "form";
  state.animalEditingId = null;

  // mostra header do form
  setPageHeadTexts("Informações do animal", "Cadastre ou atualize aqui");
  setPageHeadVisible(true);

  const secList = $("#modAnimaisList");
  const secForm = $("#modAnimaisForm");
  if (secList) secList.hidden = true;
  if (secForm) secForm.hidden = false;

  bindAnimalFormUIOnce();
  await fillOwnersAndLotesInForm();

  // advanced state
  state.advanced = (await idbGet("meta", "animal_create_advanced")) === "1";
  const tgl = $("#toggleAdvanced");
  if (tgl) tgl.checked = state.advanced;
  applyAdvancedVisibility();

  // default owner da URL se tiver
  const initData = {
    owner: state.ctx.ownerId || "",
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
    etiquetas: "",
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
}

async function openAnimalFormForEdit(animalId) {
  const all = (await idbGet("animais", "list")) || [];
  const a = (Array.isArray(all) ? all : []).find(x => String(x?._id) === String(animalId));

  if (!a) {
    toast("Não foi possível abrir: animal não encontrado no cache.");
    return;
  }

  state.animalView = "form";
  state.animalEditingId = String(animalId);

  setPageHeadVisible(true);
  setPageHeadTexts("Informações do animal", `Editando: ${animalDisplayName(a)}`);

  const secList = $("#modAnimaisList");
  const secForm = $("#modAnimaisForm");
  if (secList) secList.hidden = true;
  if (secForm) secForm.hidden = false;

  bindAnimalFormUIOnce();
  await fillOwnersAndLotesInForm();

  // advanced state
  state.advanced = (await idbGet("meta", "animal_create_advanced")) === "1";
  const tgl = $("#toggleAdvanced");
  if (tgl) tgl.checked = state.advanced;
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
    etiquetas: data.etiquetas || "",
    observacoes: data.observacoes || data.observacoes || "",

    mae_cadastrada: data.mae_cadastrada || "0",
    pai_cadastrado: data.pai_cadastrado || "0",
    mae_vinculo: data.mae_vinculo || "",
    pai_vinculo: data.pai_vinculo || "",

    gta: data.gta || "",
    uf: data.uf || "BA",
  };

  writeAnimalFormByIds(mapped);
}

// ---------------- Save: CREATE or UPDATE offline (com validação de brinco) ----------------

async function saveAnimalFromForm() {
  const check = validateAnimalFormRequired();
  if (!check.ok) {
    toast(`Campo obrigatório: ${check.key}`);
    return;
  }

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
    await idbSet("animais", "list", arr);

    // fila
    const qKey = `queue:${state.ctx.fazendaId}:${state.ctx.ownerId}:animal`;
    const queue = (await idbGet("records", qKey)) || [];
    queue.push({ op: "animal_create", at: Date.now(), payload: record });
    await idbSet("records", qKey, queue);

    toast("Animal salvo offline.");
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

  toast("Alterações salvas offline.");
  checkSyncStatus(); // Update FAB visibility
  await openAnimalList();
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
}

async function openModule(moduleKey) {
  // Logic from renderActiveModule but simplified for switching
  state.activeKey = moduleKey;
  state.view = "module";

  // Hide Dashboard
  const dash = $("#modDashboard");
  if (dash) dash.hidden = true;

  // Show generic container logic
  // Re-run renderActiveModule to handle the specific module's view (list/form etc)
  await renderActiveModule();
}

// ---------------- Sync Logic ----------------
async function checkSyncStatus() {
  const btn = document.getElementById("fabSync");
  if (!btn) return;

  if (!navigator.onLine) {
    btn.hidden = true;
    return;
  }

  // Check if there are pending records
  // We scan all keys starting with "queue:" in "records" store
  const keys = await idbGetAllKeys("records");
  const queueKeys = keys.filter(k => k.startsWith("queue:"));

  let hasPending = false;
  for (const k of queueKeys) {
    const q = await idbGet("records", k);
    if (Array.isArray(q) && q.length > 0) {
      hasPending = true;
      break;
    }
  }

  btn.hidden = !hasPending;
}

async function processQueue() {
  if (!navigator.onLine) return;

  const btn = document.getElementById("fabSync");
  if (btn) {
    btn.style.animation = "spin 1s infinite linear"; // Change to spin
    btn.innerHTML = `<div class="fabIcon">⏳</div>`;
  }

  try {
    const keys = await idbGetAllKeys("records");
    const queueKeys = keys.filter(k => k.startsWith("queue:"));

    for (const qKey of queueKeys) {
      const queue = await idbGet("records", qKey);
      if (!Array.isArray(queue) || queue.length === 0) {
        await idbDel("records", qKey);
        continue;
      }

      // Fake processing for now - in real app, send batch to server
      console.log(`[SYNC] Processing ${queue.length} items from ${qKey}`);

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
    checkSyncStatus();
  }
}

// Adjusted init to load Dashboard first
async function init() {
  setNetBadge();
  window.addEventListener("online", () => { setNetBadge(); checkSyncStatus(); });
  window.addEventListener("offline", () => { setNetBadge(); checkSyncStatus(); });

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

  // Initialize Sync Button Logic
  if (state.bootstrapReady) {
    checkSyncStatus();
    const fab = document.getElementById("fabSync");
    if (fab) fab.onclick = processQueue;
  }

  // START AT DASHBOARD
  await openDashboard();
}

init();
