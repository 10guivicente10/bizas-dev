// server.js
require("dotenv").config();

const express = require("express");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const path = require("path");
const bcrypt = require("bcrypt");
const multer = require("multer");
const fs = require("fs");
const rateLimit = require("express-rate-limit");

const { db, init } = require("./db");

// =====================================================
// ✅ FIREBASE ADMIN SDK
// =====================================================
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }),
  });
}

const app = express();
const PORT = process.env.PORT || 3000;

// =====================================================
// ✅ (1) EXIGIR QR PARA ENTRAR EM /t/:token (e F5 volta a pedir QR)
// =====================================================
const QR_PASS_TTL_MS = 2 * 60 * 1000; // 2 minutos (aumentado para dar tempo ao OTP)
const qrPasses = new Map(); // pass -> { token, expiresAt }

function newQrPass(token) {
  const pass = crypto.randomBytes(18).toString("hex");
  qrPasses.set(pass, { token, expiresAt: Date.now() + QR_PASS_TTL_MS });
  return pass;
}

function consumeQrPass(pass, token) {
  const row = qrPasses.get(pass);
  if (!row) return false;
  if (row.token !== token) return false;

  if (Date.now() > row.expiresAt) {
    qrPasses.delete(pass);
    return false;
  }

  qrPasses.delete(pass);
  return true;
}

// =====================================================
// ✅ (2) TTL DA SESSÃO PÚBLICA
// =====================================================
const PUBLIC_SESSION_TTL_MS = 15 * 60 * 1000; // 15 min

function parseSqliteDatetimeToMs(s) {
  if (!s) return 0;
  const iso = String(s).replace(" ", "T") + "Z";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

function isPublicSessionExpired(createdAtStr) {
  const createdMs = parseSqliteDatetimeToMs(createdAtStr);
  if (!createdMs) return true;
  return Date.now() - createdMs > PUBLIC_SESSION_TTL_MS;
}

// =====================================================
// ✅ (3) validação nome + telemóvel
// =====================================================
function normalizePhone(raw) {
  let v = String(raw || "").trim();
  v = v.replace(/\s+/g, "");
  if (v.startsWith("+351")) v = v.slice(4);
  if (v.startsWith("00351")) v = v.slice(5);
  return v;
}

function isValidName(name) {
  return String(name || "").trim().length >= 2;
}

function isValidPtMobile(raw) {
  const p = normalizePhone(raw);
  return /^9\d{8}$/.test(p);
}

// =====================================================
// ✅ COOKIE OTP — helper para criar e validar
// =====================================================
const OTP_COOKIE_TTL_MS = 3 * 60 * 1000; // 3 minutos para completar o redirect

function createOtpCookie(token, uid) {
  return Buffer.from(JSON.stringify({
    token,
    uid,
    exp: Date.now() + OTP_COOKIE_TTL_MS
  })).toString("base64");
}

function validateOtpCookie(cookieStr, token) {
  if (!cookieStr) return false;
  try {
    const data = JSON.parse(Buffer.from(cookieStr, "base64").toString());
    return data.token === token && Date.now() < data.exp;
  } catch {
    return false;
  }
}

// init BD
init();

// Migração: adiciona coluna qr_path à tabela mesas se ainda não existir
try {
  db.prepare(`ALTER TABLE mesas ADD COLUMN qr_path TEXT`).run();
  console.log("✅ Coluna qr_path adicionada à tabela mesas.");
} catch (_) {}

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(cookieParser());


const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Muitas tentativas de login. Tenta novamente daqui a pouco." }
});

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 min
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Muitas tentativas de verificação. Tenta novamente daqui a pouco." }
});

const mesaAbrirLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Demasiados pedidos. Tenta novamente daqui a pouco." }
});

const pedidosLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Demasiados pedidos. Tenta novamente daqui a pouco." }
});




// =====================================================
// ✅ SESSÕES LOGIN
// =====================================================
const sessions = new Map();

function createSession(username, role) {
  const sid = crypto.randomBytes(24).toString("hex");
  sessions.set(sid, { username, role, createdAt: Date.now() });
  return sid;
}

function getSession(req) {
  const sid = req.cookies?.sid;
  if (!sid) return null;
  return sessions.get(sid) || null;
}

function requireAdmin(req, res, next) {
  const s = getSession(req);
  if (!s) {
    if (req.path.startsWith("/api/")) return res.status(401).json({ ok: false, error: "Não autenticado." });
    return res.redirect(`/login.html?next=${encodeURIComponent(req.originalUrl)}`);
  }
  if (s.role !== "admin") return res.status(403).json({ ok: false, error: "Sem permissões (admin)." });
  next();
}

function requireWorker(req, res, next) {
  const s = getSession(req);
  if (!s) return res.redirect(`/login.html?next=${encodeURIComponent(req.originalUrl)}`);
  if (s.role !== "worker" && s.role !== "admin") {
    return res.status(403).send("Sem permissões (trabalhador).");
  }
  next();
}

// =====================================================
// ✅ UPLOADS
// =====================================================
const uploadsDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const safe = Date.now() + "-" + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, safe);
  }
});
const upload = multer({ storage });

const postersDir = path.join(__dirname, "public", "uploads", "cartazes");
if (!fs.existsSync(postersDir)) fs.mkdirSync(postersDir, { recursive: true });

const postersStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, postersDir),
  filename: (req, file, cb) => {
    const safe = Date.now() + "-" + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, safe);
  }
});
const uploadCartaz = multer({ storage: postersStorage });

// =====================================================
// ✅ HELPERS
// =====================================================
function gerarToken() {
  return crypto.randomBytes(12).toString("base64url");
}

function getOrderingOpen() {
  const row = db.prepare(`SELECT value FROM app_state WHERE key = 'ordering_open'`).get();
  return String(row?.value ?? "1") === "1";
}

