// admin.js — versão corrigida
// ✅ Aba "Faturação" com seletor de datas (desde / até)
// ✅ refreshMesas() corrigido para usar array direto da API
// ✅ Total faturado separado na sua própria aba

function eurFromInput(value){
  const n = Number(String(value).replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}
function eur(cents){ return (cents/100).toFixed(2) + "€"; }

async function apiGet(url){
  const r = await fetch(url);
  const data = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(data.error || "GET falhou");
  return data;
}

async function apiPostJson(url, body){
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(body || {})
  });
  const data = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(data.error || "POST falhou");
  return data;
}

async function apiPutJson(url, body){
  const r = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(body || {})
  });
  const data = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(data.error || "PUT falhou");
  return data;
}

async function apiDelete(url){
  const r = await fetch(url, { method: "DELETE" });
  const data = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(data.error || "DELETE falhou");
  return data;
}

async function apiPostMultipart(url, formData){
  const r = await fetch(url, { method: "POST", body: formData });
  const data = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(data.error || "UPLOAD falhou");
  return data;
}

// ------------------ TABS ------------------

function setTab(tab){
  const ids = ["tabProdutos","tabMesas","tabCartazes","tabFaturacao"];
  const secs = ["secProdutos","secMesas","secCartazes","secFaturacao"];

  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove("active");
  });
  secs.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add("hidden");
  });

  const tabMap = {
    "produtos":   ["tabProdutos",   "secProdutos"],
    "mesas":      ["tabMesas",      "secMesas"],
    "cartazes":   ["tabCartazes",   "secCartazes"],
    "faturacao":  ["tabFaturacao",  "secFaturacao"],
  };

  const pair = tabMap[tab] || tabMap["produtos"];
  const tabEl = document.getElementById(pair[0]);
  const secEl = document.getElementById(pair[1]);

  if (tabEl) tabEl.classList.add("active");
  if (secEl) secEl.classList.remove("hidden");

  window.location.hash = tab;
}

// ------------------ MESAS ------------------

// Cache em memória: mesaId -> dataURL (evita gerar de novo enquanto a página está aberta)
const _qrCache = new Map();

async function refreshMesas(){
  const data = await apiGet("/api/admin/mesas");
  const list = Array.isArray(data) ? data : (data.mesas || []);
  renderMesas(list);
}

function renderMesas(list){
  const el = document.getElementById("tablesList");
  if (!el) return;

  el.innerHTML = "";

  if (!Array.isArray(list) || !list.length){
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "Ainda não criaste mesas.";
    el.appendChild(empty);
    return;
  }

  list.forEach(m => {
    const row = document.createElement("div");
    row.className = "table-row";

    const left = document.createElement("div");
    left.className = "table-left";

    const title = document.createElement("div");
    title.className = "table-title";
    title.textContent = m.nome;

    const link = document.createElement("div");
    link.className = "table-link";
    link.textContent = m.link;

    left.appendChild(title);
    left.appendChild(link);

    const actions = document.createElement("div");
    actions.className = "table-actions";

    // Botão Copiar link
    const btnCopy = document.createElement("button");
    btnCopy.type = "button";
    btnCopy.className = "ghost";
    btnCopy.textContent = "Copiar link";
    btnCopy.addEventListener("click", async () => {
      try{
        await navigator.clipboard.writeText(m.link);
        btnCopy.textContent = "Copiado ✓";
        setTimeout(() => { btnCopy.textContent = "Copiar link"; }, 1500);
      }catch{
        prompt("Copia o link:", m.link);
      }
    });

    // Botão QR —
    // Se o servidor já tem qr_path guardado OU já está em cache local → "Ver QR code"
    // Caso contrário → "Gerar QR code"
    const btnQr = document.createElement("button");
    btnQr.type = "button";
    btnQr.className = "ghost";

    const jaGuardado = !!m.qr_path;           // vem do servidor (persistente)
    const jaEmCache  = _qrCache.has(m.id);    // gerado nesta sessão de página

    btnQr.textContent = (jaGuardado || jaEmCache) ? "Ver QR code" : "Gerar QR code";

    // Se o servidor já tem o ficheiro PNG, pré-carrega no cache
    if (jaGuardado && !jaEmCache){
      // Guarda o URL público no cache como string (não dataURL, mas funciona igual no modal)
      _qrCache.set(m.id, { type: "url", src: m.qr_path });
    }

    btnQr.addEventListener("click", () => openQrModal(m, btnQr));

    // Botão Eliminar mesa
    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "ghost danger";
    btnDel.textContent = "Eliminar";
    btnDel.addEventListener("click", async () => {
      if (!confirm(`Tens a certeza que queres eliminar a mesa "${m.nome}"?\nEsta ação não pode ser desfeita.`)) return;
      try {
        await apiDelete(`/api/admin/mesas/${m.id}`);
        _qrCache.delete(m.id);
        await refreshMesas();
      } catch(err) {
        alert(err.message || "Erro a eliminar mesa.");
      }
    });

    actions.appendChild(btnCopy);
    actions.appendChild(btnQr);
    actions.appendChild(btnDel);
    row.appendChild(left);
    row.appendChild(actions);
    el.appendChild(row);
  });
}

