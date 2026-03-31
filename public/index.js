// index.js
document.addEventListener("DOMContentLoaded", () => {

  document.addEventListener("touchmove", function (e) {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });

  document.addEventListener("gesturestart", function (e) {
    e.preventDefault();
  }, { passive: false });

  const navEntry = performance.getEntriesByType("navigation")[0];
  if (navEntry && navEntry.type === "reload") {
    localStorage.removeItem("bizas_session_v1");
    window.location.replace("/verify.html");
    return;
  }

  const USER_KEY = "bizas_user_v1";
  const USER_TTL_MS = 3 * 24 * 60 * 60 * 1000;

  function loadUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch { return null; }
  }
  function saveUser(u) { localStorage.setItem(USER_KEY, JSON.stringify(u)); }

  function normalizePhone(raw) {
    let v = String(raw || "").trim().replace(/\s+/g, "");
    if (v.startsWith("+351")) v = v.slice(4);
    if (v.startsWith("00351")) v = v.slice(5);
    return v;
  }

  (function checkVerification() {
    const u = loadUser();
    const isVerified = u?.name && u?.phone && u?.verifiedAt && (Date.now() - u.verifiedAt < USER_TTL_MS);
    if (!isVerified) {
      window.location.replace("/verify.html");
      return;
    }
  })();

  const TAB_ACTIVE_KEY = "bizas_tab_active";
  const TAB_LEFT_KEY   = "bizas_tab_left";

  sessionStorage.setItem(TAB_ACTIVE_KEY, "1");
  sessionStorage.removeItem(TAB_LEFT_KEY);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      sessionStorage.setItem(TAB_LEFT_KEY, "1");
    } else {
      if (sessionStorage.getItem(TAB_LEFT_KEY) === "1") {
        sessionStorage.removeItem(TAB_LEFT_KEY);
        localStorage.removeItem("bizas_session_v1");
        window.location.replace("/verify.html");
      }
    }
  });

  const chips = Array.from(document.querySelectorAll(".chip"));
  const sectionTitle = document.getElementById("sectionTitle");
  const emptyText = document.getElementById("emptyText");

  let orderingOpen = true;

  async function fetchOrderingStatus() {
    try {
      const r = await fetch("/api/public/ordering-status", { cache: "no-store" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || typeof data.open !== "boolean") return null;
      return data.open;
    } catch { return null; }
  }

  function setLockedDisabled(el, locked) {
    if (!el) return;
    if (locked) {
      el.dataset.lockDisabled = "1";
      el.disabled = true;
      el.style.opacity = "0.55";
      el.style.pointerEvents = "none";
      return;
    }
    if (el.dataset.lockDisabled === "1") {
      delete el.dataset.lockDisabled;
      el.disabled = false;
      el.style.opacity = "";
      el.style.pointerEvents = "";
    }
  }

  function applyOrderingState() {
    document.querySelectorAll(".qty-btn").forEach((b) => {
      const soldout = b.dataset.soldout === "1";
      setLockedDisabled(b, !orderingOpen || soldout);
      if (orderingOpen && !soldout) { b.style.opacity = ""; b.style.pointerEvents = ""; }
    });
    document.querySelectorAll(".qty-input").forEach((inp) => {
      const soldout = inp.dataset.soldout === "1";
      setLockedDisabled(inp, !orderingOpen || soldout);
      if (orderingOpen && !soldout) { inp.style.opacity = ""; inp.style.pointerEvents = ""; }
    });
    document.querySelectorAll(".add-to-order").forEach((btn) => {
      const soldout = btn.dataset.soldout === "1";
      setLockedDisabled(btn, !orderingOpen || soldout);
    });
    const fab = document.getElementById("fabOrder");
    if (fab) fab.style.display = orderingOpen ? "" : "none";
    const modal = document.getElementById("orderModal");
    if (!orderingOpen && modal?.classList.contains("open")) modal.classList.remove("open");
    const confirmBtn = document.getElementById("confirmOrderBtn");
    const clearBtn = document.getElementById("clearOrderBtn");
    setLockedDisabled(confirmBtn, !orderingOpen);
    setLockedDisabled(clearBtn, !orderingOpen);
  }

  async function refreshOrderingStatus() {
    const open = await fetchOrderingStatus();
    if (open === null) return;
    const changed = open !== orderingOpen;
    orderingOpen = open;
    if (changed) applyOrderingState();
  }

  refreshOrderingStatus();
  setInterval(refreshOrderingStatus, 1500);

  const SESSION_KEY = "bizas_session_v1";
  const SESSION_TTL_MS = 15 * 60 * 1000;
  const REQUIRE_QR_URL = "/verify.html";

  function getMesaTokenFromUrl() {
    const parts = window.location.pathname.split("/").filter(Boolean);
    if (parts[0] === "t" && parts[1]) return parts[1];
    return null;
  }

  const mesaToken = getMesaTokenFromUrl();

  function saveSession(obj) { localStorage.setItem(SESSION_KEY, JSON.stringify(obj)); }
  function loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
  }
  function clearSession() { localStorage.removeItem(SESSION_KEY); }
  function isSessionExpired(sess) {
    const createdAt = Number(sess?.createdAt || 0);
    if (!createdAt) return true;
    return Date.now() - createdAt > SESSION_TTL_MS;
  }
  function requireQrNow() {
    clearSession();
    window.location.replace(REQUIRE_QR_URL);
  }

  async function apiJson(url, opts) {
    const r = await fetch(url, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Pedido falhou");
    return data;
  }

  async function ensureMesaSession() {
    if (!mesaToken) return null;
    const existing = loadSession();
    if (existing && existing.token === mesaToken && existing.sessionId && !isSessionExpired(existing)) {
      return existing;
    }
    if (existing && isSessionExpired(existing)) { clearSession(); }

    const data = await apiJson(`/api/public/mesa-abrir/${encodeURIComponent(mesaToken)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });

    const sessionObj = {
      token: mesaToken,
      mesaId: data.mesaId,
      mesaNome: data.mesaNome,
      sessionId: data.sessionId,
      createdAt: Date.now()
    };
    saveSession(sessionObj);
    return sessionObj;
  }

  ensureMesaSession()
    .then((s) => { if (s?.mesaNome) console.log("✅ Mesa:", s.mesaNome, "| sessionId:", s.sessionId); })
    .catch((e) => { console.warn("⚠️ Não foi possível identificar a mesa:", e); });

  (function injectCss() {
    const css = `
      html, body { touch-action: pan-x pan-y; -webkit-user-select: none; user-select: none; }
      .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.65); display: none; align-items: center; justify-content: center; z-index: 9999; padding: 18px; }
      .overlay.open { display: flex; }
      .sheet { width: min(520px, 100%); background: #fff; border-radius: 16px; padding: 14px; box-shadow: 0 10px 40px rgba(0,0,0,.25); position: relative; }
      .sheet .x { position: absolute; top: 10px; right: 10px; border: none; background: #f1f1f1; width: 36px; height: 36px; border-radius: 12px; cursor: pointer; font-size: 16px; }
      .sheet h3 { margin: 0 0 8px; }
      .sheet p { margin: 0 0 12px; color: #444; }
      .poster-img { width: 100%; height: auto; border-radius: 14px; display: block; max-height: 70vh; object-fit: contain; background: #fafafa; }
      .poster-nav { display:flex; gap:10px; margin-top: 10px; }
      .poster-nav button { flex:1; padding: 10px; border-radius: 12px; border: 1px solid #eee; background:#fff; cursor:pointer; font-weight: 700; }
      .soldout-badge { display:inline-flex; align-items:center; justify-content:center; padding:6px 10px; border-radius:999px; font-size:12px; font-weight:800; background: rgba(214,69,69,.12); color: #b13b3b; margin-left: 8px; }
      .card-item.soldout { opacity: .7; }
      .card-item.soldout .ci-name::after { content: "Esgotado"; margin-left: 8px; font-size: 12px; font-weight: 800; color: #b13b3b; }
    `;
    const st = document.createElement("style");
    st.textContent = css;
    document.head.appendChild(st);
  })();

  async function fetchCartazesPublic() {
    const r = await fetch("/api/public/cartazes", { cache: "no-store" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return [];
    return Array.isArray(data.cartazes) ? data.cartazes : [];
  }

  function ensurePostersOverlay() {
    if (document.getElementById("postersOverlay")) return;
    const o = document.createElement("div");
    o.className = "overlay";
    o.id = "postersOverlay";
    o.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Cartazes">
        <button class="x" id="postersCloseBtn" type="button">✕</button>
        <h3 style="margin-right:44px;"></h3>
        <img id="posterImg" class="poster-img" alt="Cartaz" />
        <div class="poster-nav">
          <button type="button" id="posterPrev">◀</button>
          <button type="button" id="posterNext">▶</button>
        </div>
      </div>
    `;
    document.body.appendChild(o);
    o.addEventListener("click", (e) => { if (e.target === o) closePosters(); });
    document.getElementById("postersCloseBtn").addEventListener("click", closePosters);
  }

  let postersList = [];
  let posterIdx = 0;

  function renderPoster() {
    const img = document.getElementById("posterImg");
    if (!img) return;
    if (!postersList.length) { img.removeAttribute("src"); img.alt = "Sem cartazes"; return; }
    const p = postersList[posterIdx];
    img.src = p.path;
    img.alt = p.filename || "Cartaz";
  }

  function closePosters() {
    const o = document.getElementById("postersOverlay");
    if (o) o.classList.remove("open");
    document.body.style.overflow = "";
  }

  async function maybeShowPostersOnEntry() {
    try {
      ensurePostersOverlay();
      postersList = await fetchCartazesPublic();
      if (!postersList.length) return;
      posterIdx = 0;
      renderPoster();
      document.getElementById("postersOverlay").classList.add("open");
      document.body.style.overflow = "hidden";
      document.getElementById("posterPrev").onclick = () => {
        if (!postersList.length) return;
        posterIdx = (posterIdx - 1 + postersList.length) % postersList.length;
        renderPoster();
      };
      document.getElementById("posterNext").onclick = () => {
        if (!postersList.length) return;
        posterIdx = (posterIdx + 1) % postersList.length;
        renderPoster();
      };
    } catch (e) {
      console.warn("Cartazes falharam:", e);
    }
  }

  maybeShowPostersOnEntry();

  let searchInput = document.getElementById("searchInput");
  let searchQuery = "";

  const sectionHeader = document.querySelector(".section-header");
  if (!searchInput && sectionHeader) {
    sectionHeader.innerHTML = `<div class="search"><input id="searchInput" type="search" placeholder="Pesquisar (ex: sagres)..." autocomplete="off" /></div>`;
    searchInput = document.getElementById("searchInput");
  }

  let categoriesWrap = document.getElementById("categoriesCards");
  if (!categoriesWrap) {
    const emptyState = document.querySelector(".empty-state");
    categoriesWrap = document.createElement("div");
    categoriesWrap.id = "categoriesCards";
    categoriesWrap.className = "category-cards";
    emptyState?.parentNode?.insertBefore(categoriesWrap, emptyState);
  }

  let activeType = "bebida";
  let allCategories = [];

  const DRAFT_KEY = "bizas_draft_v1";
  const ORDER_KEY = "bizas_order_v1";
  function load(key) { try { return JSON.parse(localStorage.getItem(key) || "{}"); } catch { return {}; } }
  function save(key, obj) { localStorage.setItem(key, JSON.stringify(obj)); }
  function eur(cents) { return (cents / 100).toFixed(2) + "€"; }

  async function fetchCategories() {
    const r = await fetch("/api/public/categories");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  }

  function renderEmpty(show, msg) {
    const emptyState = document.querySelector(".empty-state");
    if (!emptyState) return;
    emptyState.style.display = show ? "block" : "none";
    if (msg && emptyText) emptyText.textContent = msg;
  }

  function clampQty(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.floor(n));
  }

  function syncDraftAndOrderWithAvailability(categories) {
    const availableMap = new Map();
    for (const cat of (categories || [])) {
      for (const it of (cat.items || [])) {
        availableMap.set(String(it.id), Number(it.esgotado || 0) !== 1);
      }
    }
    const draft = load(DRAFT_KEY);
    const order = load(ORDER_KEY);
    let changedDraft = false, changedOrder = false;
    for (const key of Object.keys(draft)) {
      if (availableMap.get(String(key)) === false) { delete draft[key]; changedDraft = true; }
    }
    for (const key of Object.keys(order)) {
      if (availableMap.get(String(key)) === false) { delete order[key]; changedOrder = true; }
    }
    if (changedDraft) save(DRAFT_KEY, draft);
    if (changedOrder) save(ORDER_KEY, order);
  }

  function itemsInsideCardHTML(cat, filterQuery) {
    const q = (filterQuery || "").trim().toLowerCase();
    let items = Array.isArray(cat.items) ? cat.items : [];
    if (q) items = items.filter((it) => String(it.name || "").toLowerCase().includes(q));
    const draft = load(DRAFT_KEY);
    if (items.length === 0) return `<div class="card-items-empty">Sem itens nesta categoria.</div>`;
    return `
      <div class="card-items">
        ${items.map((it) => {
          const key = String(it.id);
          const qty = draft[key]?.qty ?? 0;
          const esgotado = Number(it.esgotado || 0) === 1;
          return `
            <div class="card-item ${esgotado ? "soldout" : ""}">
              <div class="ci-top">
                <div class="ci-name">${it.name}</div>
                <div class="ci-price">${eur(it.price_cents)}</div>
              </div>
              <div class="ci-bottom">
                <div class="qty">
                  <button type="button" class="qty-btn" data-dec="${key}" data-soldout="${esgotado ? "1" : "0"}" aria-label="Diminuir" ${esgotado ? "disabled" : ""}>−</button>
                  <input class="qty-input" type="number" inputmode="numeric" min="0" step="1" value="${esgotado ? 0 : qty}" data-qty="${key}" data-soldout="${esgotado ? "1" : "0"}" aria-label="Quantidade" ${esgotado ? "disabled" : ""} />
                  <button type="button" class="qty-btn" data-inc="${key}" data-soldout="${esgotado ? "1" : "0"}" aria-label="Aumentar" ${esgotado ? "disabled" : ""}>+</button>
                </div>
                ${esgotado ? `<span class="soldout-badge">Esgotado</span>` : ""}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  function categoryHasDraft(cat) {
    const draft = load(DRAFT_KEY);
    return (cat.items || []).some((it) => Number(it.esgotado || 0) !== 1 && (draft[String(it.id)]?.qty || 0) > 0);
  }

  function categoryHasAvailableItems(cat) {
    return (cat.items || []).some((it) => Number(it.esgotado || 0) !== 1);
  }

  function updateAddBtnState(cat, cardEl) {
    const addBtn = cardEl.querySelector(`[data-add-category="${cat.id}"]`);
    if (!addBtn) return;
    const hasAvailable = categoryHasAvailableItems(cat);
    addBtn.dataset.soldout = hasAvailable ? "0" : "1";
    if (!orderingOpen || !hasAvailable) { setLockedDisabled(addBtn, true); addBtn.disabled = true; return; }
    setLockedDisabled(addBtn, false);
    addBtn.disabled = !categoryHasDraft(cat);
  }

  function wireQuantityHandlers(cat, cardEl) {
    const q = (sel) => cardEl.querySelector(sel);
    const qa = (sel) => Array.from(cardEl.querySelectorAll(sel));

    qa("[data-inc]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!orderingOpen || btn.dataset.soldout === "1") return;
        const key = btn.getAttribute("data-inc");
        const input = q(`[data-qty="${key}"]`);
        const draft = load(DRAFT_KEY);
        const next = clampQty(input?.value ?? 0) + 1;
        draft[key] = draft[key] || {};
        draft[key].qty = next;
        save(DRAFT_KEY, draft);
        if (input) input.value = String(next);
        updateAddBtnState(cat, cardEl);
      });
    });

    qa("[data-dec]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (!orderingOpen || btn.dataset.soldout === "1") return;
        const key = btn.getAttribute("data-dec");
        const input = q(`[data-qty="${key}"]`);
        const draft = load(DRAFT_KEY);
        const next = Math.max(0, clampQty(input?.value ?? 0) - 1);
        if (next === 0) delete draft[key];
        else { draft[key] = draft[key] || {}; draft[key].qty = next; }
        save(DRAFT_KEY, draft);
        if (input) input.value = String(next);
        updateAddBtnState(cat, cardEl);
      });
    });

    qa(".qty-input").forEach((input) => {
      input.addEventListener("input", () => {
        const key0 = input.getAttribute("data-qty");
        if (!key0) return;
        if (!orderingOpen || input.dataset.soldout === "1") {
          const d0 = load(DRAFT_KEY);
          input.value = input.dataset.soldout === "1" ? "0" : String(d0[key0]?.qty ?? 0);
          return;
        }
        const draft = load(DRAFT_KEY);
        const next = clampQty(input.value);
        if (next === 0) delete draft[key0];
        else { draft[key0] = draft[key0] || {}; draft[key0].qty = next; }
        save(DRAFT_KEY, draft);
        input.value = String(next);
        updateAddBtnState(cat, cardEl);
      });
    });

    const addBtn = q(`[data-add-category="${cat.id}"]`);
    if (addBtn) {
      addBtn.addEventListener("click", (e) => {
        e.preventDefault();
        if (!orderingOpen || addBtn.dataset.soldout === "1") return;
        const d = load(DRAFT_KEY);
        const order = load(ORDER_KEY);
        let added = 0;
        for (const it of (cat.items || [])) {
          if (Number(it.esgotado || 0) === 1) continue;
          const key = String(it.id);
          const qty = d[key]?.qty || 0;
          if (qty <= 0) continue;
          order[key] = order[key] || { qty: 0, name: it.name, price_cents: it.price_cents, item_id: it.id };
          order[key].qty += qty;
          delete d[key];
          added += qty;
        }
        save(ORDER_KEY, order);
        save(DRAFT_KEY, d);
        if (added > 0) {
          const originalText = addBtn.textContent;
          addBtn.disabled = true;
          addBtn.textContent = "Adicionado ✅";
          setTimeout(() => { addBtn.textContent = originalText || "Adicionar ao pedido"; renderCategoryCards(); }, 650);
        }
      });
    }

    updateAddBtnState(cat, cardEl);
    applyOrderingState();
  }

  function catMatchesQuery(cat, q) {
    if (!q) return false;
    if (String(cat.name || "").toLowerCase().includes(q)) return true;
    return (cat.items || []).some((it) => String(it.name || "").toLowerCase().includes(q));
  }

  function renderCategoryCards() {
    const q = (searchQuery || "").trim().toLowerCase();
    const base = allCategories.filter((c) => c.type === activeType);
    const list = q ? base.slice().sort((a, b) => (catMatchesQuery(b, q) ? 1 : 0) - (catMatchesQuery(a, q) ? 1 : 0)) : base;

    categoriesWrap.innerHTML = "";

    if (list.length === 0) {
      renderEmpty(true, activeType === "bebida" ? "Ainda não há categorias de bebida." : "Ainda não há categorias de comida.");
      return;
    }

    renderEmpty(false);

    list.forEach((cat) => {
      if (q && !catMatchesQuery(cat, q)) return;
      const card = document.createElement("div");
      card.className = "category-card";
      card.dataset.id = cat.id;
      const imgHtml = cat.image_path ? `<img class="cat-img" src="${cat.image_path}" alt="${cat.name}">` : `<div class="cat-img placeholder">🍽️</div>`;
      const showAddBtn = Array.isArray(cat.items) && cat.items.length > 0;
      const hasAvailable = categoryHasAvailableItems(cat);
      const categoryNameMatches = String(cat.name || "").toLowerCase().includes(q);
      const itemFilter = categoryNameMatches ? "" : q;

      card.innerHTML = `
        ${imgHtml}
        <div class="cat-name">${cat.name}</div>
        ${itemsInsideCardHTML(cat, itemFilter)}
        ${showAddBtn ? `<button type="button" class="add-to-order" data-add-category="${cat.id}" data-soldout="${hasAvailable ? "0" : "1"}" ${hasAvailable ? "" : "disabled"}>${hasAvailable ? "Adicionar ao pedido" : "Categoria esgotada"}</button>` : ""}
      `;
      categoriesWrap.appendChild(card);
      requestAnimationFrame(() => wireQuantityHandlers(cat, card));
    });

    applyOrderingState();
  }

  async function refreshFromServer() {
    try {
      allCategories = await fetchCategories();
      syncDraftAndOrderWithAvailability(allCategories);
      renderCategoryCards();
      updateOrderBadge();
      const modal = document.getElementById("orderModal");
      if (modal?.classList.contains("open")) renderOrderModal();
    } catch (err) {
      console.warn("Erro a carregar categorias:", err);
      renderEmpty(true, "Erro a carregar o menu. Tenta novamente.");
      categoriesWrap.innerHTML = "";
    }
  }

  function setActive(catType) {
    activeType = catType;
    chips.forEach((btn) => {
      const isActive = btn.dataset.cat === catType;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    if (sectionTitle) sectionTitle.textContent = catType === "bebida" ? "Bebida" : "Comida";
    if (emptyText) emptyText.textContent = catType === "bebida" ? "Os itens de bebida vão aparecer aqui." : "Os itens de comida vão aparecer aqui.";
    renderCategoryCards();
  }

  chips.forEach((btn) => { btn.addEventListener("click", () => setActive(btn.dataset.cat)); });

  if (searchInput) {
    searchInput.addEventListener("input", () => { searchQuery = searchInput.value; renderCategoryCards(); });
  }

  setActive("bebida");
  refreshFromServer();
  setInterval(refreshFromServer, 8000);

  function calcOrderSummary() {
    const order = load(ORDER_KEY);
    let totalQty = 0, totalCents = 0;
    for (const k of Object.keys(order)) {
      totalQty += Number(order[k].qty || 0);
      totalCents += Number(order[k].qty || 0) * Number(order[k].price_cents || 0);
    }
    return { totalQty, totalCents };
  }

  function ensureOrderUI() {
    if (!document.getElementById("fabOrder")) {
      const fab = document.createElement("div");
      fab.className = "fab-order";
      fab.id = "fabOrder";
      fab.innerHTML = `<button type="button" id="openOrderBtn"><span>Ver pedido</span><span class="badge" id="orderBadge">0</span></button>`;
      document.body.appendChild(fab);
    }

    if (!document.getElementById("orderModal")) {
      const modal = document.createElement("div");
      modal.className = "order-modal";
      modal.id = "orderModal";
      modal.innerHTML = `
        <div class="order-sheet" role="dialog" aria-modal="true" aria-label="Pedido">
          <div class="order-actions-top">
            <h3 style="margin:0;font-size:16px;">O teu pedido</h3>
            <div style="display:flex;gap:10px;align-items:center;">
              <button type="button" class="btn btn-danger" id="clearOrderBtn" style="width:auto;padding:8px 12px;border-radius:12px;">Limpar pedido</button>
              <button type="button" class="close" id="closeOrderBtn">X</button>
            </div>
          </div>
          <div id="orderContent"></div>
          <div id="orderNotesWrap" style="display:none;">
            <textarea id="orderNotesInput" class="order-notes-input" placeholder="Notas para o staff (ex: sem gelo, alergia a...)" maxlength="500" rows="2"></textarea>
          </div>
          <div class="order-actions-bottom">
            <button type="button" class="btn btn-primary" id="confirmOrderBtn">Confirmar pedido</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("open"); });
      document.getElementById("closeOrderBtn").addEventListener("click", () => modal.classList.remove("open"));
      document.getElementById("clearOrderBtn").addEventListener("click", () => {
        if (!orderingOpen) return;
        localStorage.removeItem(ORDER_KEY);
        updateOrderBadge();
        renderOrderModal();
      });

      document.getElementById("confirmOrderBtn").addEventListener("click", async () => {
        if (!orderingOpen) { alert("Pedidos temporariamente fechados. Pede ao staff para abrir as mesas."); return; }

        const u0 = loadUser();
        if (!u0?.name || !u0?.phone) { window.location.replace("/verify.html"); return; }

        const btn = document.getElementById("confirmOrderBtn");
        const modalEl = document.getElementById("orderModal");
        const order = load(ORDER_KEY);
        const keys = Object.keys(order);
        if (keys.length === 0) return;

        const items = keys
          .map((k) => ({ itemId: Number(order[k]?.item_id ?? k), name: String(order[k]?.name || ""), qty: Number(order[k]?.qty || 0), price_cents: Number(order[k]?.price_cents || 0) }))
          .filter((it) => it.qty > 0 && it.name && Number.isFinite(it.price_cents));

        if (items.length === 0) return;

        btn.disabled = true;
        btn.textContent = "A enviar...";

        async function trySendOnce() {
          const existing = loadSession();
          if (!existing || isSessionExpired(existing)) { clearSession(); }
          const sess = await ensureMesaSession();
          if (!sess?.sessionId) throw new Error("Não foi possível identificar a mesa. Lê o QR novamente.");
          const u = loadUser();
          if (!u?.name || !u?.phone) { window.location.replace("/verify.html"); throw new Error("Verifica o telemóvel primeiro."); }

          const notesEl = document.getElementById("orderNotesInput");
          const notes = notesEl ? notesEl.value.trim().slice(0, 500) || null : null;

          return await apiJson("/api/public/pedidos", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: sess.sessionId,
              token: sess.token,
              customer_name: String(u.name || "").trim(),
              customer_phone: String(u.phone || "").trim(),
              items,
              notes
            })
          });
        }

        try {
          let result;
          try { result = await trySendOnce(); }
          catch (e) {
            const msg = String(e?.message || "").toLowerCase();
            if (msg.includes("sessão já está fechada") || msg.includes("sessao ja esta fechada")) {
              clearSession();
              result = await trySendOnce();
            } else throw e;
          }

          const notesVal = (document.getElementById("orderNotesInput")?.value || "").trim() || null;

          const notesEl = document.getElementById("orderNotesInput");
          if (notesEl) notesEl.value = "";

          localStorage.removeItem(ORDER_KEY);
          updateOrderBadge();
          renderOrderModal();
          btn.textContent = "Confirmado ✅";
          setTimeout(() => { btn.disabled = false; btn.textContent = "Confirmar pedido"; modalEl.classList.remove("open"); applyOrderingState(); }, 900);
        } catch (e) {
          console.warn("Falhou envio do pedido:", e);
          alert(e?.message || "Ainda não foi possível enviar o pedido.");
          btn.disabled = false;
          btn.textContent = "Confirmar pedido";
          applyOrderingState();
        }
      });
    }

    document.getElementById("openOrderBtn").addEventListener("click", () => {
      if (!orderingOpen) return;
      renderOrderModal();
      document.getElementById("orderModal").classList.add("open");
    });

    applyOrderingState();
  }

  async function renderOrderModal() {
    const order = load(ORDER_KEY);
    const content = document.getElementById("orderContent");
    const notesWrap = document.getElementById("orderNotesWrap");
    if (!content) return;
    const keys = Object.keys(order);
    const confirmBtn = document.getElementById("confirmOrderBtn");
    const clearBtn = document.getElementById("clearOrderBtn");

    if (keys.length === 0) {
      content.innerHTML = `<div class="order-empty">Ainda não adicionaste nada ao pedido.</div>`;
      if (confirmBtn) confirmBtn.disabled = true;
      if (clearBtn) clearBtn.disabled = true;
      if (notesWrap) notesWrap.style.display = "none";
    } else {
      if (orderingOpen) {
        if (confirmBtn && confirmBtn.dataset.lockDisabled !== "1") confirmBtn.disabled = false;
        if (clearBtn && clearBtn.dataset.lockDisabled !== "1") clearBtn.disabled = false;
      }
      if (notesWrap) notesWrap.style.display = "block";

      const summary = calcOrderSummary();
      content.innerHTML = `
        <div class="order-list">
          ${keys.map((k) => {
            const it = order[k];
            const qty = Number(it.qty || 0);
            return `<div class="order-row"><div class="name">${it.name || "Item"}</div><div class="right"><div class="qty">x${qty}</div><div class="price">${eur(qty * Number(it.price_cents || 0))}</div></div></div>`;
          }).join("")}
        </div>
        <div style="margin-top:12px;font-weight:900;display:flex;justify-content:space-between;">
          <span>Total</span><span>${eur(summary.totalCents)}</span>
        </div>
      `;
    }

    applyOrderingState();
  }

  function updateOrderBadge() {
    const badge = document.getElementById("orderBadge");
    if (!badge) return;
    badge.textContent = String(calcOrderSummary().totalQty);
  }

  ensureOrderUI();
  updateOrderBadge();

  const originalRenderCategoryCards = renderCategoryCards;
  renderCategoryCards = function () { originalRenderCategoryCards(); updateOrderBadge(); };
});3