function setOrderingOpen(open) {
  const v = open ? "1" : "0";
  db.prepare(`
    INSERT INTO app_state (key, value)
    VALUES ('ordering_open', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(v);
  return open;
}

// ✅ limpeza automática
function purgeOldPaidClosedOrders() {
  try {
    const tx = db.transaction(() => {
      db.prepare(`
        DELETE FROM pedido_items
        WHERE pedido_id IN (
          SELECT p.id
          FROM pedidos p
          JOIN sessions s ON s.id = p.session_id
          WHERE s.fecho IS NOT NULL
            AND s.closed_at IS NOT NULL
            AND COALESCE(p.rodada_paga, 0) = 1
            AND datetime(s.closed_at) <= datetime('now', '-3 days')
        )
      `).run();

      db.prepare(`
        DELETE FROM pedidos
        WHERE id IN (
          SELECT p.id
          FROM pedidos p
          JOIN sessions s ON s.id = p.session_id
          WHERE s.fecho IS NOT NULL
            AND s.closed_at IS NOT NULL
            AND COALESCE(p.rodada_paga, 0) = 1
            AND datetime(s.closed_at) <= datetime('now', '-3 days')
        )
      `).run();
    });

    tx();
    console.log("🧹 Limpeza automática de pedidos pagos fechados concluída.");
  } catch (err) {
    console.error("Erro na limpeza automática de pedidos pagos:", err);
  }
}

// =====================================================
// ✅ ROOT
// =====================================================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// =====================================================
// ✅ ORDERING STATUS
// =====================================================
app.get("/api/public/ordering-status", (req, res) => {
  try {
    res.json({ ok: true, open: getOrderingOpen() });
  } catch (err) {
    console.error("Erro GET /api/public/ordering-status:", err);
    res.status(500).json({ ok: false, open: true });
  }
});

app.put("/api/worker/ordering/open", requireWorker, (req, res) => {
  try {
    res.json({ ok: true, open: setOrderingOpen(true) });
  } catch (err) {
    console.error("Erro PUT /api/worker/ordering/open:", err);
    res.status(500).json({ ok: false, error: "Erro a abrir mesas." });
  }
});

app.put("/api/worker/ordering/close", requireWorker, (req, res) => {
  try {
    const tx = db.transaction(() => {
      setOrderingOpen(false);
      db.prepare(`UPDATE category_items SET esgotado = 0`).run();
    });
    tx();
    res.json({ ok: true, open: false });
  } catch (err) {
    console.error("Erro PUT /api/worker/ordering/close:", err);
    res.status(500).json({ ok: false, error: "Erro a fechar mesas." });
  }
});

app.get("/api/worker/ordering-status", requireWorker, (req, res) => {
  try {
    res.json({ ok: true, open: getOrderingOpen() });
  } catch (err) {
    console.error("Erro GET /api/worker/ordering-status:", err);
    res.status(500).json({ ok: false, error: "Erro a ler estado." });
  }
});

// =====================================================
// ✅ QR FLOW — com OTP
// =====================================================

// /q/:token — escanear QR → redireciona para verify.html
app.get("/q/:token", (req, res) => {
  const token = String(req.params.token || "");
  if (!token) return res.redirect("/index.html");

  const pass = newQrPass(token);

  res.cookie("qr_pass", pass, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: QR_PASS_TTL_MS
  });

  // ✅ Redireciona para verify.html (OTP) em vez de ir direto para /t/:token
  res.redirect(
    `/verify.html?token=${encodeURIComponent(token)}&pass=${encodeURIComponent(pass)}`
  );
});

// /t/:token — só acessível após OTP verificado (cookie otp_verified)
app.get("/t/:token", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// =====================================================
// ✅ AUTH
// =====================================================
app.post("/api/login", loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    const adminUser = process.env.ADMIN_USER || "";
    const adminHash = process.env.ADMIN_PASS_HASH || "";
    const workerUser = process.env.WORKER_USER || "trabalhadores";
    const workerHash = process.env.WORKER_PASS_HASH || "";

    if (!adminHash) {
      return res.status(500).json({
        ok: false,
        error: "Admin sem password configurada. Corre: node scripts/set-admin-pass.js <password>"
      });
    }
    if (!workerHash) {
      return res.status(500).json({
        ok: false,
        error: "Trabalhadores sem password configurada. Corre: node scripts/set-worker-pass.js <password>"
      });
    }

    let role = null;
    let expectedHash = "";

    if (username === adminUser) {
      role = "admin";
      expectedHash = adminHash;
    } else if (username === workerUser) {
      role = "worker";
      expectedHash = workerHash;
    } else {
      return res.status(401).json({ ok: false, error: "Credenciais inválidas" });
    }

    const ok = await bcrypt.compare(String(password || ""), expectedHash);
    if (!ok) return res.status(401).json({ ok: false, error: "Credenciais inválidas" });

    const sid = createSession(username, role);
    res.cookie("sid", sid, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 8
    });

    res.json({ ok: true, role });
  } catch (err) {
    console.error("Erro /api/login:", err);
    res.status(500).json({ ok: false, error: "Erro interno no login" });
  }
});

app.post("/api/logout", (req, res) => {
  const sid = req.cookies?.sid;
  if (sid) sessions.delete(sid);
  res.clearCookie("sid");
  res.json({ ok: true });
});

// =====================================================
// ✅ OTP — VERIFICAR TOKEN FIREBASE
// =====================================================
app.post("/api/public/otp/verify-token", otpLimiter, async (req, res) => {
  try {
    const { firebaseToken, mesaToken, name, phone } = req.body;

    // 1. Valida campos
    if (!firebaseToken)
      return res.status(400).json({ ok: false, error: "Token Firebase em falta." });
    if (!mesaToken)
      return res.status(400).json({ ok: false, error: "Token da mesa em falta." });
    if (!isValidName(name))
      return res.status(400).json({ ok: false, error: "Nome inválido." });
    if (!isValidPtMobile(phone))
      return res.status(400).json({ ok: false, error: "Telemóvel inválido." });

    // 2. Verifica o token Firebase com o Admin SDK
    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(firebaseToken);
    } catch (firebaseErr) {
      console.error("Firebase token inválido:", firebaseErr.message);
      return res.status(401).json({
        ok: false,
        error: "Verificação Firebase falhou. Tenta de novo."
      });
    }

    // 3. Confirma que o telemóvel do token Firebase bate com o introduzido
    const tokenPhone = (decodedToken.phone_number || "")
      .replace("+351", "")
      .replace(/\s/g, "");
    const inputPhone = normalizePhone(phone);

    if (tokenPhone !== inputPhone) {
      return res.status(401).json({
        ok: false,
        error: "Telemóvel não coincide com a verificação."
      });
    }

    // 4. Verifica que a mesa existe e está ativa
    const mesa = db.prepare(`
      SELECT id, nome, token, ativa
      FROM mesas
      WHERE token = ? AND ativa = 1
    `).get(mesaToken);

    if (!mesa)
      return res.status(404).json({ ok: false, error: "Mesa inválida ou inativa." });

    // 5. Cria cookie otp_verified (httpOnly, TTL curto)
    const cookiePayload = createOtpCookie(mesaToken, decodedToken.uid);

    res.cookie("otp_verified", cookiePayload, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: OTP_COOKIE_TTL_MS
    });

    // 6. Responde com o redirect e os dados do cliente para o index.html os guardar
    res.json({
      ok:       true,
      redirect: `/t/${encodeURIComponent(mesaToken)}`,
      name:     String(name).trim(),
      phone:    inputPhone
    });

  } catch (err) {
    console.error("Erro POST /api/public/otp/verify-token:", err);
    res.status(500).json({ ok: false, error: "Erro interno." });
  }
});

// =====================================================
// ✅ API PÚBLICA MENU
// =====================================================
app.get("/api/public/categories", (req, res) => {
  try {
    const cats = db.prepare(`SELECT * FROM categories ORDER BY id DESC`).all();
    const items = db.prepare(`
      SELECT id, category_id, name, price_cents, COALESCE(esgotado, 0) AS esgotado
      FROM category_items
      ORDER BY id ASC
    `).all();

    const byCat = new Map();
    for (const it of items) {
      if (!byCat.has(it.category_id)) byCat.set(it.category_id, []);
      byCat.get(it.category_id).push(it);
    }

    res.json(cats.map((c) => ({ ...c, items: byCat.get(c.id) || [] })));
  } catch (err) {
    console.error("Erro /api/public/categories:", err);
    res.status(500).json({ ok: false, error: "Erro a listar categorias" });
  }
});

app.get("/api/public/cartazes", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, filename, path, created_at
      FROM cartazes
      ORDER BY id DESC
    `).all();
    res.json({ ok: true, cartazes: rows });
  } catch (err) {
    console.error("Erro GET /api/public/cartazes:", err);
    res.status(500).json({ ok: false, cartazes: [] });
  }
});