// Abre o modal — gera QR se necessário e guarda no servidor
async function openQrModal(mesa, btnQr){
  // 1. Já está em cache → abre directo
  if (_qrCache.has(mesa.id)){
    const cached = _qrCache.get(mesa.id);
    const src = cached.type === "url"
      ? cached.src                  // URL do servidor (ex: /uploads/qrcodes/qr-mesa-3.png)
      : cached;                     // dataURL gerado no browser
    showQrModal(mesa, src);
    return;
  }

  // 2. Precisa de gerar
  if (!window.QRCode){
    alert("Biblioteca QRCode ainda não carregou. Tenta de novo.");
    return;
  }

  btnQr.textContent = "A gerar…";
  btnQr.disabled = true;

  try {
    const canvas = document.createElement("canvas");
    await new Promise((resolve, reject) => {
      QRCode.toCanvas(canvas, mesa.link, { width: 280, margin: 2 }, (err) => {
        if (err) reject(err); else resolve();
      });
    });

    const dataUrl = canvas.toDataURL("image/png");

    // 3. Guarda no servidor (persistente)
    try {
      const saved = await apiPostJson(`/api/admin/mesas/${mesa.id}/qrcode`, { dataUrl });
      if (saved.ok){
        // Se o servidor devolveu um qr_path (ficheiro PNG guardado), usa esse URL
        const src = saved.qr_path
          ? saved.qr_path
          : dataUrl;
        _qrCache.set(mesa.id, saved.qr_path
          ? { type: "url", src: saved.qr_path }
          : dataUrl
        );
        btnQr.textContent = "Ver QR code";
        btnQr.disabled = false;
        showQrModal(mesa, src);
        return;
      }
    } catch(saveErr){
      console.warn("Não foi possível guardar QR no servidor:", saveErr.message);
      // Continua mesmo assim com o dataURL local
    }

    // Fallback: guarda só em memória
    _qrCache.set(mesa.id, dataUrl);
    btnQr.textContent = "Ver QR code";
    btnQr.disabled = false;
    showQrModal(mesa, dataUrl);

  } catch(err){
    btnQr.textContent = "Gerar QR code";
    btnQr.disabled = false;
    alert("Erro ao gerar QR code: " + err.message);
  }
}

function showQrModal(mesa, src){
  // src pode ser dataURL ("data:image/png;base64,...") ou caminho público ("/uploads/qrcodes/...")
  const isDataUrl = String(src).startsWith("data:");
  const downloadHref = src; // funciona para ambos os casos

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "modal";
  modal.style.maxWidth = "360px";
  modal.style.textAlign = "center";

  modal.innerHTML = `
    <div class="modal-h" style="justify-content:space-between;">
      <h3 style="margin:0;">QR code — Mesa ${escapeHtml(mesa.nome)}</h3>
      <button class="ghost" type="button" id="btnCloseQr">Fechar</button>
    </div>
    <div style="padding:16px 0 8px;">
      <img src="${escapeHtml(src)}" alt="QR code Mesa ${escapeHtml(mesa.nome)}"
           style="width:260px;height:260px;border-radius:12px;border:1px solid #eee;object-fit:contain;" />
    </div>
    <div style="font-size:.8rem;color:#888;word-break:break-all;padding:0 8px 8px;">${escapeHtml(mesa.link)}</div>
    <div style="padding-bottom:16px;">
      <a href="${escapeHtml(downloadHref)}" download="qr-mesa-${escapeHtml(mesa.nome)}.png">
        <button type="button">⬇ Descarregar QR</button>
      </a>
    </div>
  `;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  function close(){ backdrop.remove(); }
  modal.querySelector("#btnCloseQr").addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
}

