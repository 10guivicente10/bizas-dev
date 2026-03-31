// worker.js
document.addEventListener("DOMContentLoaded", () => {
  const ordersList = document.getElementById("ordersList");
  const ordersEmpty = document.getElementById("ordersEmpty");
  const lastUpdate = document.getElementById("lastUpdate");
  const btnRefresh = document.getElementById("btnRefresh");
  const chips = Array.from(document.querySelectorAll(".chip[data-filter]"));
  const mainTitle = document.getElementById("mainTitle");

  // ✅ ABRIR / FECHAR MESAS (global)
  const orderingPill = document.getElementById("orderingPill");
  const btnOpenOrdering = document.getElementById("btnOpenOrdering");
  const btnCloseOrdering = document.getElementById("btnCloseOrdering");

  // Modal
  const modal = document.getElementById("orderModal");
  const btnCloseModal = document.getElementById("btnCloseModal");

  const modalTitle = document.getElementById("modalTitle");
  const modalSub = document.getElementById("modalSub");
  const modalItems = document.getElementById("modalItems");
  const modalNotesWrap = document.getElementById("modalNotesWrap");
  const modalNotes = document.getElementById("modalNotes");
  const modalTotal = document.getElementById("modalTotal");

  const modalFooter = document.getElementById("modalFooter");
  const statusBtns = Array.from(document.querySelectorAll("[data-setstatus]"));

  let activeFilter = "abertos";
  let listCache = [];
  let productsCache = [];
  let currentPedidoId = null;

  let currentPedidoFechado = false;
  let currentPedidoFechoLabel = "";

  // ✅ para “Pagar rodada”
  let currentSessionId = null;
  let currentPedidoStatus = "";
  let currentPedidoItems = [];

  // ✅ mesa atual (para encolher ao servir)
  let currentMesaKey = null;

  // ✅ auto open vs manual open (por filtro)
  const autoOpenMesasByFilter = new Map(); // filter -> Set(mesa)
  const manualOpenMesasByFilter = new Map(); // filter -> Map(mesa -> true/false)

  // ✅ pendentes (só UI): sessionId -> Map(itemName -> pendingMinusQty)
  const pendingBySession = new Map();

  // ✅ cache de preços: sessionId -> Map(itemNameLower -> price_cents)
  const priceBySession = new Map();

  // ✅ cache de items por pedido: pedidoId -> items[]
  const itemsByPedidoId = new Map();

  // ✅ ORDEM FIXA NO TOPO
  const itemOrderBySession = new Map(); // sessionId -> Map(nameLower -> index)
  function getItemOrderMap(sessionId) {
    const sid = Number(sessionId);
    if (!itemOrderBySession.has(sid)) itemOrderBySession.set(sid, new Map());
    return itemOrderBySession.get(sid);
  }

  // ✅ estado global "aceitar pedidos"
  let orderingOpen = true;

  // evita refresh concorrente
  let refreshRunning = false;

  // =========================
  // ✅ SOM DE NOTIFICAÇÃO
  // =========================
  let audioCtx = null;

  function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  function tocarSomPedido() {
    try {
      const ctx = getAudioCtx();
      function bip(freq, startTime, duration) {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, startTime);
        gain.gain.setValueAtTime(0.4, startTime);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
        osc.start(startTime);
        osc.stop(startTime + duration);
      }
      const t = ctx.currentTime;
      bip(880,  t,        0.18);
      bip(1100, t + 0.22, 0.18);
    } catch (e) {
      console.warn("Erro ao tocar som:", e);
    }
  }

  document.addEventListener("click", () => {
    try { getAudioCtx().resume(); } catch {}
  }, { once: true });

  // =========================
  // ✅ SEARCH PRODUTOS
  // =========================
  let produtosSearchQuery = "";

  function showSearchProdutos(show) {
    const wrap = document.getElementById("searchProdutosWrap");
    const inp  = document.getElementById("searchProdutos");
    if (!wrap) return;
    wrap.style.display = show ? "" : "none";
    if (!show && inp) { inp.value = ""; produtosSearchQuery = ""; }
  }

  // Liga o input de pesquisa de produtos
  document.addEventListener("DOMContentLoaded", () => {}, false);
  const searchProdutosInput = document.getElementById("searchProdutos");
  if (searchProdutosInput) {
    let t = null;
    searchProdutosInput.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        produtosSearchQuery = searchProdutosInput.value.trim().toLowerCase();
        if (activeFilter === "produtos") renderProdutos();
      }, 120);
    });
  }

  // =========================
  // ✅ SEARCH (abertos + nao_pago + pago)
  // =========================
  let openSearchQuery = "";

  function normalizePhone(raw) {
    let v = String(raw || "").trim().replace(/\s+/g, "");
    if (v.startsWith("+351")) v = v.slice(4);
    if (v.startsWith("00351")) v = v.slice(5);
    return v;
  }

  function canUsePhoneSearch() {
    return activeFilter === "abertos" || activeFilter === "nao_pago" || activeFilter === "pago";
  }

  function ensureOpenSearchUI() {
    if (!ordersList) return;
    if (document.getElementById("openSearchWrap")) return;

    const wrap = document.createElement("div");
    wrap.id = "openSearchWrap";
    wrap.style.display = "none";
    wrap.style.margin = "12px 0";
    wrap.innerHTML = `
      <div style="display:flex; gap:10px; align-items:center;">
        <input
          id="openSearchInput"
          type="search"
          placeholder="Pesquisar por telemóvel (ex: 9XXXXXXXX)"
          autocomplete="off"
          inputmode="tel"
          style="flex:1; padding:12px 12px; border:1px solid #e5e5e5; border-radius:14px; font-size:16px; outline:none;"
        />
        <button
          type="button"
          id="openSearchClear"
          class="btn"
          style="padding:10px 14px; border-radius:14px; font-weight:900;"
          title="Limpar"
        >✕</button>
      </div>
      <div style="margin-top:6px; font-size:12px; opacity:.7;">
        Dica: podes escrever só os últimos dígitos para encontrar o pedido e a mesa.
      </div>
    `;

    ordersList.parentNode.insertBefore(wrap, ordersList);

    const inp = document.getElementById("openSearchInput");
    const clr = document.getElementById("openSearchClear");

    let t = null;
    inp?.addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(() => {
        openSearchQuery = normalizePhone(inp.value);
        renderList();
      }, 120);
    });

    clr?.addEventListener("click", () => {
      openSearchQuery = "";
      if (inp) inp.value = "";
      renderList();
    });
  }

  function showOpenSearchUI(show) {
    ensureOpenSearchUI();
    const wrap = document.getElementById("openSearchWrap");
    if (wrap) wrap.style.display = show ? "" : "none";
  }

  function setMainTitle() {
    if (!mainTitle) return;
    mainTitle.textContent = activeFilter === "produtos" ? "📦 Produtos" : "📋 Pedidos";
  }

  function getAutoOpenSet() {
    if (!autoOpenMesasByFilter.has(activeFilter)) autoOpenMesasByFilter.set(activeFilter, new Set());
    return autoOpenMesasByFilter.get(activeFilter);
  }

  function getManualOpenMap() {
    if (!manualOpenMesasByFilter.has(activeFilter)) manualOpenMesasByFilter.set(activeFilter, new Map());
    return manualOpenMesasByFilter.get(activeFilter);
  }

  function eur(cents) {
    return (Number(cents || 0) / 100).toFixed(2) + "€";
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function fmtTime(ts) {
    if (!ts) return "—";
    return String(ts).replace("T", " ").slice(0, 16);
  }

  function fmtCustomerLine(name, phone) {
    const n = String(name || "").trim();
    const p = normalizePhone(phone);
    if (!n && !p) return "Cliente: —";
    if (n && p) return `Cliente: ${n} · ${p}`;
    if (n) return `Cliente: ${n}`;
    return `Cliente: ${p}`;
  }

  function labelEstado(status) {
    const s = String(status || "").toLowerCase();
    if (s === "preparar") return "a preparar";
    if (s === "pronto") return "servido";
    if (s === "entregue") return "servido";
    if (s === "cancelado") return "apagado";
    return "novo";
  }

  function labelFecho(session_fecho) {
    const f = String(session_fecho || "").toLowerCase();
    if (!f) return "";
    if (f === "pago") return "✅ Pago";
    if (f === "nao_pago") return "❌ Não pago";
    if (f === "auto" || f === "fechado" || f === "closed") return "🧾 Mesa fechada";
    return "🧾 Mesa fechada";
  }

  function isServidoStatus(status) {
    const s = String(status || "").toLowerCase();
    return s === "pronto" || s === "entregue";
  }

  function isServidoNaoPagoPedido(p) {
    const st = String(p?.status || "").toLowerCase();
    const servido = st === "pronto" || st === "entregue";
    const rodadaPaga = Number(p?.rodada_paga || 0) === 1;
    return servido && !rodadaPaga;
  }

  function calcPorPagarCents(pedidosDaMesa) {
    return (pedidosDaMesa || [])
      .filter(isServidoNaoPagoPedido)
      .reduce((sum, p) => sum + Number(p?.total_cents || 0), 0);
  }

  function ensurePendingMap(sessionId) {
    const sid = Number(sessionId);
    if (!pendingBySession.has(sid)) pendingBySession.set(sid, new Map());
    return pendingBySession.get(sid);
  }

  function normName(s) {
    return String(s || "").trim().toLowerCase();
  }

  function getPriceMap(sessionId) {
    const sid = Number(sessionId);
    if (!priceBySession.has(sid)) priceBySession.set(sid, new Map());
    return priceBySession.get(sid);
  }

  function rememberPricesFromItems(sessionId, items) {
    const sid = Number(sessionId);
    if (!Number.isInteger(sid) || sid <= 0) return;

    const pm = getPriceMap(sid);
    for (const it of (items || [])) {
      const key = normName(it?.name);
      const pc = Number(it?.price_cents);
      if (!key) continue;
      if (!Number.isFinite(pc) || pc <= 0) continue;
      if (!pm.has(key)) pm.set(key, pc);
    }
  }

  function cachePedidoItems(pedidoId, items) {
    const pid = Number(pedidoId);
    if (!Number.isInteger(pid) || pid <= 0) return;
    if (!Array.isArray(items)) return;
    itemsByPedidoId.set(pid, items);
  }

  function itemsToQtyMap(items) {
    const m = new Map();
    for (const it of (items || [])) {
      const name = String(it?.name || "").trim();
      const qty = Number(it?.qty || 0);
      if (!name) continue;
      if (!Number.isFinite(qty) || qty <= 0) continue;
      m.set(name, (m.get(name) || 0) + qty);
    }
    return m;
  }

  async function apiJson(url, opts) {
    const r = await fetch(url, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Pedido falhou");
    return data;
  }

  async function fecharMesa(sessionId) {
    await apiJson(`/api/worker/sessoes/${sessionId}/fechar`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fecho: "auto" })
    });
  }

  async function ensurePricesForSession(sessionId) {
    const sid = Number(sessionId);
    if (!Number.isInteger(sid) || sid <= 0) return;

    const pm = getPriceMap(sid);
    if (pm.size > 0) return;

    const candidato = listCache.find((p) => Number(p.session_id) === sid && isServidoNaoPagoPedido(p));
    if (!candidato?.id) return;

    try {
      const data = await apiJson(`/api/worker/pedidos/${candidato.id}`);
      const items = Array.isArray(data.items) ? data.items : [];
      rememberPricesFromItems(sid, items);
      cachePedidoItems(candidato.id, items);
    } catch (e) {
      console.warn("Não consegui carregar preços para sessão", sid, e);
    }
  }

  function pendingItemCents(sessionId, itemName, pendingQty) {
    const pm = getPriceMap(sessionId);
    const price = Number(pm.get(normName(itemName)) || 0);
    if (!Number.isFinite(price) || price <= 0) return null;
    return Number(pendingQty || 0) * price;
  }

  function pendingTotalCents(sessionId) {
    const sid = Number(sessionId);
    const pend = pendingBySession.get(sid);
    if (!pend || pend.size === 0) return 0;

    let total = 0;
    for (const [name, qty] of pend.entries()) {
      const c = pendingItemCents(sid, name, qty);
      if (c === null) continue;
      total += c;
    }
    return total;
  }

  async function ensureItemsForServidosNaoPagos(pedidosDaMesa) {
    const servidos = (pedidosDaMesa || []).filter(isServidoNaoPagoPedido);

    const missing = servidos
      .map((p) => Number(p?.id))
      .filter((id) => Number.isInteger(id) && id > 0 && !itemsByPedidoId.has(id));

    if (missing.length === 0) return;

    for (const pid of missing) {
      try {
        const data = await apiJson(`/api/worker/pedidos/${pid}`);
        const items = Array.isArray(data.items) ? data.items : [];
        cachePedidoItems(pid, items);

        const pedido = data.pedido || {};
        const sid = Number(pedido.session_id || 0);
        rememberPricesFromItems(sid, items);
      } catch (e) {
        console.warn("Falha a buscar items do pedido", pid, e);
      }
    }
  }

  function safeJsonParse(txt) {
    try {
      const v = JSON.parse(String(txt || ""));
      return v && typeof v === "object" && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  }

  function getSessionRow(sessionId) {
    return listCache.find((p) => Number(p.session_id) === Number(sessionId)) || null;
  }

  function getSavedStateObjectFromCache(sessionId) {
    const row = getSessionRow(sessionId);
    return safeJsonParse(row?.session_items_state_json);
  }

  async function putItemsState(sessionId, stateObj) {
    await apiJson(`/api/worker/sessoes/${sessionId}/items-state`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: stateObj })
    });
  }

  function computeDisplayItems(pedidosDaMesa) {
    const newestAny = pedidosDaMesa?.[0] || {};
    const sessionId = Number(newestAny?.session_id || 0);

    const servidosNaoPagos = (pedidosDaMesa || []).filter(isServidoNaoPagoPedido);

    if (servidosNaoPagos.length === 0) {
      const pend = ensurePendingMap(sessionId);
      return { sessionId, pend, items: [] };
    }

    const baseMap = new Map();
    for (const p of servidosNaoPagos) {
      const pid = Number(p?.id || 0);
      const cachedItems = itemsByPedidoId.get(pid);
      if (!cachedItems) continue;
      const m = itemsToQtyMap(cachedItems);
      for (const [name, qty] of m.entries()) {
        baseMap.set(name, (baseMap.get(name) || 0) + qty);
      }
    }

    if (baseMap.size === 0) {
      const pend = ensurePendingMap(sessionId);
      return { sessionId, pend, items: [] };
    }

    const savedStateObj = safeJsonParse(newestAny?.session_items_state_json);
    const savedMap = new Map();
    for (const [k, v] of Object.entries(savedStateObj)) {
      if (String(k).startsWith("__")) continue;
      const name = String(k || "").trim();
      const qty = Number(v);
      if (!name) continue;
      if (!Number.isInteger(qty) || qty < 0) continue;
      savedMap.set(name, qty);
    }

    const pend = ensurePendingMap(sessionId);

    const out = [];
    for (const [name, baseQty] of baseMap.entries()) {
      const saved = Number(savedMap.get(name) || 0);
      const pending = Number(pend.get(name) || 0);

      const shown = Math.max(0, Number(baseQty || 0) - saved - pending);
      out.push({ name, baseQty: Number(baseQty || 0), served: saved, pending, shown });
    }

    const orderMap = getItemOrderMap(sessionId);
    for (const row of out) {
      const key = normName(row.name);
      if (!orderMap.has(key)) orderMap.set(key, orderMap.size);
    }

    out.sort((a, b) => {
      const ia = orderMap.get(normName(a.name));
      const ib = orderMap.get(normName(b.name));
      const aa = Number.isInteger(ia) ? ia : 999999;
      const bb = Number.isInteger(ib) ? ib : 999999;
      if (aa !== bb) return aa - bb;
      return a.name.localeCompare(b.name, "pt-PT");
    });

    return { sessionId, pend, items: out.filter((x) => x.shown > 0 || x.pending > 0) };
  }

  async function pagarRodada() {
    if (!Number.isInteger(currentSessionId) || currentSessionId <= 0) return;
    if (!Number.isInteger(currentPedidoId) || currentPedidoId <= 0) return;

    if (currentPedidoFechado && activeFilter !== "nao_pago") {
      alert("Mesa fechada. Não podes pagar rodadas.");
      return;
    }
    if (!isServidoStatus(currentPedidoStatus)) {
      alert("Só podes pagar quando o pedido está servido.");
      return;
    }

    const msg =
      activeFilter === "nao_pago"
        ? "Marcar este pedido como pago?"
        : "Pagar esta rodada? (vai retirar estes itens do topo da mesa)";

    const ok = confirm(msg);
    if (!ok) return;

    await apiJson(`/api/worker/pedidos/${currentPedidoId}/pagar-rodada`, { method: "PUT" });

    pendingBySession.delete(currentSessionId);
    closeModal();
    await refresh();
  }

  function setLastUpdate() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    if (lastUpdate) lastUpdate.textContent = `Atualizado: ${hh}:${mm}:${ss}`;
  }

  function showEmpty(show, text = "Ainda não há pedidos.") {
    if (ordersEmpty) ordersEmpty.textContent = text;
    ordersEmpty?.classList.toggle("hidden", !show);
    ordersList?.classList.toggle("hidden", show);
  }

  function badgeClass(status) {
    const s = String(status || "novo").toLowerCase();
    const allowed = new Set(["novo", "preparar", "pronto", "entregue", "cancelado"]);
    const safe = allowed.has(s) ? s : "novo";
    return `badge ${safe}`;
  }

  function openModal() {
    if (!modal) return;
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeModal() {
    if (!modal) return;
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");

    currentPedidoId = null;
    currentPedidoFechado = false;
    currentPedidoFechoLabel = "";

    currentSessionId = null;
    currentPedidoStatus = "";
    currentPedidoItems = [];

    currentMesaKey = null;

    const payBtn = document.getElementById("btnPayRound");
    if (payBtn) payBtn.remove();

    statusBtns.forEach((b) => (b.style.display = ""));
    modalFooter?.classList.remove("hidden");

    modalItems && (modalItems.innerHTML = "");
    modalNotes && (modalNotes.textContent = "");
    modalNotesWrap?.classList.add("hidden");
  }

  function baseMesaName(p) {
    return String(p.mesa_nome ?? p.mesa ?? "—");
  }

  function groupKey(p) {
    const mesa = baseMesaName(p);
    const sid = p?.session_id;

    if (activeFilter === "pago" || activeFilter === "nao_pago") {
      return `${mesa} · Sessão ${sid ?? "—"}`;
    }
    return mesa;
  }

  function groupByMesa(pedidos) {
    const map = new Map();
    for (const p of pedidos || []) {
      const key = groupKey(p);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(p);
    }

    const arr = Array.from(map.entries());

    function listLatestTime(list) {
      let best = 0;
      for (const p of list) {
        const t = new Date(p.updated_at || p.created_at || 0).getTime();
        if (t > best) best = t;
      }
      return best;
    }

    const isArchive = activeFilter === "pago" || activeFilter === "nao_pago";

    if (isArchive) {
      arr.sort((a, b) => {
        const at = listLatestTime(a[1]);
        const bt = listLatestTime(b[1]);
        if (at !== bt) return bt - at;
        return String(a[0]).localeCompare(String(b[0]), "pt-PT");
      });

      for (const [, list] of arr) {
        list.sort((a, b) => {
          const da = new Date(a.updated_at || a.created_at || 0).getTime();
          const db = new Date(b.updated_at || b.created_at || 0).getTime();
          return db - da;
        });
      }

      return arr;
    }

    function mesaHasNovo(list) {
      return list.some((p) => String(p?.status || "").toLowerCase() === "novo");
    }

    arr.sort((a, b) => {
      const aList = a[1], bList = b[1];

      const aNovo = mesaHasNovo(aList);
      const bNovo = mesaHasNovo(bList);

      if (aNovo !== bNovo) return aNovo ? -1 : 1;

      const at = listLatestTime(aList);
      const bt = listLatestTime(bList);
      if (at !== bt) return bt - at;

      return String(a[0]).localeCompare(String(b[0]), "pt-PT");
    });

    function statusRank(p) {
      const s = String(p?.status || "novo").toLowerCase();
      const rodadaPaga = Number(p?.rodada_paga || 0) === 1;
      const servido = s === "pronto" || s === "entregue";

      if (s === "novo") return 0;
      if (s === "preparar") return 1;

      if (servido && !rodadaPaga) return 90;
      if (servido && rodadaPaga) return 95;

      if (s === "cancelado") return 99;
      return 50;
    }

    for (const [, list] of arr) {
      list.sort((a, b) => {
        const ra = statusRank(a);
        const rb = statusRank(b);
        if (ra !== rb) return ra - rb;

        const da = new Date(a.updated_at || a.created_at || 0).getTime();
        const db = new Date(b.updated_at || b.created_at || 0).getTime();
        return db - da;
      });
    }

    return arr;
  }

  function filterListForOpenSearch(list) {
    if (!canUsePhoneSearch()) return list;

    const q = normalizePhone(openSearchQuery);
    if (!q) return list;

    return (list || []).filter((p) => {
      const phone = normalizePhone(p?.customer_phone);
      if (!phone) return false;
      return phone.includes(q);
    });
  }

  function renderProdutos() {
    if (!ordersList) return;

    if (!Array.isArray(productsCache) || productsCache.length === 0) {
      ordersList.innerHTML = "";
      showEmpty(true, "Ainda não há produtos.");
      return;
    }

    showEmpty(false, "Ainda não há produtos.");

    const q = produtosSearchQuery.toLowerCase();

    const sorted = [...productsCache]
      .filter((p) => {
        if (!q) return true;
        const nome = String(p.nome ?? p.name ?? "").toLowerCase();
        const cat  = String(p.categoria ?? p.category ?? "").toLowerCase();
        return nome.includes(q) || cat.includes(q);
      })
      .sort((a, b) => {
      const an = String(a.nome ?? a.name ?? "").localeCompare(String(b.nome ?? b.name ?? ""), "pt-PT");
      return an;
    });

    if (sorted.length === 0) {
      showEmpty(true, q ? `Sem resultados para "${produtosSearchQuery}".` : "Ainda não há produtos.");
      return;
    }

    ordersList.innerHTML = sorted.map((p) => {
      const id = Number(p.id);
      const nome = p.nome ?? p.name ?? "—";
      const categoria = p.categoria ?? p.category ?? "—";
      const descricao = p.descricao ?? p.description ?? "";
      const preco =
        p.preco_cents != null ? eur(p.preco_cents)
        : p.price_cents != null ? eur(p.price_cents)
        : p.preco != null ? `${Number(p.preco).toFixed(2)}€`
        : p.price != null ? `${Number(p.price).toFixed(2)}€`
        : "—";

      const esgotado = Number(p.esgotado || 0) === 1;

      return `
        <div class="order">
          <div class="order-top">
            <div>
              <div class="order-title" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                <span>${escapeHtml(nome)}</span>
                <span class="badge ${esgotado ? "cancelado" : "pronto"}">
                  ${esgotado ? "esgotado" : "ativo"}
                </span>
              </div>

              <div class="order-sub">Categoria: ${escapeHtml(categoria)}</div>
              ${descricao ? `<div class="order-sub">${escapeHtml(descricao)}</div>` : ""}
            </div>

            <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
              <div class="muted">${escapeHtml(preco)}</div>

              <button
                type="button"
                class="btn ${esgotado ? "" : "danger"}"
                data-toggle-esgotado="${id}"
                data-next-esgotado="${esgotado ? 0 : 1}"
                style="padding:8px 12px; border-radius:999px; font-weight:900;"
              >
                ${esgotado ? "Disponível" : "Esgotado"}
              </button>
            </div>
          </div>
        </div>
      `;
    }).join("");

    ordersList.querySelectorAll("[data-toggle-esgotado]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const id = Number(btn.getAttribute("data-toggle-esgotado"));
        const next = Number(btn.getAttribute("data-next-esgotado")) === 1 ? 1 : 0;

        if (!Number.isInteger(id) || id <= 0) return;

        const ok = confirm(
          next === 1
            ? "Marcar este produto como esgotado?"
            : "Voltar a marcar este produto como disponível?"
        );
        if (!ok) return;

        const oldText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "A guardar...";

        try {
          await apiJson(`/api/worker/produtos/${id}/esgotado`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ esgotado: next })
          });

          await refresh();
        } catch (err) {
          console.warn("Erro a atualizar esgotado:", err);
          alert(err.message || "Erro a atualizar produto");
          btn.disabled = false;
          btn.textContent = oldText;
        }
      });
    });
  }

  function renderOnlyArchivePedidos(filteredCache) {
    if (!ordersList) return;

    const sorted = [...(filteredCache || [])].sort((a, b) => {
      const da = new Date(a.updated_at || a.created_at || 0).getTime();
      const db = new Date(b.updated_at || b.created_at || 0).getTime();
      return db - da;
    });

    ordersList.innerHTML = sorted
      .map((p) => {
        const customerLine = fmtCustomerLine(p.customer_name, p.customer_phone);

        return `
          <div class="order" role="button" tabindex="0" data-open="${p.id}">
            <div class="order-top">
              <div>
                <div class="order-title" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                  <span>Pedido</span>
                </div>

                <div class="order-sub">Mesa: ${escapeHtml(baseMesaName(p))}</div>
                <div class="order-sub">Sessão: ${escapeHtml(p.session_id ?? "—")}</div>
                <div class="order-sub">${escapeHtml(customerLine)}</div>
              </div>

              <div class="muted">${eur(p.total_cents || 0)}</div>
            </div>

            <div class="order-items-preview">
              Atualizado: ${fmtTime(p.updated_at || p.created_at)}
            </div>
            ${p.items_preview ? `<div class="order-items-preview" style="font-weight:700; color:#2d2a26;">${escapeHtml(p.items_preview)}</div>` : ""}
          </div>
        `;
      })
      .join("");

    ordersList.querySelectorAll("[data-open]").forEach((el) => {
      const handler = async (e) => {
        e.stopPropagation();

        const id = Number(el.getAttribute("data-open"));
        if (!Number.isFinite(id) || id <= 0) return;
        await openPedido(id);
      };

      el.addEventListener("click", handler);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") handler(e);
      });
    });
  }

  function renderList() {
    if (!ordersList) return;

    setMainTitle();

    if (activeFilter === "produtos") {
      showOpenSearchUI(false);
      closeModal();
      renderProdutos();
      return;
    }

    showOpenSearchUI(canUsePhoneSearch());

    const filteredCache = filterListForOpenSearch(listCache);

    if (!Array.isArray(filteredCache) || filteredCache.length === 0) {
      ordersList.innerHTML = "";
      showEmpty(true, "Ainda não há pedidos.");
      return;
    }

    showEmpty(false, "Ainda não há pedidos.");

    if (activeFilter === "nao_pago" || activeFilter === "pago") {
      renderOnlyArchivePedidos(filteredCache);
      return;
    }

    const autoSet = getAutoOpenSet();
    const manualMap = getManualOpenMap();

    const grouped = groupByMesa(filteredCache);

    ordersList.innerHTML = grouped
      .map(([mesaGroupLabel, pedidos]) => {
        const isOpen = manualMap.has(mesaGroupLabel) ? manualMap.get(mesaGroupLabel) : autoSet.has(mesaGroupLabel);

        const count = pedidos.length;

        const totalMesaCentsServidos = pedidos
          .filter((p) => isServidoStatus(p?.status))
          .reduce((sum, p) => sum + Number(p?.total_cents || 0), 0);

        const newest = pedidos[0];

        const sessionId = Number(newest?.session_id || 0);
        const sessionFecho = newest?.session_fecho ?? null;
        const fechado = !!sessionFecho;

        const fechoLabel = labelFecho(sessionFecho);

        const { pend, items } = computeDisplayItems(pedidos);
        const hasPending = pend.size > 0;

        const porPagarBaseCents = calcPorPagarCents(pedidos);

        const hasAnyPending = (pendingBySession.get(Number(sessionId))?.size || 0) > 0;
        const pendingCentsTotal = pendingTotalCents(sessionId);

        const porPagarShownCents = Math.max(0, porPagarBaseCents - pendingCentsTotal);

        const botoesFechoHtml = fechado
          ? `<span class="badge pronto" style="margin-left:6px;">${escapeHtml(fechoLabel)}</span>`
          : `
            <span style="display:inline-flex; gap:6px;">
              <button
                type="button"
                class="btn primary"
                data-fechar-mesa="${sessionId}"
                style="padding:8px 12px; border-radius:999px;"
              >
                Fechar mesa
              </button>
            </span>
          `;

        const guardarHtml =
          (!fechado && hasPending)
            ? `
              <button type="button" class="btn primary" data-guardar-session="${sessionId}" style="padding:8px 12px; border-radius:999px; margin-left:8px;">Guardar</button>
              <button type="button" class="btn" data-naoguardar-session="${sessionId}" style="padding:8px 12px; border-radius:999px; margin-left:8px;">Não guardar</button>
            `
            : "";

        const mesaItemsHtml = items.length
          ? `
            <div style="margin-top:10px; display:grid; gap:10px;">
              ${items.map(it => {
                const pendingTxt = (() => {
                  const q = Number(it.pending || 0);
                  if (q <= 0) return "";

                  const cents = pendingItemCents(sessionId, it.name, q);
                  if (cents === null) {
                    return `<span style="opacity:.65; font-weight:800; margin-left:8px;">(x${q} pendente)</span>`;
                  }
                  return `<span style="opacity:.65; font-weight:800; margin-left:8px;">(x${q} pendente: ${eur(cents)})</span>`;
                })();

                return `
                  <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; font-size:18px; font-weight:900; line-height:1.2;">
                    <span>
                      ${escapeHtml(it.name)}
                      <span style="opacity:.85; font-weight:900; margin-left:6px;">x${it.shown}</span>
                      ${pendingTxt}
                    </span>

                    ${
                      fechado
                        ? ""
                        : `
                          <button
                            type="button"
                            class="btn"
                            data-minus="1"
                            data-session-id="${sessionId}"
                            data-item-name="${escapeHtml(it.name)}"
                            style="padding:6px 14px; border-radius:999px; font-weight:900; min-width:46px; font-size:18px;"
                            title="Retirar 1 (pendente)"
                          >−</button>
                        `
                    }
                  </div>
                `;
              }).join("")}
            </div>
          `
          : "";

        const pedidosHtml = pedidos
          .map((p) => {
            const status = p.status || "novo";
            const customerLine = fmtCustomerLine(p.customer_name, p.customer_phone);
            return `
              <div class="order" role="button" tabindex="0" data-open="${p.id}">
                <div class="order-top">
                  <div>
                    <div class="order-title" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                      <span>
                        Pedido
                        <span class="${badgeClass(status)}">${escapeHtml(labelEstado(status))}</span>
                        ${
                          (isServidoStatus(status) && Number(p.rodada_paga || 0) === 1)
                            ? `<span class="badge pago" style="margin-left:8px;">pago</span>`
                            : ""
                        }
                      </span>
                    </div>

                    <div class="order-sub">Sessão: ${escapeHtml(p.session_id ?? "—")}</div>
                    <div class="order-sub">${escapeHtml(customerLine)}</div>
                  </div>
                  <div class="muted">${eur(p.total_cents || 0)}</div>
                </div>
                ${p.items_preview ? `<div class="order-items-preview" style="font-weight:700; color:#2d2a26; margin-bottom:4px;">${escapeHtml(p.items_preview)}</div>` : ""}
                ${p.notes ? `<div class="order-items-preview" style="color:#a84f0e; font-style:italic;">📝 ${escapeHtml(p.notes)}</div>` : ""}
                <div class="order-items-preview">Atualizado: ${fmtTime(p.updated_at)}</div>
              </div>
            `;
          })
          .join("");

        return `
          <div class="order" data-mesa="${escapeHtml(mesaGroupLabel)}">
            <div class="order-top" style="cursor:pointer;" data-mesa-toggle="${escapeHtml(mesaGroupLabel)}" aria-expanded="${isOpen ? "true" : "false"}">
              <div>
                <div class="order-title" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                  <span>${escapeHtml(activeFilter === "pago" || activeFilter === "nao_pago" ? mesaGroupLabel : `Mesa: ${mesaGroupLabel}`)}</span>
                  ${botoesFechoHtml}
                  ${guardarHtml}
                </div>

                <div class="order-sub">
                  ${count} pedido(s)
                  ${totalMesaCentsServidos > 0 ? ` · Total: ${eur(totalMesaCentsServidos)}` : ""}
                  ${porPagarBaseCents > 0 ? ` · <b>Por pagar:</b> ${eur(porPagarShownCents)}` : ""}
                  ${
                    hasAnyPending
                      ? ` · <b>Pendentes por pagar:</b> ${pendingCentsTotal > 0 ? eur(pendingCentsTotal) : "—"}`
                      : ""
                  }
                </div>

                ${mesaItemsHtml}
              </div>

              <div class="muted">
                ${fmtTime(newest?.updated_at || newest?.created_at)}
                <span class="mesa-chev" style="font-weight:900; margin-left:8px;">${isOpen ? "▴" : "▾"}</span>
              </div>
            </div>

            <div class="${isOpen ? "" : "hidden"}" data-mesa-body="${escapeHtml(mesaGroupLabel)}" style="margin-top:12px; display:grid; gap:10px;">
              ${pedidosHtml}
            </div>
          </div>
        `;
      })
      .join("");

    ordersList.querySelectorAll("[data-mesa-toggle]").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target && e.target.closest && e.target.closest("[data-fechar-mesa], [data-minus], [data-guardar-session], [data-naoguardar-session]")) return;
        e.preventDefault();

        const mesa = el.getAttribute("data-mesa-toggle") || "—";
        const body = ordersList.querySelector(`[data-mesa-body="${CSS.escape(mesa)}"]`);
        const isOpen = el.getAttribute("aria-expanded") === "true";
        const nextOpen = !isOpen;

        el.setAttribute("aria-expanded", nextOpen ? "true" : "false");

        const chevron = el.querySelector(".mesa-chev");
        if (chevron) chevron.textContent = nextOpen ? "▴" : "▾";

        body?.classList.toggle("hidden", !nextOpen);

        const manualMap = getManualOpenMap();
        manualMap.set(mesa, nextOpen);
      });
    });

    ordersList.querySelectorAll("[data-fechar-mesa]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const sid = Number(btn.getAttribute("data-fechar-mesa"));
        if (!Number.isInteger(sid) || sid <= 0) return;

        const ok = confirm("Fechar esta mesa?");
        if (!ok) return;

        try {
          await fecharMesa(sid);
          pendingBySession.delete(sid);
          await refresh();
        } catch (err) {
          console.warn("Erro a fechar mesa:", err);
          alert(err.message || "Erro a fechar a mesa");
        }
      });
    });

    ordersList.querySelectorAll("[data-minus]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const sid = Number(btn.getAttribute("data-session-id"));
        const name = btn.getAttribute("data-item-name");
        if (!Number.isInteger(sid) || sid <= 0) return;
        if (!name) return;

        const pedidos = listCache.filter((p) => Number(p.session_id) === sid);
        const { items } = computeDisplayItems(pedidos);

        const it = items.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
        if (!it) return;
        if (Number(it.shown || 0) <= 0) return;

        const pend = ensurePendingMap(sid);
        pend.set(it.name, Number(pend.get(it.name) || 0) + 1);

        await ensurePricesForSession(sid);

        renderList();
      });
    });

    ordersList.querySelectorAll("[data-guardar-session]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();

        const sid = Number(btn.getAttribute("data-guardar-session"));
        if (!Number.isInteger(sid) || sid <= 0) return;

        const map = pendingBySession.get(sid);
        if (!map || map.size === 0) return;

        const ok = confirm("Guardar alterações desta mesa?");
        if (!ok) return;

        const oldText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "A guardar...";

        try {
          const state = getSavedStateObjectFromCache(sid);
          for (const [name, dec] of map.entries()) {
            const cur = Number(state[name] || 0);
            state[name] = cur + Number(dec || 0);
          }
          await putItemsState(sid, state);

          pendingBySession.delete(sid);
          btn.textContent = "Guardado ✅";
          await refresh();

          setTimeout(() => {
            btn.disabled = false;
            btn.textContent = oldText || "Guardar";
          }, 650);
        } catch (err) {
          console.warn("Erro a guardar:", err);
          alert(err.message || "Erro a guardar alterações");
          btn.disabled = false;
          btn.textContent = oldText || "Guardar";
          await refresh();
        }
      });
    });

    ordersList.querySelectorAll("[data-naoguardar-session]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();

        const sid = Number(btn.getAttribute("data-naoguardar-session"));
        if (!Number.isInteger(sid) || sid <= 0) return;

        const map = pendingBySession.get(sid);
        if (!map || map.size === 0) return;

        const ok = confirm("Descartar alterações pendentes desta mesa?");
        if (!ok) return;

        pendingBySession.delete(sid);
        renderList();
      });
    });

    ordersList.querySelectorAll("[data-open]").forEach((el) => {
      const handler = async (e) => {
        e.stopPropagation();

        const id = Number(el.getAttribute("data-open"));
        if (!Number.isFinite(id) || id <= 0) return;
        await openPedido(id);
      };

      el.addEventListener("click", handler);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") handler(e);
      });
    });
  }

  async function refreshPedidos() {
    const prevIds = new Set((listCache || []).map((p) => Number(p?.id)).filter((x) => Number.isFinite(x)));

    const data = await apiJson(`/api/worker/pedidos?status=${encodeURIComponent(activeFilter)}`);
    listCache = Array.isArray(data.pedidos) ? data.pedidos : [];

    const byGroup = new Map();
    for (const p of listCache) {
      const key = groupKey(p);
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(p);
    }

    for (const [, pedidosMesa] of byGroup.entries()) {
      await ensureItemsForServidosNaoPagos(pedidosMesa);
    }

    const autoSet = new Set();
    for (const [grp, pedidosMesa] of byGroup.entries()) {
      const hasNovo = pedidosMesa.some((p) => String(p?.status || "").toLowerCase() === "novo");
      if (hasNovo) autoSet.add(grp);
    }
    autoOpenMesasByFilter.set(activeFilter, autoSet);

    const manualMap = getManualOpenMap();
    let temPedidoNovo = false;

    for (const p of listCache) {
      const id = Number(p?.id);
      if (!Number.isFinite(id)) continue;

      const isNew = !prevIds.has(id);
      const isNovo = String(p?.status || "").toLowerCase() === "novo";
      if (isNew && isNovo) {
        manualMap.set(groupKey(p), true);
        temPedidoNovo = true;
      }
    }

    if (temPedidoNovo) tocarSomPedido();
  }

  async function refreshProdutos() {
    const data = await apiJson("/api/worker/produtos");
    productsCache = Array.isArray(data.produtos) ? data.produtos : [];
  }

  async function refresh() {
    if (refreshRunning) return;
    refreshRunning = true;

    try {
      if (activeFilter === "produtos") {
        await refreshProdutos();
        renderList();
        setLastUpdate();
        return;
      }

      await refreshPedidos();
      renderList();
      setLastUpdate();
    } catch (e) {
      console.warn(activeFilter === "produtos" ? "Erro a carregar produtos:" : "Erro a carregar pedidos:", e);

      if (activeFilter === "produtos") {
        productsCache = [];
      } else {
        listCache = [];
        autoOpenMesasByFilter.set(activeFilter, new Set());
      }

      renderList();
      setLastUpdate();
    } finally {
      refreshRunning = false;
    }
  }

  function ensurePayButtonVisible(shouldShow, label = "Pagar rodada") {
    if (!modalFooter) return;

    let btn = document.getElementById("btnPayRound");
    if (!shouldShow) {
      if (btn) btn.remove();
      return;
    }

    if (!btn) {
      btn = document.createElement("button");
      btn.id = "btnPayRound";
      btn.type = "button";
      btn.className = "btn primary";
      btn.style.padding = "12px 18px";
      btn.style.borderRadius = "14px";
      btn.style.fontWeight = "900";

      btn.addEventListener("click", async () => {
        try {
          btn.disabled = true;
          const old = btn.textContent;
          btn.textContent = "A pagar...";
          await pagarRodada();
          btn.textContent = old;
          btn.disabled = false;
        } catch (err) {
          console.warn("Erro a pagar:", err);
          alert(err.message || "Erro a pagar");
          btn.disabled = false;
          btn.textContent = label;
        }
      });

      modalFooter.appendChild(btn);
    }

    btn.textContent = label;
  }

  async function openPedido(id) {
    try {
      const data = await apiJson(`/api/worker/pedidos/${id}`);
      const pedido = data.pedido || {};
      const items = Array.isArray(data.items) ? data.items : [];

      currentPedidoId = Number(pedido.id ?? id);
      currentSessionId = Number(pedido.session_id || 0);
      currentPedidoStatus = String(pedido.status || "");
      currentPedidoItems = items;

      cachePedidoItems(currentPedidoId, items);
      rememberPricesFromItems(currentSessionId, items);

      currentPedidoFechado = !!pedido.session_fecho;
      currentPedidoFechoLabel = labelFecho(pedido.session_fecho);

      currentMesaKey = baseMesaName(pedido);

      modalTitle && (modalTitle.textContent = `Pedido #${pedido.id ?? id} — Mesa ${pedido.mesa_nome || "—"}`);

      const baseSub = `Estado: ${labelEstado(pedido.status)} · ${fmtTime(pedido.created_at)}`;
      const customerLine = fmtCustomerLine(pedido.customer_name, pedido.customer_phone);

      if (currentPedidoFechado) {
        modalSub && (modalSub.innerHTML =
          `${escapeHtml(baseSub)}<br>${escapeHtml(customerLine)}<br><span class="muted">Mesa fechada — pedido bloqueado</span>`
        );
      } else {
        modalSub && (modalSub.innerHTML = `${escapeHtml(baseSub)}<br>${escapeHtml(customerLine)}`);
      }

      if (modalItems) {
        modalItems.innerHTML = items.map((it) => {
          const line = Number(it.line_total_cents ?? (it.qty * it.price_cents));
          return `
            <div class="order-item">
              <div>
                <div class="name">${escapeHtml(it.name)}</div>
                <div class="sub">x${it.qty} · ${eur(it.price_cents)}</div>
              </div>
              <div class="right">${eur(line)}</div>
            </div>
          `;
        }).join("");
      }

      const notes = String(pedido.notes || "").trim();
      if (notes) {
        modalNotesWrap?.classList.remove("hidden");
        modalNotes && (modalNotes.textContent = notes);
      } else {
        modalNotesWrap?.classList.add("hidden");
        modalNotes && (modalNotes.textContent = "");
      }

      modalTotal && (modalTotal.textContent = `Total: ${eur(pedido.total_cents || 0)}`);

      const servido = isServidoStatus(pedido.status);
      const isNovo = String(pedido.status || "").toLowerCase() === "novo";
      const jaPago = Number(pedido.rodada_paga || 0) === 1;

      const oldPaid = document.getElementById("paidBadge");
      if (oldPaid) oldPaid.remove();

      if (servido && jaPago && modalSub) {
        const badge = document.createElement("span");
        badge.id = "paidBadge";
        badge.className = "badge pronto";
        badge.style.marginLeft = "8px";
        badge.textContent = "pago";
        modalSub.appendChild(badge);
      }

      if (currentPedidoFechado && activeFilter !== "nao_pago") {
        ensurePayButtonVisible(false);
        statusBtns.forEach((b) => (b.style.display = "none"));
        modalFooter?.classList.add("hidden");
        openModal();
        return;
      }

      if (servido) {
        statusBtns.forEach((b) => (b.style.display = "none"));

        if (!jaPago) {
          const btnLabel = activeFilter === "nao_pago" ? "Pagar pedido" : "Pagar rodada";
          ensurePayButtonVisible(true, btnLabel);
          modalFooter?.classList.remove("hidden");
        } else {
          ensurePayButtonVisible(false);
          modalFooter?.classList.add("hidden");
        }

        openModal();
        return;
      }

      ensurePayButtonVisible(false);
      statusBtns.forEach((b) => {
        const st = b.getAttribute("data-setstatus");
        if (st === "cancelado") {
          b.style.display = isNovo ? "" : "none";
        } else {
          b.style.display = "";
        }
      });

      modalFooter?.classList.remove("hidden");
      openModal();
    } catch (e) {
      console.warn("Erro a abrir pedido:", e);
      alert(e.message || "Erro a abrir pedido");
    }
  }

  async function setStatus(next) {
    if (!currentPedidoId) return;

    if (currentPedidoFechado) {
      alert("Mesa fechada. Não podes alterar estados.");
      return;
    }

    const allowed = new Set(["novo", "preparar", "pronto", "entregue", "cancelado"]);
    if (!allowed.has(next)) return;

    if (next === "cancelado") {
      const ok = confirm("Apagar pedido? (Vai ficar como apagado/cancelado)");
      if (!ok) return;
    }

    try {
      await apiJson(`/api/worker/pedidos/${currentPedidoId}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next })
      });

      const idx = listCache.findIndex((p) => Number(p.id) === Number(currentPedidoId));
      if (idx >= 0) {
        listCache[idx] = { ...listCache[idx], status: next, updated_at: new Date().toISOString() };
      }

      if ((next === "pronto" || next === "entregue") && currentPedidoId) {
        try {
          const d = await apiJson(`/api/worker/pedidos/${currentPedidoId}`);
          const its = Array.isArray(d.items) ? d.items : [];
          cachePedidoItems(currentPedidoId, its);
          const pedido = d.pedido || {};
          rememberPricesFromItems(Number(pedido.session_id || 0), its);
        } catch (e) {
          console.warn("Falha a preencher cache ao servir", e);
        }
      }

      if ((next === "pronto" || next === "entregue") && currentMesaKey && activeFilter === "abertos") {
        const stillHasNovo = listCache.some((p) =>
          String(baseMesaName(p)) === String(currentMesaKey) &&
          String(p.status || "").toLowerCase() === "novo"
        );

        if (!stillHasNovo) {
          const manualMap = getManualOpenMap();
          manualMap.set(currentMesaKey, false);
        }
      }

      closeModal();
      await refresh();
    } catch (e) {
      console.warn("Erro a atualizar estado:", e);
      alert(e.message || "Erro a atualizar estado");
    }
  }

  async function fetchOrderingStatus() {
    try {
      const r = await fetch("/api/public/ordering-status", { cache: "no-store" });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "Falhou");
      if (typeof data.open !== "boolean") throw new Error("Resposta inválida");
      return data.open;
    } catch (e) {
      console.warn("⚠️ ordering-status falhou:", e);
      return null;
    }
  }

  function renderOrderingUI(open) {
    orderingOpen = !!open;

    if (orderingPill) {
      orderingPill.textContent = orderingOpen ? "Mesas: ABERTAS" : "Mesas: FECHADAS";
      orderingPill.style.background = orderingOpen ? "#eaf2ff" : "rgba(214,69,69,.12)";
      orderingPill.style.color = orderingOpen ? "#1f4fa3" : "#b13b3b";
    }

    if (btnOpenOrdering) btnOpenOrdering.disabled = orderingOpen;
    if (btnCloseOrdering) btnCloseOrdering.disabled = !orderingOpen;
  }

  async function setOrdering(open) {
    const url = open ? "/api/worker/ordering/open" : "/api/worker/ordering/close";
    const r = await fetch(url, { method: "PUT" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Falhou");
    renderOrderingUI(!!data.open);
  }

  async function refreshOrderingPill() {
    const v = await fetchOrderingStatus();
    if (v === null) return;
    renderOrderingUI(v);
  }

  btnOpenOrdering?.addEventListener("click", async () => {
    const ok = confirm("Abrir mesas e aceitar pedidos novamente?");
    if (!ok) return;

    try {
      btnOpenOrdering.disabled = true;
      await setOrdering(true);
    } catch (e) {
      alert(e.message || "Erro a abrir mesas");
    } finally {
      await refreshOrderingPill();
    }
  });

  btnCloseOrdering?.addEventListener("click", async () => {
    const ok = confirm("Fechar mesas? (clientes deixam de conseguir fazer pedidos)");
    if (!ok) return;

    try {
      btnCloseOrdering.disabled = true;
      await setOrdering(false);
    } catch (e) {
      alert(e.message || "Erro a fechar mesas");
    } finally {
      await refreshOrderingPill();
    }
  });

  chips.forEach((btn) => {
    btn.addEventListener("click", () => {
      chips.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeFilter = btn.getAttribute("data-filter") || "abertos";

      if (!canUsePhoneSearch()) openSearchQuery = "";

      showSearchProdutos(activeFilter === "produtos");
      setMainTitle();
      refresh();
    });
  });

  btnRefresh?.addEventListener("click", refresh);

  btnCloseModal?.addEventListener("click", closeModal);
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  statusBtns.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const next = btn.getAttribute("data-setstatus");
      if (!next) return;

      if (next === "cancelado") {
        if (!currentPedidoId) return;

        const ok = confirm("Eliminar este pedido PERMANENTEMENTE?");
        if (!ok) return;

        try {
          await apiJson(`/api/worker/pedidos/${currentPedidoId}`, { method: "DELETE" });
          closeModal();
          await refresh();
        } catch (e) {
          console.warn("Erro a apagar pedido:", e);
          alert(e.message || "Erro a apagar pedido");
        }
        return;
      }

      setStatus(next);
    });
  });

  setMainTitle();
  refreshOrderingPill();
  setInterval(refreshOrderingPill, 1500);

  refresh();
  setInterval(refresh, 1000);
});