// =====================================================
// ✅ PUBLIC MESA / SESSÃO
// =====================================================
app.get("/api/public/mesa-info/:token", (req, res) => {
  try {
    const token = String(req.params.token || "");
    const mesa = db.prepare(`
      SELECT id, nome, token, ativa, active_session_id
      FROM mesas
      WHERE token = ? AND ativa = 1
    `).get(token);

    if (!mesa) return res.status(404).json({ ok: false, error: "Mesa inválida" });

    res.json({
      ok: true,
      mesaId: mesa.id,
      mesaNome: mesa.nome,
      activeSessionId: mesa.active_session_id || null
    });
  } catch (err) {
    console.error("Erro GET /api/public/mesa-info/:token:", err);
    res.status(500).json({ ok: false, error: "Erro interno" });
  }
});

app.post("/api/public/mesa-abrir/:token", mesaAbrirLimiter, (req, res) => {
  try {
    const token = String(req.params.token || "");

    const mesa = db.prepare(`
      SELECT id, nome, token, ativa, active_session_id
      FROM mesas
      WHERE token = ? AND ativa = 1
    `).get(token);

    if (!mesa) return res.status(404).json({ ok: false, error: "Mesa inválida" });

    if (mesa.active_session_id) {
      const sess = db.prepare(`
        SELECT id, status, created_at
        FROM sessions
        WHERE id = ?
      `).get(mesa.active_session_id);

      if (sess && sess.status === "aberta" && !isPublicSessionExpired(sess.created_at)) {
        return res.json({
          ok: true,
          mesaId: mesa.id,
          mesaNome: mesa.nome,
          sessionId: sess.id
        });
      }

      if (sess && sess.status === "aberta") {
        db.prepare(`
          UPDATE sessions
          SET status = 'fechada',
              closed_at = datetime('now'),
              fecho = 'fechada'
          WHERE id = ?
        `).run(sess.id);
      }

      db.prepare(`UPDATE mesas SET active_session_id = NULL WHERE id = ?`).run(mesa.id);
    }

    const info = db.prepare(`
      INSERT INTO sessions (mesa_id, status, created_at)
      VALUES (?, 'aberta', datetime('now'))
    `).run(mesa.id);

    const sessionId = info.lastInsertRowid;

    db.prepare(`
      UPDATE mesas
      SET active_session_id = ?
      WHERE id = ?
    `).run(sessionId, mesa.id);

    res.json({
      ok: true,
      mesaId: mesa.id,
      mesaNome: mesa.nome,
      sessionId
    });
  } catch (err) {
    console.error("Erro POST /api/public/mesa-abrir/:token:", err);
    res.status(500).json({ ok: false, error: "Erro interno" });
  }
});