// ------------------ FATURAÇÃO (aba nova) ------------------

function todayStr(){
  return new Date().toISOString().slice(0,10);
}

function firstDayOfMonthStr(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-01`;
}

async function calcularFaturacao(){
  const startEl = document.getElementById("fatStart");
  const endEl   = document.getElementById("fatEnd");
  const resultEl = document.getElementById("fatResult");
  const loadEl   = document.getElementById("fatLoading");

  if (!startEl || !endEl || !resultEl) return;

  const start = startEl.value;
  const end   = endEl.value;

  if (!start || !end){
    alert("Define as duas datas.");
    return;
  }
  if (start > end){
    alert("A data 'Desde' não pode ser depois de 'Até'.");
    return;
  }

  if (loadEl) loadEl.classList.remove("hidden");
  resultEl.classList.add("hidden");

  try {
    const data = await apiGet(`/api/admin/total?start=${start}&end=${end}`);
    const cents = data.total_cents || 0;

    resultEl.innerHTML = `
      <div class="fat-result-box">
        <div class="fat-result-label">Total faturado</div>
        <div class="fat-result-period">${formatDatePT(start)} → ${formatDatePT(end)}</div>
        <div class="fat-result-value">${eur(cents)}</div>
      </div>
    `;
    resultEl.classList.remove("hidden");
  } catch(e) {
    alert(e.message || "Erro ao calcular faturação.");
  } finally {
    if (loadEl) loadEl.classList.add("hidden");
  }
}

function formatDatePT(str){
  // "2025-01-15" → "15/01/2025"
  const [y,m,d] = (str||"").split("-");
  if (!y||!m||!d) return str;
  return `${d}/${m}/${y}`;
}

// ------------------ CARTAZES ------------------

async function refreshCartazes(){
  const data = await apiGet("/api/admin/cartazes");
  const list = Array.isArray(data?.cartazes) ? data.cartazes : [];
  renderCartazes(list);
}

function renderCartazes(list){
  const el = document.getElementById("cartazesList");
  if (!el) return;

  el.innerHTML = "";

  if (!Array.isArray(list) || !list.length){
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "Ainda não carregaste cartazes.";
    el.appendChild(empty);
    return;
  }

  list.forEach(c => {
    const id = c.id;
    const filePath = c.file_path || c.path || "";
    const originalName = c.original_name || c.filename || `Cartaz #${id}`;

    const row = document.createElement("div");
    row.className = "table-row";

    const left = document.createElement("div");
    left.className = "table-left";

    const title = document.createElement("div");
    title.className = "table-title";
    title.textContent = originalName;

    const sub = document.createElement("div");
    sub.className = "table-link";
    sub.textContent = filePath;

    const img = document.createElement("img");
    img.src = filePath;
    img.alt = "Cartaz";
    img.style.width = "90px";
    img.style.height = "60px";
    img.style.objectFit = "cover";
    img.style.borderRadius = "10px";
    img.style.marginTop = "8px";
    img.loading = "lazy";

    left.appendChild(title);
    left.appendChild(sub);
    if (filePath) left.appendChild(img);

    const actions = document.createElement("div");
    actions.className = "table-actions";

    const btnCopy = document.createElement("button");
    btnCopy.type = "button";
    btnCopy.className = "ghost";
    btnCopy.textContent = "Copiar link";
    btnCopy.addEventListener("click", async () => {
      const full = filePath.startsWith("http")
        ? filePath
        : `${window.location.origin}${filePath}`;
      try{
        await navigator.clipboard.writeText(full);
        alert("Link copiado!");
      }catch{
        prompt("Copia o link:", full);
      }
    });

    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "ghost";
    btnDel.textContent = "Apagar";
    btnDel.style.color = "#c33";
    btnDel.addEventListener("click", async () => {
      if (!confirm("Apagar este cartaz?")) return;
      try{
        await apiDelete(`/api/admin/cartazes/${id}`);
        await refreshCartazes();
      }catch(e){
        alert(e.message || "Erro.");
      }
    });

    actions.appendChild(btnCopy);
    actions.appendChild(btnDel);

    row.appendChild(left);
    row.appendChild(actions);
    el.appendChild(row);
  });
}

// ------------------ CATEGORIAS / ITENS ------------------

async function refresh(){
  const list = await apiGet("/api/categories");
  renderCategories(list);
}

