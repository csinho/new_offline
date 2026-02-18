import { idbGet, idbSet, idbClear } from "./idb.js";

const $ = (sel) => document.querySelector(sel);

const state = {
  modules: [],
  activeKey: null,
  activeFormRoot: null,
  advanced: false,
  ctx: { fazendaId: "", ownerId: "" },
  bootstrapReady: false,
};

// ---------------- UI helpers ----------------
function toast(msg) {
  const wrap = $("#toast");
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

// ---------------- URL / modules ----------------
const MODULE_CATALOG = {
  animal_create: {
    key: "animal_create",
    label: "Animais",
    pageTitle: "Informações do animal",
    pageSub: "Cadastre ou atualize aqui",
    storageKey: "animais", // store do IDB
  },
  vaccine: {
    key: "vaccine",
    label: "Vacinação",
    pageTitle: "Vacinação",
    pageSub: "Registre vacinas offline",
    storageKey: "vacinacao",
  },
};

function parseFromURL() {
  const u = new URL(location.href);
  const rawModules = (u.searchParams.get("modules") || "").trim();
  const modules = rawModules.split(",").map(s => s.trim()).filter(Boolean);
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

  // Se já tem cache desse contexto, dá pra abrir offline
  const cachedCtxKey = `ctx:${state.ctx.fazendaId}:${state.ctx.ownerId}`;
  const cachedOk = await idbGet("meta", cachedCtxKey);

  // Online: sempre tenta sincronizar (primeira carga / refresh)
  if (navigator.onLine) {
    showBoot("Sincronizando dados…", "Buscando dados do Bubble e preparando modo offline.");

    try {
      const url = getEndpointUrl(state.ctx);
      const res = await fetch(url, { method: "GET" });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // Normaliza (defensivo)
      const fazenda = data?.fazenda || null;
      const owner = data?.owner || null;

      const animais = fazenda?.list_animais || [];
      const lotes = fazenda?.list_lotes || [];
      const vacinacao = fazenda?.list_vacinacao || [];
      const proprietarios = fazenda?.list_proprietarios || [];

      // Salva "tabelas"
      await idbSet("fazenda", "current", fazenda);
      await idbSet("owner", "current", owner);
      await idbSet("animais", "list", Array.isArray(animais) ? animais : []);
      await idbSet("lotes", "list", Array.isArray(lotes) ? lotes : []);
      await idbSet("vacinacao", "list", Array.isArray(vacinacao) ? vacinacao : []);
      await idbSet("fazenda", "list_proprietarios", Array.isArray(proprietarios) ? proprietarios : []);

      // marca contexto como cacheado
      await idbSet("meta", cachedCtxKey, { cachedAt: Date.now() });
      await idbSet("meta", "lastCtx", { ...state.ctx, cachedAt: Date.now() });

      state.bootstrapReady = true;
      hideBoot();
      return;

    } catch (err) {
      // Se falhou online mas já existe cache, deixa entrar
      if (cachedOk) {
        toast("Falha ao sincronizar agora. Usando dados offline salvos.");
        state.bootstrapReady = true;
        hideBoot();
        return;
      }

      // Sem cache: bloqueia
      showBoot(
        "Não foi possível sincronizar",
        "Verifique internet / CORS do endpoint / parâmetros."
      );
      state.bootstrapReady = false;
      return;
    }
  }

  // Offline: só entra se houver cache
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
}

// ---------------- Sidebar ----------------
function renderSidebar() {
  const nav = $("#moduleNav");
  nav.innerHTML = "";

  for (const m of state.modules) {
    const item = document.createElement("div");
    item.className = "navItem" + (m.key === state.activeKey ? " active" : "");
    item.innerHTML = `<span class="navIcon"></span><span>${escapeHtml(m.label)}</span>`;
    item.onclick = async () => {
      state.activeKey = m.key;
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
    const v = data?.[k];
    if (v == null) return;

    if (el.type === "checkbox") el.checked = v === "1" || v === true;
    else el.value = String(v);
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

// ---------------- Render: animal_create ----------------
async function renderAnimalCreate() {
  const mount = $("#moduleView");
  mount.innerHTML = "";

  // carrega dados cacheados
  const fazenda = await idbGet("fazenda", "current");
  const proprietarios = (await idbGet("fazenda", "list_proprietarios")) || [];
  const lotes = (await idbGet("lotes", "list")) || [];

  // labels
  const farmName = fazenda?.name || "—";
  $("#farmCurrent").textContent = farmName;

  // draft
  const draftKey = `draft:animal_create:${state.ctx.fazendaId}:${state.ctx.ownerId}`;
  const draft = (await idbGet("drafts", draftKey)) || {};

  const card = document.createElement("div");
  card.className = "card";

  // monta options de proprietários
  const ownerOptions = [
    `<option value="">Selecione…</option>`,
    ...proprietarios.map(p => `<option value="${escapeHtml(p._id)}">${escapeHtml(p.nome || "—")}</option>`)
  ].join("");

  // monta options de lotes
  const loteOptions = [
    `<option value="">Lote</option>`,
    ...lotes.map(l => `<option value="${escapeHtml(l._id)}">${escapeHtml(l.nome_lote || "—")}</option>`)
  ].join("");

  card.innerHTML = `
    <div class="dashedBox">
      <div class="dashedLeft">
        <div class="farmIcon">⌂</div>
        <div class="dashedText">
          <div class="k">Fazenda Selecionada</div>
          <div class="v" id="farmSelectedLabel">${escapeHtml(farmName)}</div>
        </div>
      </div>

      <div class="field" style="max-width:280px; width:100%;">
        <div class="label">Proprietário<span class="req">*</span></div>
        <select data-key="owner" data-required="1">${ownerOptions}</select>
      </div>
    </div>

    <div class="label" style="margin-top:6px;">Selecione o tipo de entrada<span class="req">*</span></div>
    <div class="chips" id="entryChips"></div>
    <input type="hidden" data-key="entry_type" data-required="1" />

    <div class="grid" style="margin-top:10px;">
      <div class="field" style="grid-column: span 2;">
        <div class="label">Tipo de animal<span class="req">*</span></div>
        <select data-key="animal_type" data-required="1">
          <option value="">Selecione…</option>
          <option value="fisico">Físico</option>
          <option value="genealogia">Genealogia</option>
        </select>
      </div>

      <div class="field" style="grid-column: span 2;">
        <div class="label">Brinco padrão<span class="req">*</span></div>
        <input data-key="brinco_padrao" data-required="1" placeholder="ID" />
      </div>

      <div class="field" style="grid-column: span 2;">
        <div class="label">Sexo<span class="req">*</span></div>
        <select data-key="sexo" data-required="1">
          <option value="">Sexo</option>
          <option value="M">Macho</option>
          <option value="F">Fêmea</option>
        </select>
      </div>

      <div class="field" style="grid-column: span 2;">
        <div class="label">Peso atual em kg</div>
        <input data-key="peso_atual_kg" type="number" placeholder="0" />
      </div>

      <div class="field" style="grid-column: span 2;">
        <div class="label">Data de nascimento<span class="req">*</span></div>
        <input data-key="data_nascimento" type="date" data-required="1" />
      </div>

      <div class="field" style="grid-column: span 1;">
        <div class="label">Idade<span class="req">*</span></div>
        <input data-key="idade" class="disabled" placeholder="0 mês" disabled />
      </div>

      <div class="field" style="grid-column: span 1;">
        <div class="label">Categoria<span class="req">*</span></div>
        <select data-key="categoria" data-required="1">
          <option value="">Categoria</option>
          <option value="Bezerro">Bezerro</option>
          <option value="Garrote">Garrote</option>
          <option value="Touro">Touro</option>
          <option value="Bezerra">Bezerra</option>
          <option value="Vaca">Vaca</option>
        </select>
      </div>

      <div class="field" style="grid-column: span 12;">
        <div class="label">Raça<span class="req">*</span></div>
        <input data-key="raca" data-required="1" placeholder="Raça" />
      </div>
    </div>
  `;
  mount.appendChild(card);

  const card2 = document.createElement("div");
  card2.className = "card";
  card2.innerHTML = `
    <div class="tabs">
      <div class="tab active" data-tab="extra">Dados adicionais</div>
      <div class="tab" data-tab="gen">Genealogia</div>
      <div class="tab" data-tab="acq">Aquisição</div>
    </div>

    <div class="tabPanel active" data-panel="extra">
      <div class="grid">
        <div class="field" style="grid-column: span 4;">
          <div class="label">Nome completo</div>
          <input data-key="nome_completo" placeholder="Brinco de manejo" />
        </div>

        <div class="field" style="grid-column: span 4;">
          <div class="label">Finalidade</div>
          <select data-key="finalidade">
            <option value="">Finalidade</option>
            <option value="Corte">Corte</option>
            <option value="Leite">Leite</option>
            <option value="Reprodução">Reprodução</option>
          </select>
        </div>

        <div class="field" style="grid-column: span 4;">
          <div class="label">Peso no nascimento em kg</div>
          <input data-key="peso_nascimento" type="number" placeholder="0" />
        </div>

        <div class="field adv" style="grid-column: span 4;">
          <div class="label">SISBOV</div>
          <input data-key="sisbov" placeholder="SISBOV" />
        </div>

        <div class="field adv" style="grid-column: span 4;">
          <div class="label">Identificação eletrônica</div>
          <input data-key="identificacao_eletronica" placeholder="Identificação eletrônica" />
        </div>

        <div class="field adv" style="grid-column: span 4;">
          <div class="label">RGD</div>
          <input data-key="rgd" placeholder="RGD" />
        </div>

        <div class="field adv" style="grid-column: span 4;">
          <div class="label">RGN</div>
          <input data-key="rgn" placeholder="RGN" />
        </div>

        <div class="field adv" style="grid-column: span 4;">
          <div class="label">Lote</div>
          <select data-key="lote">${loteOptions}</select>
        </div>

        <div class="field adv" style="grid-column: span 4;">
          <div class="label">Pasto</div>
          <select data-key="pasto">
            <option value="">Pasto</option>
            <option value="Pasto 1">Pasto 1</option>
            <option value="Pasto 2">Pasto 2</option>
          </select>
        </div>

        <div class="field adv" style="grid-column: span 12;">
          <div class="label">Etiquetas</div>
          <input data-key="etiquetas" placeholder="Etiqueta" />
        </div>

        <div class="field" style="grid-column: span 12;">
          <div class="label">Observações</div>
          <textarea data-key="observacoes" placeholder="Digite aqui suas observações sobre o animal..."></textarea>
        </div>
      </div>

      <div class="footerSave">
        <button class="btn primary" id="btnSaveBottom">Salvar</button>
      </div>
    </div>

    <div class="tabPanel" data-panel="gen">
      <div class="togglePills">
        <div class="pill">
          <span>Mãe Cadastrada</span>
          <label class="switch">
            <input type="checkbox" data-key="mae_cadastrada" />
            <span class="slider"></span>
          </label>
        </div>

        <div class="pill">
          <span>Pai Cadastrado</span>
          <label class="switch">
            <input type="checkbox" data-key="pai_cadastrado" />
            <span class="slider"></span>
          </label>
        </div>
      </div>

      <div class="grid">
        <div class="field" style="grid-column: span 6;">
          <div class="label">Mãe (vinculado)</div>
          <input data-key="mae_vinculo" placeholder="Digite o nome para pesquisar" />
        </div>

        <div class="field" style="grid-column: span 6;">
          <div class="label">Pai (vinculado)</div>
          <input data-key="pai_vinculo" placeholder="Digite o nome para pesquisar" />
        </div>
      </div>

      <div class="footerSave">
        <button class="btn primary" id="btnSaveBottom2">Salvar</button>
      </div>
    </div>

    <div class="tabPanel" data-panel="acq">
      <div class="grid">
        <div class="field" style="grid-column: span 8;">
          <div class="label">Nº GTA</div>
          <input data-key="gta" placeholder="12345" />
        </div>

        <div class="field" style="grid-column: span 4;">
          <div class="label">Estado (UF)</div>
          <select data-key="uf">
            <option value="">Selecione…</option>
            <option value="BA">BA</option>
            <option value="GO">GO</option>
            <option value="MG">MG</option>
            <option value="MT">MT</option>
            <option value="SP">SP</option>
          </select>
        </div>
      </div>

      <div class="footerSave">
        <button class="btn primary" id="btnSaveBottom3">Salvar</button>
      </div>
    </div>
  `;
  mount.appendChild(card2);

  // Tipo de entrada (apenas 1 — como você confirmou)
  const chipWrap = card.querySelector("#entryChips");
  const hiddenEntry = card.querySelector("[data-key='entry_type']");

  const entryOptions = [
    { key: "Nascimento", label: "Nascimento" },
    { key: "Compra", label: "Compra" },
    { key: "Doação", label: "Doação" },
    { key: "Empréstimo", label: "Empréstimo" },
    { key: "Ajuste inventário", label: "Ajuste inventário" },
  ];

  function setActiveChip(val) {
    hiddenEntry.value = val || "";
    chipWrap.querySelectorAll(".chip").forEach((c) => {
      c.classList.toggle("active", c.dataset.value === val);
      const box = c.querySelector(".box");
      if (box) box.textContent = c.dataset.value === val ? "✓" : "";
    });
  }

  for (const opt of entryOptions) {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.dataset.value = opt.key;
    chip.innerHTML = `<span class="box"></span><span>${escapeHtml(opt.label)}</span>`;
    chip.onclick = () => setActiveChip(opt.key);
    chipWrap.appendChild(chip);
  }

  // Tabs internas
  function setTab(tabKey) {
    card2.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tabKey));
    card2.querySelectorAll(".tabPanel").forEach((p) => p.classList.toggle("active", p.dataset.panel === tabKey));
  }
  card2.querySelectorAll(".tab").forEach((t) => {
    t.onclick = () => setTab(t.dataset.tab);
  });

  // Toggle avançado
  function applyAdvanced() {
    card2.querySelectorAll(".adv").forEach((el) => {
      el.style.display = state.advanced ? "" : "none";
    });
  }

  // idade auto
  const birthEl = card.querySelector("[data-key='data_nascimento']");
  const ageEl = card.querySelector("[data-key='idade']");
  function updateAge() {
    const v = birthEl.value;
    if (!v) { ageEl.value = ""; return; }
    const bd = new Date(v + "T00:00:00");
    const m = monthDiff(bd, new Date());
    ageEl.value = `${m} ${m === 1 ? "mês" : "meses"}`;
  }
  birthEl.addEventListener("input", updateAge);

  // Root para draft
  const root = document.createElement("div");
  root.appendChild(card);
  root.appendChild(card2);
  state.activeFormRoot = root;

  // Defaults vindos da URL
  if (!draft.owner && state.ctx.ownerId) draft.owner = state.ctx.ownerId;

  // Aplica draft
  writeForm(root, draft);
  setActiveChip(draft.entry_type || "");
  updateAge();

  // Advanced state
  state.advanced = (await idbGet("meta", "animal_create_advanced")) === "1";
  $("#toggleAdvanced").checked = state.advanced;
  applyAdvanced();

  // Auto-save draft
  root.addEventListener("input", async () => {
    const data = readForm(root);
    await idbSet("drafts", draftKey, data);
  });

  // Save buttons
  const handler = async () => saveOfflineAnimalCreate(draftKey);
  $("#btnSave").onclick = handler;
  card2.querySelector("#btnSaveBottom").onclick = handler;
  card2.querySelector("#btnSaveBottom2").onclick = handler;
  card2.querySelector("#btnSaveBottom3").onclick = handler;

  // Toggle advanced
  $("#toggleAdvanced").onchange = async (e) => {
    state.advanced = !!e.target.checked;
    await idbSet("meta", "animal_create_advanced", state.advanced ? "1" : "0");
    applyAdvanced();
  };
}

// ---------------- Save offline animal_create (com validação de brinco) ----------------
function normBrinco(v) {
  return String(v ?? "").trim().toLowerCase();
}

async function saveOfflineAnimalCreate(draftKey) {
  if (!state.activeFormRoot) return;

  const check = validateForm(state.activeFormRoot);
  if (!check.ok) {
    toast(`Campo obrigatório: ${check.key}`);
    return;
  }

  const data = readForm(state.activeFormRoot);

  // valida brinco duplicado no cache de animais
  const list = (await idbGet("animais", "list")) || [];
  const target = normBrinco(data.brinco_padrao);

  const exists = list.some(a => normBrinco(a?.brinco_padrao) === target);
  if (exists) {
    toast("Já existe um animal com este brinco padrão. Não é possível cadastrar.");
    return;
  }

  // cria animal offline (marca como pendente)
  const record = {
    _id: `local:${uuid()}`,
    _local: true,
    _sync: "pending",
    fazenda: state.ctx.fazendaId,
    organizacao: (await idbGet("fazenda", "current"))?.organizacao || "",
    deleted: false,
    ativo: true,
    morto: false,
    ...data,
  };

  // salva na tabela animais (lista)
  list.unshift(record);
  await idbSet("animais", "list", list);

  // (opcional, mas útil pro futuro sync) salva fila de operações
  const qKey = `queue:${state.ctx.fazendaId}:${state.ctx.ownerId}:animal_create`;
  const queue = (await idbGet("records", qKey)) || [];
  queue.push({
    op: "animal_create",
    at: Date.now(),
    payload: record,
  });
  await idbSet("records", qKey, queue);

  // limpa draft e recarrega tela
  await idbSet("drafts", draftKey, {});
  toast("Salvo offline.");
  await renderActiveModule();
}

// ---------------- Render módulo ativo ----------------
async function renderActiveModule() {
  const m = state.modules.find(x => x.key === state.activeKey) || state.modules[0];
  if (!m) return;

  $("#pageTitle").textContent = m.pageTitle || m.label;
  $("#pageSub").textContent = m.pageSub || "";

  // placeholder BioID
  $("#btnBioId").onclick = () => toast("BioID (placeholder)");

  if (!state.bootstrapReady) {
    $("#moduleView").innerHTML = `
      <div class="card">
        <b>Modo offline não está pronto</b>
        <div style="color:#6b7280;margin-top:6px;">
          Abra uma vez com internet com os parâmetros corretos para sincronizar os dados.
        </div>
      </div>
    `;
    return;
  }

  if (m.key === "animal_create") {
    await renderAnimalCreate();
    return;
  }

  $("#moduleView").innerHTML = `
    <div class="card">
      <b>${escapeHtml(m.label)}</b>
      <div style="color:#6b7280;margin-top:6px;">Módulo ainda não desenhado no novo layout.</div>
    </div>
  `;
}

// ---------------- SW ----------------
async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try { await navigator.serviceWorker.register("./sw.js"); } catch { }
}

// ---------------- init ----------------
async function init() {
  setNetBadge();
  window.addEventListener("online", () => setNetBadge());
  window.addEventListener("offline", () => setNetBadge());

  const parsed = parseFromURL();
  state.ctx = { fazendaId: parsed.fazendaId, ownerId: parsed.ownerId };

  state.modules = buildModules(parsed.modules);
  state.activeKey = state.modules[0]?.key || "animal_create";

  renderSidebar();

  await registerSW();

  // bootstrap (sync) antes de liberar
  await bootstrapData();

  // depois renderiza
  await renderActiveModule();
}

init();