// =====================================================
// ✅ PUBLIC ESTADO DE PEDIDOS (para filtrar histórico pago)
// =====================================================
app.post("/api/public/pedidos/estado", (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) return res.json({ ok: true, pedidos: [] });

    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT id, status, COALESCE(rodada_paga, 0) AS rodada_paga
      FROM pedidos
      WHERE id IN (${placeholders})
    `).all(...ids);

    res.json({ ok: true, pedidos: rows });
  } catch (err) {
    console.error("Erro POST /api/public/pedidos/estado:", err);
    res.status(500).json({ ok: false, error: "Erro interno" });
  }
});

// =====================================================
// ✅ PUBLIC CRIAR PEDIDO
// =====================================================
app.post("/api/public/pedidos", pedidosLimiter, (req, res) => {
  try {
    if (!getOrderingOpen()) {
      return res.status(403).json({
        ok: false,
        error: "Pedidos temporariamente fechados. Pede ao staff para abrir as mesas."
      });
    }

    const sessionId = Number(req.body?.sessionId);
    const token = req.body?.token ? String(req.body.token) : null;

    const customer_name = String(req.body?.customer_name || "").trim();
    const customer_phone_raw = String(req.body?.customer_phone || "").trim();
    const customer_phone = normalizePhone(customer_phone_raw);

    if (!isValidName(customer_name)) {
      return res.status(400).json({ ok: false, error: "Nome obrigatório." });
    }
    if (!isValidPtMobile(customer_phone_raw)) {
      return res.status(400).json({ ok: false, error: "Telemóvel inválido." });
    }

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const notes = req.body?.notes ? String(req.body.notes).slice(0, 500) : null;

    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return res.status(400).json({ ok: false, error: "sessionId inválido" });
    }
    if (!items.length) {
      return res.status(400).json({ ok: false, error: "Pedido vazio" });
    }

    const sess = db.prepare(`
      SELECT s.id, s.status, s.created_at, s.mesa_id, m.token AS mesa_token, m.nome AS mesa_nome
      FROM sessions s
      JOIN mesas m ON m.id = s.mesa_id
      WHERE s.id = ?
    `).get(sessionId);

    if (!sess) return res.status(404).json({ ok: false, error: "Sessão não existe" });
    if (sess.status !== "aberta") return res.status(400).json({ ok: false, error: "Sessão já está fechada" });

    if (isPublicSessionExpired(sess.created_at)) {
      return res.status(401).json({ ok: false, error: "Sessão expirada. Lê o QR novamente." });
    }

    if (token && token !== sess.mesa_token) {
      return res.status(403).json({ ok: false, error: "Token não corresponde à mesa desta sessão" });
    }

    const clean = [];
    for (const it of items) {
      const itemId = it.itemId != null ? Number(it.itemId) : it.item_id != null ? Number(it.item_id) : null;
      const name = String(it.name || "").trim();
      const qty = Number(it.qty);
      const price_cents = Number(it.price_cents);

      if (!name) return res.status(400).json({ ok: false, error: "Item com nome inválido" });
      if (!Number.isInteger(qty) || qty <= 0) {
        return res.status(400).json({ ok: false, error: "Quantidade inválida" });
      }
      if (!Number.isInteger(price_cents) || price_cents < 0) {
        return res.status(400).json({ ok: false, error: "Preço inválido" });
      }

      if (itemId) {
        const prod = db.prepare(`
          SELECT id, name, COALESCE(esgotado, 0) AS esgotado
          FROM category_items
          WHERE id = ?
        `).get(itemId);

        if (!prod) return res.status(400).json({ ok: false, error: "Produto inválido." });
        if (Number(prod.esgotado) === 1) {
          return res.status(400).json({ ok: false, error: `O produto "${prod.name}" está esgotado.` });
        }
      }

      clean.push({
        itemId,
        name,
        qty,
        price_cents,
        line_total_cents: qty * price_cents
      });
    }

    const total_cents = clean.reduce((acc, x) => acc + x.line_total_cents, 0);

    const insertPedido = db.prepare(`
      INSERT INTO pedidos (
        session_id, status, total_cents, notes,
        created_at, updated_at,
        customer_name, customer_phone
      )
      VALUES (
        ?, 'novo', ?, ?,
        datetime('now'), datetime('now'),
        ?, ?
      )
    `);

    const insertItem = db.prepare(`
      INSERT INTO pedido_items (pedido_id, item_id, name, qty, price_cents, line_total_cents)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      const info = insertPedido.run(sessionId, total_cents, notes, customer_name, customer_phone);
      const pedidoId = info.lastInsertRowid;
      for (const it of clean) {
        insertItem.run(pedidoId, it.itemId, it.name, it.qty, it.price_cents, it.line_total_cents);
      }
      return pedidoId;
    });

    const pedidoId = tx();

    res.json({
      ok: true,
      pedidoId,
      mesaNome: sess.mesa_nome,
      sessionId,
      total_cents
    });
  } catch (err) {
    console.error("Erro POST /api/public/pedidos:", err);
    res.status(500).json({ ok: false, error: "Erro interno a criar pedido" });
  }
});

// =====================================================
// ✅ PÁGINAS PROTEGIDAS
// =====================================================
app.get("/admin", requireAdmin, (req, res) => res.redirect("/admin.html"));
app.get("/admin.html", requireAdmin, (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));

app.get("/worker", requireWorker, (req, res) => res.redirect("/worker.html"));
app.get("/worker.html", requireWorker, (req, res) => res.sendFile(path.join(__dirname, "public", "worker.html")));