function renderCategories(list){
  const el = document.getElementById("categoriesList");
  if (!el) return;

  el.innerHTML = "";

  if (!Array.isArray(list) || !list.length){
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "Ainda não criaste categorias.";
    el.appendChild(empty);
    return;
  }

  list.forEach(cat => {
    const card = document.createElement("div");
    card.className = "cat-card";

    const img = document.createElement("img");
    img.className = "cat-img";
    img.alt = "Imagem da categoria";
    img.src = cat.image_path || "";
    if (!cat.image_path) img.style.display = "none";

    const main = document.createElement("div");
    main.className = "cat-main";

    const itemsHtml = (cat.items || []).map(it => `
      <div class="cat-item" data-item-row="${it.id}">
        <span>${it.name}</span>
        <div class="item-right">
          <strong>${eur(it.price_cents)}</strong>
          <button class="ghost item-edit" type="button"
            data-edit-item="${it.id}"
            data-edit-name="${encodeURIComponent(it.name)}"
            data-edit-price="${it.price_cents}"
            data-edit-catname="${encodeURIComponent(cat.name)}"
          >Editar</button>
          <button class="ghost item-del" type="button"
            data-del-item="${it.id}"
          >Apagar</button>
        </div>
      </div>
    `).join("");

    main.innerHTML = `
      <div class="cat-title">${cat.name}</div>
      <div class="cat-sub">${cat.type} · ${(cat.items||[]).length} itens</div>
      <div class="cat-actions">
        <button class="ghost" data-add-item="${cat.id}">+ Adicionar item</button>
        <button class="ghost" data-del-cat="${cat.id}">Apagar categoria</button>
      </div>
      <div class="cat-items">
        ${itemsHtml || `<div class="muted">Sem itens ainda.</div>`}
      </div>
    `;

    card.appendChild(img);
    card.appendChild(main);
    el.appendChild(card);

    main.querySelector(`[data-del-cat="${cat.id}"]`).addEventListener("click", async () => {
      if (!confirm("Apagar esta categoria?")) return;
      try {
        await apiDelete(`/api/categories/${cat.id}`);
        await refresh();
      } catch (e) {
        alert(e.message || "Erro.");
      }
    });

    main.querySelector(`[data-add-item="${cat.id}"]`).addEventListener("click", () => {
      openAddItemModal(cat.id, cat.name);
    });

    main.querySelectorAll("[data-edit-item]").forEach(btn => {
      btn.addEventListener("click", () => {
        const itemId = Number(btn.getAttribute("data-edit-item"));
        const name = decodeURIComponent(btn.getAttribute("data-edit-name") || "");
        const price_cents = Number(btn.getAttribute("data-edit-price") || 0);
        const catName = decodeURIComponent(btn.getAttribute("data-edit-catname") || "");
        openEditItemModal({ itemId, name, price_cents, catName });
      });
    });

    main.querySelectorAll("[data-del-item]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const itemId = Number(btn.getAttribute("data-del-item"));
        if (!itemId) return;
        if (!confirm("Apagar este item?")) return;
        try {
          await apiDelete(`/api/items/${itemId}`);
          await refresh();
        } catch (e) {
          alert(e.message || "Erro.");
        }
      });
    });
  });
}

function openAddItemModal(categoryId, categoryName){
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "modal";

  modal.innerHTML = `
    <div class="modal-h">
      <h3>Adicionar item — ${categoryName}</h3>
      <button class="ghost" type="button" id="btnClose">Fechar</button>
    </div>
    <form class="modal-form" id="modalForm">
      <div>
        <label>Nome</label>
        <input name="itemName" placeholder="Ex: Sagres 20cl" required />
      </div>
      <div>
        <label>Preço (€)</label>
        <input name="itemPrice" placeholder="Ex: 1.50" inputmode="decimal" required />
      </div>
      <div class="modal-actions" style="grid-column: 1 / -1;">
        <button type="submit">Guardar item</button>
        <button class="ghost" type="button" id="btnCancel">Cancelar</button>
      </div>
    </form>
  `;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  function close(){ backdrop.remove(); }

  modal.querySelector("#btnClose").addEventListener("click", close);
  modal.querySelector("#btnCancel").addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

  modal.querySelector("#modalForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const name = String(fd.get("itemName") || "").trim();
    const price_cents = eurFromInput(String(fd.get("itemPrice") || "").trim());

    if (!name) return alert("Nome em falta.");
    if (price_cents === null) return alert("Preço inválido.");

    try {
      await apiPostJson(`/api/categories/${categoryId}/items`, { name, price_cents });
      await refresh();
      close();
    } catch (err) {
      alert(err.message || "Erro.");
    }
  });

  modal.querySelector('input[name="itemName"]').focus();
}