// =====================================================
// ✅ WORKER FECHAR SESSÃO
// =====================================================
app.put("/api/worker/sessoes/:id/fechar", requireWorker, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "Sessão inválida." });
    }

    const sess = db.prepare(`
      SELECT s.id, s.status, s.fecho, s.mesa_id
      FROM sessions s
      WHERE s.id = ?
    `).get(id);

    if (!sess) return res.status(404).json({ ok: false, error: "Sessão não existe." });

    if (sess.fecho) {
      return res.status(400).json({ ok: false, error: "Mesa já foi fechada. Não é possível alterar." });
    }

    const tx = db.transaction(() => {
      // 1) Apagar items dos pedidos "novo" desta sessão
      db.prepare(`
        DELETE FROM pedido_items
        WHERE pedido_id IN (
          SELECT id
          FROM pedidos
          WHERE session_id = ?
            AND status = 'novo'
        )
      `).run(id);

      // 2) Apagar os próprios pedidos "novo"
      db.prepare(`
        DELETE FROM pedidos
        WHERE session_id = ?
          AND status = 'novo'
      `).run(id);

      // 3) Fechar sessão
      db.prepare(`
        UPDATE sessions
        SET fecho = 'fechada',
            status = 'fechada',
            closed_at = datetime('now')
        WHERE id = ?
      `).run(id);

      // 4) Libertar mesa
      db.prepare(`
        UPDATE mesas
        SET active_session_id = NULL
        WHERE id = ? AND active_session_id = ?
      `).run(sess.mesa_id, id);
    });

    tx();
    res.json({ ok: true });
  } catch (err) {
    console.error("Erro PUT /api/worker/sessoes/:id/fechar:", err);
    res.status(500).json({ ok: false, error: "Erro a fechar a mesa." });
  }
});

// =====================================================
// ✅ WORKER GUARDAR ESTADO ITEMS SESSÃO
// =====================================================
app.put("/api/worker/sessoes/:id/items-state", requireWorker, (req, res) => {
  try {
    const sessionId = Number(req.params.id);
    const state = req.body?.state;

    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      return res.status(400).json({ ok: false, error: "Sessão inválida." });
    }

    const sess = db.prepare(`SELECT id, fecho FROM sessions WHERE id = ?`).get(sessionId);
    if (!sess) return res.status(404).json({ ok: false, error: "Sessão não existe." });

    if (sess.fecho) {
      return res.status(400).json({ ok: false, error: "Mesa fechada. Não podes alterar items." });
    }

    const safe = state && typeof state === "object" && !Array.isArray(state) ? state : {};

    db.prepare(`UPDATE sessions SET items_state_json = ? WHERE id = ?`).run(
      JSON.stringify(safe),
      sessionId
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("Erro PUT /api/worker/sessoes/:id/items-state:", err);
    res.status(500).json({ ok: false, error: "Erro a guardar estado dos items." });
  }
});

// =====================================================
// ✅ WORKER PAGAR RODADA
// =====================================================
app.put("/api/worker/pedidos/:id/pagar-rodada", requireWorker, (req, res) => {
  try {
    const pedidoId = Number(req.params.id);
    if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
      return res.status(400).json({ ok: false, error: "ID inválido." });
    }

    const row = db.prepare(`
      SELECT
        p.id,
        p.status,
        COALESCE(p.rodada_paga, 0) AS rodada_paga,
        p.session_id,
        s.fecho AS session_fecho,
        s.items_state_json
      FROM pedidos p
      JOIN sessions s ON s.id = p.session_id
      WHERE p.id = ?
    `).get(pedidoId);

    if (!row) return res.status(404).json({ ok: false, error: "Pedido não existe." });

    const st = String(row.status || "").toLowerCase();
    const isServido = st === "pronto" || st === "entregue";

    if (!isServido) {
      return res.status(400).json({
        ok: false,
        error: "Só podes pagar a rodada quando o pedido estiver servido."
      });
    }

    if (Number(row.rodada_paga) === 1) {
      return res.status(400).json({ ok: false, error: "Esta rodada já foi paga." });
    }

    const items = db.prepare(`
      SELECT name, qty
      FROM pedido_items
      WHERE pedido_id = ?
      ORDER BY id ASC
    `).all(pedidoId);

    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE pedidos
        SET rodada_paga = 1,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(pedidoId);

      let state = {};
      try {
        state = row.items_state_json ? JSON.parse(row.items_state_json) : {};
      } catch {
        state = {};
      }

      if (!state || typeof state !== "object" || Array.isArray(state)) state = {};

      for (const it of items) {
        const name = String(it.name || "").trim();
        const qty = Number(it.qty || 0);
        if (!name || !Number.isInteger(qty) || qty <= 0) continue;
        const cur = Number(state[name] || 0);
        state[name] = cur + qty;
      }

      db.prepare(`UPDATE sessions SET items_state_json = ? WHERE id = ?`).run(
        JSON.stringify(state),
        row.session_id
      );
    });

    tx();
    res.json({ ok: true });
  } catch (err) {
    console.error("Erro PUT /api/worker/pedidos/:id/pagar-rodada:", err);
    res.status(500).json({ ok: false, error: "Erro a pagar rodada." });
  }
});