function openEditItemModal({ itemId, name, price_cents, catName }){
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";

  const modal = document.createElement("div");
  modal.className = "modal";

  modal.innerHTML = `
    <div class="modal-h">
      <h3>Editar item — ${catName}</h3>
      <button class="ghost" type="button" id="btnClose">Fechar</button>
    </div>
    <form class="modal-form" id="modalForm">
      <div>
        <label>Nome</label>
        <input name="itemName" placeholder="Ex: Sagres 20cl" required value="${escapeHtml(name)}" />
      </div>
      <div>
        <label>Preço (€)</label>
        <input name="itemPrice" placeholder="Ex: 1.50" inputmode="decimal" required value="${((price_cents||0)/100).toFixed(2)}" />
      </div>
      <div class="modal-actions" style="grid-column: 1 / -1;">
        <button type="submit">Guardar alterações</button>
        <button class="ghost" type="button" id="btnCancel">Cancelar</button>
      </div>
    </form>
  `;

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  function close(){ backdrop.remove(); }

  modal.querySelector("#btnClose").addEventListener("click", close);
  modal.querySelector("#btnCancel").addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

  modal.querySelector("#modalForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const newName = String(fd.get("itemName") || "").trim();
    const newPriceCents = eurFromInput(String(fd.get("itemPrice") || "").trim());

    if (!newName) return alert("Nome em falta.");
    if (newPriceCents === null) return alert("Preço inválido.");

    try {
      await apiPutJson(`/api/items/${itemId}`, { name: newName, price_cents: newPriceCents });
      await refresh();
      close();
    } catch (err) {
      alert(err.message || "Erro.");
    }
  });

  modal.querySelector('input[name="itemName"]').focus();
}