// =====================================================
// ✅ WORKER PRODUTOS
// =====================================================
app.get("/api/worker/produtos", requireWorker, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT
        ci.id,
        ci.name AS nome,
        ci.price_cents AS preco_cents,
        COALESCE(ci.esgotado, 0) AS esgotado,
        c.id AS categoria_id,
        c.name AS categoria,
        c.type AS tipo
      FROM category_items ci
      LEFT JOIN categories c ON c.id = ci.category_id
      ORDER BY
        LOWER(COALESCE(c.name, '')),
        LOWER(COALESCE(ci.name, ''))
    `).all();

    res.json({ ok: true, produtos: rows });
  } catch (err) {
    console.error("Erro GET /api/worker/produtos:", err);
    res.status(500).json({ ok: false, error: "Erro a listar produtos." });
  }
});

app.put("/api/worker/produtos/:id/esgotado", requireWorker, (req, res) => {
  try {
    const id = Number(req.params.id);
    const esgotado = Number(req.body?.esgotado) === 1 ? 1 : 0;

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "Produto inválido." });
    }

    const exists = db.prepare(`SELECT id FROM category_items WHERE id = ?`).get(id);
    if (!exists) return res.status(404).json({ ok: false, error: "Produto não existe." });

    db.prepare(`UPDATE category_items SET esgotado = ? WHERE id = ?`).run(esgotado, id);
    res.json({ ok: true, id, esgotado });
  } catch (err) {
    console.error("Erro PUT /api/worker/produtos/:id/esgotado:", err);
    res.status(500).json({ ok: false, error: "Erro a atualizar produto." });
  }
});

// =====================================================
// ✅ WORKER PEDIDOS
// =====================================================
app.get("/api/worker/pedidos", requireWorker, (req, res) => {
  try {
    const status = String(req.query?.status || "abertos");

    let where = "";
    let params = [];

    if (status === "abertos") {
      where = `WHERE s.fecho IS NULL`;
    } else if (status === "nao_pago") {
      where = `
        WHERE s.fecho IS NOT NULL
          AND COALESCE(p.rodada_paga, 0) = 0
          AND p.status IN ('pronto', 'entregue')
      `;
    } else if (status === "pago") {
      where = `
        WHERE s.fecho IS NOT NULL
          AND COALESCE(p.rodada_paga, 0) = 1
          AND p.status != 'cancelado'
      `;
    } else {
      where = `WHERE p.status = ?`;
      params = [status];
    }

    const rows = db.prepare(`
      SELECT
        p.id,
        p.status,
        p.total_cents,
        p.created_at,
        p.updated_at,
        COALESCE(p.rodada_paga, 0) AS rodada_paga,
        p.customer_name,
        p.customer_phone,

        s.id AS session_id,
        s.fecho AS session_fecho,
        s.items_state_json AS session_items_state_json,

        m.id AS mesa_id,
        m.nome AS mesa_nome,

        (
          SELECT group_concat(pi.name || ' x' || pi.qty, ' · ')
          FROM pedido_items pi
          WHERE pi.pedido_id = p.id
          ORDER BY pi.id ASC
        ) AS items_preview,

        (
          SELECT group_concat(t.name || ' x' || t.qty, ' · ')
          FROM (
            SELECT
              pi.name AS name,
              SUM(pi.qty) AS qty
            FROM pedido_items pi
            JOIN pedidos pp ON pp.id = pi.pedido_id
            WHERE pp.session_id = s.id
              AND pp.status != 'cancelado'
            GROUP BY LOWER(pi.name)
            ORDER BY pi.name ASC
          ) t
        ) AS session_items_summary

      FROM pedidos p
      JOIN sessions s ON s.id = p.session_id
      JOIN mesas m ON m.id = s.mesa_id
      ${where}

      ORDER BY
        datetime(COALESCE(p.updated_at, p.created_at)) DESC,
        p.id DESC

      LIMIT 200
    `).all(...params);

    res.json({ ok: true, pedidos: rows });
  } catch (err) {
    console.error("Erro GET /api/worker/pedidos:", err);
    res.status(500).json({ ok: false, error: "Erro a listar pedidos." });
  }
});

app.get("/api/worker/pedidos/:id", requireWorker, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "ID inválido." });
    }

    const pedido = db.prepare(`
      SELECT
        p.id, p.status, p.total_cents, p.notes, p.created_at, p.updated_at,
        COALESCE(p.rodada_paga, 0) AS rodada_paga,
        p.customer_name,
        p.customer_phone,
        s.id AS session_id,
        s.fecho AS session_fecho,
        m.id AS mesa_id,
        m.nome AS mesa_nome
      FROM pedidos p
      JOIN sessions s ON s.id = p.session_id
      JOIN mesas m ON m.id = s.mesa_id
      WHERE p.id = ?
    `).get(id);

    if (!pedido) return res.status(404).json({ ok: false, error: "Pedido não existe." });

    const items = db.prepare(`
      SELECT id, item_id, name, qty, price_cents, line_total_cents
      FROM pedido_items
      WHERE pedido_id = ?
      ORDER BY id ASC
    `).all(id);

    res.json({ ok: true, pedido, items });
  } catch (err) {
    console.error("Erro GET /api/worker/pedidos/:id:", err);
    res.status(500).json({ ok: false, error: "Erro a ler pedido." });
  }
});

app.put("/api/worker/pedidos/:id/status", requireWorker, (req, res) => {
  try {
    const id = Number(req.params.id);
    const next = String(req.body?.status || "");
    const allowed = new Set(["novo", "preparar", "pronto", "entregue", "cancelado"]);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "ID inválido." });
    }
    if (!allowed.has(next)) {
      return res.status(400).json({ ok: false, error: "Status inválido." });
    }

    const cur = db.prepare(`
      SELECT p.id, p.status, s.fecho AS session_fecho
      FROM pedidos p
      JOIN sessions s ON s.id = p.session_id
      WHERE p.id = ?
    `).get(id);

    if (!cur) return res.status(404).json({ ok: false, error: "Pedido não existe." });

    if (cur.session_fecho) {
      return res.status(400).json({
        ok: false,
        error: "Mesa já foi fechada. Não é possível alterar o pedido."
      });
    }

    db.prepare(`
      UPDATE pedidos
      SET status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(next, id);

    res.json({ ok: true });
  } catch (err) {
    console.error("Erro PUT /api/worker/pedidos/:id/status:", err);
    res.status(500).json({ ok: false, error: "Erro a atualizar status." });
  }
});

app.delete("/api/worker/pedidos/:id", requireWorker, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "ID inválido." });
    }

    const row = db.prepare(`
      SELECT p.id, s.fecho AS session_fecho
      FROM pedidos p
      JOIN sessions s ON s.id = p.session_id
      WHERE p.id = ?
    `).get(id);

    if (!row) return res.status(404).json({ ok: false, error: "Pedido não existe." });

    if (row.session_fecho) {
      return res.status(400).json({
        ok: false,
        error: "Mesa já foi fechada. Não é possível apagar pedidos."
      });
    }

    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM pedido_items WHERE pedido_id = ?`).run(id);
      db.prepare(`DELETE FROM pedidos WHERE id = ?`).run(id);
    });

    tx();
    res.json({ ok: true });
  } catch (err) {
    console.error("Erro DELETE /api/worker/pedidos/:id:", err);
    res.status(500).json({ ok: false, error: "Erro a apagar pedido." });
  }
});

// =====================================================
// ✅ ADMIN MESAS
// =====================================================
const qrcodesDir = path.join(__dirname, "public", "uploads", "qrcodes");
if (!fs.existsSync(qrcodesDir)) fs.mkdirSync(qrcodesDir, { recursive: true });

app.get("/api/admin/mesas", requireAdmin, (req, res) => {
  try {
    const mesas = db.prepare(`
      SELECT id, nome, token, ativa, created_at, active_session_id, qr_path
      FROM mesas
      WHERE ativa = 1
      ORDER BY id DESC
    `).all();

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    res.json(mesas.map((m) => ({
      ...m,
      link: `${baseUrl}/q/${m.token}`,
      qr_path: m.qr_path || null
    })));
  } catch (err) {
    console.error("Erro GET /api/admin/mesas:", err);
    res.status(500).json({ ok: false, error: "Erro a listar mesas" });
  }
});

app.post("/api/admin/mesas/:id/qrcode", requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "ID inválido." });
    }

    const mesa = db.prepare(`SELECT id, nome, qr_path FROM mesas WHERE id = ?`).get(id);
    if (!mesa) return res.status(404).json({ ok: false, error: "Mesa não existe." });

    if (mesa.qr_path) {
      return res.json({ ok: true, qr_path: mesa.qr_path, existed: true });
    }

    const dataUrl = String(req.body?.dataUrl || "");
    if (!dataUrl.startsWith("data:image/png;base64,")) {
      return res.status(400).json({ ok: false, error: "dataUrl inválido." });
    }

    const base64 = dataUrl.replace("data:image/png;base64,", "");
    const filename = `qr-mesa-${id}.png`;
    const filePath = path.join(qrcodesDir, filename);
    const publicPath = `/uploads/qrcodes/${filename}`;

    fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
    db.prepare(`UPDATE mesas SET qr_path = ? WHERE id = ?`).run(publicPath, id);

    res.json({ ok: true, qr_path: publicPath, existed: false });
  } catch (err) {
    console.error("Erro POST /api/admin/mesas/:id/qrcode:", err);
    res.status(500).json({ ok: false, error: "Erro a guardar QR code." });
  }
});

app.post("/api/admin/mesas", requireAdmin, (req, res) => {
  try {
    const nome = String(req.body?.nome || "").trim();
    if (!nome) return res.status(400).json({ ok: false, error: "Nome/número obrigatório." });

    let token = gerarToken();
    for (let i = 0; i < 6; i++) {
      const exists = db.prepare(`SELECT id FROM mesas WHERE token = ?`).get(token);
      if (!exists) break;
      token = gerarToken();
    }

    const info = db.prepare(`INSERT INTO mesas (nome, token) VALUES (?, ?)`).run(nome, token);

    const mesa = db.prepare(`
      SELECT id, nome, token, ativa, created_at, active_session_id
      FROM mesas WHERE id = ?
    `).get(info.lastInsertRowid);

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    res.json({ ok: true, ...mesa, link: `${baseUrl}/q/${mesa.token}` });
  } catch (err) {
    console.error("Erro POST /api/admin/mesas:", err);
    res.status(500).json({ ok: false, error: "Erro a criar mesa" });
  }
});

app.delete("/api/admin/mesas/:id", requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "ID inválido." });
    }

    const mesa = db.prepare(`SELECT id, qr_path FROM mesas WHERE id = ?`).get(id);
    if (!mesa) return res.status(404).json({ ok: false, error: "Mesa não existe." });

    if (mesa.qr_path) {
      try {
        const abs = path.join(__dirname, "public", mesa.qr_path.replace(/^\//, ""));
        fs.unlinkSync(abs);
      } catch (_) {}
    }

    db.prepare(`DELETE FROM mesas WHERE id = ?`).run(id);
    res.json({ ok: true });
  } catch (err) {
    console.error("Erro DELETE /api/admin/mesas/:id:", err);
    res.status(500).json({ ok: false, error: "Erro a eliminar mesa." });
  }
});

// =====================================================
// ✅ ADMIN TOTAL FATURADO
// =====================================================
app.get("/api/admin/total", requireAdmin, (req, res) => {
  try {
    const start = req.query.start;
    const end = req.query.end;

    if (!start || !end) return res.status(400).json({ ok: false, error: "Datas inválidas" });

    const row = db.prepare(`
      SELECT SUM(total_cents) AS total_cents
      FROM pedidos p
      JOIN sessions s ON s.id = p.session_id
      WHERE COALESCE(p.rodada_paga, 0) = 1
        AND DATE(p.created_at) BETWEEN DATE(?) AND DATE(?)
    `).get(start, end);

    res.json({ ok: true, total_cents: row?.total_cents || 0 });
  } catch (err) {
    console.error("Erro GET /api/admin/total:", err);
    res.status(500).json({ ok: false, error: "Erro ao calcular total faturado" });
  }
});

// =====================================================
// ✅ ADMIN CARTAZES
// =====================================================
app.get("/api/admin/cartazes", requireAdmin, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, filename, path, created_at
      FROM cartazes
      ORDER BY id DESC
    `).all();
    res.json({ ok: true, cartazes: rows });
  } catch (err) {
    console.error("Erro GET /api/admin/cartazes:", err);
    res.status(500).json({ ok: false, error: "Erro a listar cartazes." });
  }
});