function escapeHtml(str){
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ------------------ INIT ------------------

document.addEventListener("DOMContentLoaded", () => {

  // --- Tabs ---
  const tabProdutos   = document.getElementById("tabProdutos");
  const tabMesas      = document.getElementById("tabMesas");
  const tabCartazes   = document.getElementById("tabCartazes");
  const tabFaturacao  = document.getElementById("tabFaturacao");

  if (tabProdutos)  tabProdutos.addEventListener("click",  () => setTab("produtos"));
  if (tabMesas)     tabMesas.addEventListener("click",     async () => { setTab("mesas");     try { await refreshMesas(); }    catch(e){ console.warn(e); } });
  if (tabCartazes)  tabCartazes.addEventListener("click",  async () => { setTab("cartazes");  try { await refreshCartazes(); } catch(e){ console.warn(e); } });
  if (tabFaturacao) tabFaturacao.addEventListener("click", () => { setTab("faturacao"); initFaturacaoTab(); });

  // Hash inicial
  const hash = (window.location.hash || "").replace("#", "");
  if (hash === "mesas") {
    setTab("mesas");
    refreshMesas().catch(e => console.warn(e));
  } else if (hash === "cartazes") {
    setTab("cartazes");
    refreshCartazes().catch(e => console.warn(e));
  } else if (hash === "faturacao") {
    setTab("faturacao");
    initFaturacaoTab();
  } else {
    setTab("produtos");
  }

  // --- Faturação ---
  function initFaturacaoTab(){
    const startEl = document.getElementById("fatStart");
    const endEl   = document.getElementById("fatEnd");
    if (startEl && !startEl.value) startEl.value = firstDayOfMonthStr();
    if (endEl   && !endEl.value)   endEl.value   = todayStr();
  }

  const btnCalc = document.getElementById("btnCalcFaturacao");
  if (btnCalc) btnCalc.addEventListener("click", calcularFaturacao);

  // Atalhos rápidos de período
  document.querySelectorAll("[data-fat-period]").forEach(btn => {
    btn.addEventListener("click", () => {
      const period = btn.getAttribute("data-fat-period");
      const today = new Date();
      let start, end = todayStr();

      if (period === "hoje") {
        start = todayStr();
      } else if (period === "semana") {
        const d = new Date(today);
        d.setDate(d.getDate() - 6);
        start = d.toISOString().slice(0,10);
      } else if (period === "mes") {
        start = firstDayOfMonthStr();
      } else if (period === "mes-passado") {
        const d = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        const dEnd = new Date(today.getFullYear(), today.getMonth(), 0);
        start = d.toISOString().slice(0,10);
        end   = dEnd.toISOString().slice(0,10);
      }

      const startEl = document.getElementById("fatStart");
      const endEl   = document.getElementById("fatEnd");
      if (startEl) startEl.value = start;
      if (endEl)   endEl.value   = end;

      calcularFaturacao();
    });
  });

  // --- Produtos ---
  const form        = document.getElementById("categoryForm");
  const btnClear    = document.getElementById("btnClear");
  const btnRefresh  = document.getElementById("btnRefresh");
  const btnLogout   = document.getElementById("btnLogout");
  const imageInput  = document.getElementById("categoryImage");
  const imagePreview= document.getElementById("imagePreview");
  const previewImg  = document.getElementById("previewImg");

  if (btnClear && form) {
    btnClear.addEventListener("click", () => {
      form.reset();
      if (previewImg)   previewImg.src = "";
      if (imagePreview) imagePreview.classList.remove("show");
    });
  }
  if (btnRefresh) btnRefresh.addEventListener("click", refresh);

  if (btnLogout) {
    btnLogout.addEventListener("click", async () => {
      try { await fetch("/api/logout", { method: "POST" }); } catch {}
      window.location.href = "/login.html";
    });
  }

  if (imageInput) {
    imageInput.addEventListener("change", () => {
      const file = imageInput.files?.[0];
      if (!file) {
        if (previewImg)   previewImg.src = "";
        if (imagePreview) imagePreview.classList.remove("show");
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (previewImg)   previewImg.src = String(reader.result || "");
        if (imagePreview) imagePreview.classList.add("show");
      };
      reader.readAsDataURL(file);
    });
  }

  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const name = String(fd.get("categoryName") || "").trim();
      const type = String(fd.get("categoryType") || "").trim();
      if (!name) return alert("Nome da categoria é obrigatório.");

      const send = new FormData();
      send.append("name", name);
      send.append("type", type);
      const imageFile = imageInput?.files?.[0];
      if (imageFile) send.append("image", imageFile);

      const r = await fetch("/api/categories", { method: "POST", body: send });
      const data = await r.json().catch(()=>({}));
      if (!r.ok) return alert(data.error || "Erro a criar categoria.");

      form.reset();
      if (previewImg)   previewImg.src = "";
      if (imagePreview) imagePreview.classList.remove("show");
      await refresh();
    });
  }

  // --- Mesas ---
  const tableForm       = document.getElementById("tableForm");
  const btnClearMesa    = document.getElementById("btnClearMesa");
  const btnRefreshMesas = document.getElementById("btnRefreshMesas");

  if (btnClearMesa && tableForm) btnClearMesa.addEventListener("click", () => tableForm.reset());
  if (btnRefreshMesas) btnRefreshMesas.addEventListener("click", () => refreshMesas().catch(e => alert(e.message)));

  if (tableForm){
    tableForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(tableForm);
      const nome = String(fd.get("tableName") || "").trim();
      if (!nome) return alert("Nome/número da mesa é obrigatório.");
      try{
        await apiPostJson("/api/admin/mesas", { nome });
        tableForm.reset();
        await refreshMesas();
      }catch(err){
        alert(err.message || "Erro a criar mesa.");
      }
    });
  }

  // --- Cartazes ---
  const cartazForm          = document.getElementById("cartazForm");
  const cartazFile          = document.getElementById("cartazFile");
  const btnRefreshCartazes  = document.getElementById("btnRefreshCartazes");

  if (btnRefreshCartazes) btnRefreshCartazes.addEventListener("click", () => refreshCartazes().catch(e => alert(e.message)));

  if (cartazForm && cartazFile){
    cartazForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const file = cartazFile.files?.[0];
      if (!file) return alert("Seleciona um ficheiro.");
      const fd = new FormData();
      fd.append("cartaz", file);
      try{
        await apiPostMultipart("/api/admin/cartazes", fd);
        cartazForm.reset();
        await refreshCartazes();
        alert("Cartaz guardado ✅");
      }catch(err){
        alert(err.message || "Erro a guardar cartaz.");
      }
    });
  }

  // Carrega Produtos
  refresh().catch(e => console.warn(e));
});