app.post("/api/admin/cartazes", requireAdmin, uploadCartaz.single("cartaz"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "Ficheiro em falta." });
    }

    const publicPath = `/uploads/cartazes/${req.file.filename}`;

    const info = db.prepare(`
      INSERT INTO cartazes (filename, path, created_at)
      VALUES (?, ?, datetime('now'))
    `).run(req.file.filename, publicPath);

    res.json({ ok: true, id: info.lastInsertRowid, path: publicPath });
  } catch (err) {
    console.error("Erro POST /api/admin/cartazes:", err);
    res.status(500).json({ ok: false, error: "Erro a guardar cartaz." });
  }
});

app.delete("/api/admin/cartazes/:id", requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "ID inválido." });
    }

    const row = db.prepare(`SELECT id, path FROM cartazes WHERE id = ?`).get(id);
    if (!row) return res.status(404).json({ ok: false, error: "Cartaz não existe." });

    db.prepare(`DELETE FROM cartazes WHERE id = ?`).run(id);

    const abs = path.join(__dirname, "public", row.path.replace(/^\//, ""));
    try { fs.unlinkSync(abs); } catch {}

    res.json({ ok: true });
  } catch (err) {
    console.error("Erro DELETE /api/admin/cartazes/:id:", err);
    res.status(500).json({ ok: false, error: "Erro a apagar cartaz." });
  }
});

// =====================================================
// ✅ ADMIN CATEGORIAS / ITENS
// =====================================================
app.get("/api/categories", requireAdmin, (req, res) => {
  try {
    const cats = db.prepare(`SELECT * FROM categories ORDER BY id DESC`).all();
    const items = db.prepare(`
      SELECT id, category_id, name, price_cents, COALESCE(esgotado, 0) AS esgotado
      FROM category_items
      ORDER BY id ASC
    `).all();

    const byCat = new Map();
    for (const it of items) {
      if (!byCat.has(it.category_id)) byCat.set(it.category_id, []);
      byCat.get(it.category_id).push(it);
    }

    const out = cats.map((c) => ({ ...c, items: byCat.get(c.id) || [] }));
    res.json(out);
  } catch (err) {
    console.error("Erro GET /api/categories:", err);
    res.status(500).json({ ok: false, error: "Erro a listar categorias (admin)" });
  }
});

app.post("/api/categories", requireAdmin, upload.single("image"), (req, res) => {
  try {
    const { name, type } = req.body;
    if (!name || !type) return res.status(400).json({ ok: false, error: "Faltam campos." });
    if (!["bebida", "comida"].includes(type)) {
      return res.status(400).json({ ok: false, error: "Tipo inválido." });
    }

    const image_path = req.file ? `/uploads/${req.file.filename}` : null;

    const info = db.prepare(`
      INSERT INTO categories (name, type, image_path)
      VALUES (?, ?, ?)
    `).run(String(name).trim(), type, image_path);

    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    console.error("Erro POST /api/categories:", err);
    res.status(500).json({ ok: false, error: "Erro a criar categoria" });
  }
});

app.post("/api/categories/:id/items", requireAdmin, (req, res) => {
  try {
    const categoryId = Number(req.params.id);
    const name = String(req.body?.name || "").trim();
    const price_cents = Number(req.body?.price_cents);

    if (!Number.isInteger(categoryId) || categoryId <= 0) {
      return res.status(400).json({ ok: false, error: "Categoria inválida." });
    }
    if (!name) return res.status(400).json({ ok: false, error: "Nome em falta." });
    if (!Number.isInteger(price_cents) || price_cents < 0) {
      return res.status(400).json({ ok: false, error: "Preço inválido." });
    }

    const exists = db.prepare(`SELECT id FROM categories WHERE id = ?`).get(categoryId);
    if (!exists) return res.status(404).json({ ok: false, error: "Categoria não existe." });

    const info = db.prepare(`
      INSERT INTO category_items (category_id, name, price_cents)
      VALUES (?, ?, ?)
    `).run(categoryId, name, price_cents);

    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (err) {
    console.error("Erro POST /api/categories/:id/items:", err);
    res.status(500).json({ ok: false, error: "Erro a adicionar item" });
  }
});

app.put("/api/items/:id", requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    const name = String(req.body?.name || "").trim();
    const price_cents = Number(req.body?.price_cents);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "Item inválido." });
    }
    if (!name) return res.status(400).json({ ok: false, error: "Nome em falta." });
    if (!Number.isInteger(price_cents) || price_cents < 0) {
      return res.status(400).json({ ok: false, error: "Preço inválido." });
    }

    const exists = db.prepare(`SELECT id FROM category_items WHERE id = ?`).get(id);
    if (!exists) return res.status(404).json({ ok: false, error: "Item não existe." });

    db.prepare(`
      UPDATE category_items
      SET name = ?, price_cents = ?
      WHERE id = ?
    `).run(name, price_cents, id);

    res.json({ ok: true });
  } catch (err) {
    console.error("Erro PUT /api/items/:id:", err);
    res.status(500).json({ ok: false, error: "Erro a editar item" });
  }
});

app.delete("/api/items/:id", requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "Item inválido." });
    }
    db.prepare(`DELETE FROM category_items WHERE id = ?`).run(id);
    res.json({ ok: true });
  } catch (err) {
    console.error("Erro DELETE /api/items/:id:", err);
    res.status(500).json({ ok: false, error: "Erro a apagar item" });
  }
});

app.delete("/api/categories/:id", requireAdmin, (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ ok: false, error: "ID inválido" });
    }
    db.prepare(`DELETE FROM categories WHERE id = ?`).run(id);
    res.json({ ok: true });
  } catch (err) {
    console.error("Erro DELETE /api/categories/:id:", err);
    res.status(500).json({ ok: false, error: "Erro a apagar categoria" });
  }
});

// =====================================================
// ✅ STATIC
// =====================================================
app.use(express.static(path.join(__dirname, "public")));

// ✅ limpeza automática
purgeOldPaidClosedOrders();
setInterval(purgeOldPaidClosedOrders, 60 * 60 * 1000);

app.listen(PORT, () => console.log(`✅ A correr em http://localhost:${PORT}`));