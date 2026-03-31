// db.js
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const dbPath = path.join(__dirname, "data.sqlite");
const db = new Database(dbPath);

db.pragma("foreign_keys = ON");

function ensureColumns(table, columns) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  const names = new Set(cols.map((c) => c.name));

  for (const c of columns) {
    if (!names.has(c.name)) {
      db.prepare(c.ddl).run();
    }
  }
}

function init() {
  const uploadsDir = path.join(__dirname, "public", "uploads");
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('bebida','comida')),
      image_path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS category_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mesas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      ativa INTEGER NOT NULL DEFAULT 1,
      active_session_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mesa_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('aberta','fechada')),
      etiqueta TEXT,
      opened_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT,
      fecho TEXT,
      items_state_json TEXT,
      FOREIGN KEY (mesa_id) REFERENCES mesas(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_mesas_token ON mesas(token);
    CREATE INDEX IF NOT EXISTS idx_sessions_mesa_status ON sessions(mesa_id, status);

    CREATE TABLE IF NOT EXISTS pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('novo','preparar','pronto','entregue','cancelado')) DEFAULT 'novo',
      total_cents INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      rodada_paga INTEGER NOT NULL DEFAULT 0,
      customer_name TEXT,
      customer_phone TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pedido_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      item_id INTEGER,
      name TEXT NOT NULL,
      qty INTEGER NOT NULL CHECK (qty > 0),
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      line_total_cents INTEGER NOT NULL CHECK (line_total_cents >= 0),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_pedidos_session ON pedidos(session_id);
    CREATE INDEX IF NOT EXISTS idx_pedidos_status_created ON pedidos(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_pedido_items_pedido ON pedido_items(pedido_id);

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cartazes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // =========================
  // MIGRAÇÕES SEGURAS
  // =========================
  ensureColumns("sessions", [
    { name: "fecho", ddl: `ALTER TABLE sessions ADD COLUMN fecho TEXT` },
    { name: "items_state_json", ddl: `ALTER TABLE sessions ADD COLUMN items_state_json TEXT` },
    { name: "created_at", ddl: `ALTER TABLE sessions ADD COLUMN created_at TEXT` }
  ]);

  // ✅ MIGRAÇÃO: coluna qr_path na tabela mesas
  ensureColumns("mesas", [
    { name: "qr_path", ddl: `ALTER TABLE mesas ADD COLUMN qr_path TEXT` }
  ]);

  ensureColumns("category_items", [
    { name: "esgotado", ddl: `ALTER TABLE category_items ADD COLUMN esgotado INTEGER NOT NULL DEFAULT 0` }
  ]);

  // Preenche created_at nas sessões antigas
  try {
    db.prepare(`
      UPDATE sessions
      SET created_at = COALESCE(created_at, opened_at, datetime('now'))
      WHERE created_at IS NULL OR TRIM(created_at) = ''
    `).run();
  } catch {}

  ensureColumns("pedidos", [
    { name: "rodada_paga", ddl: `ALTER TABLE pedidos ADD COLUMN rodada_paga INTEGER NOT NULL DEFAULT 0` },
    { name: "customer_name", ddl: `ALTER TABLE pedidos ADD COLUMN customer_name TEXT` },
    { name: "customer_phone", ddl: `ALTER TABLE pedidos ADD COLUMN customer_phone TEXT` }
  ]);

  // Corrige possíveis NULL antigos em rodada_paga
  try {
    db.prepare(`
      UPDATE pedidos
      SET rodada_paga = 0
      WHERE rodada_paga IS NULL
    `).run();
  } catch {}

  // Corrige possíveis NULL antigos em esgotado
  try {
    db.prepare(`
      UPDATE category_items
      SET esgotado = 0
      WHERE esgotado IS NULL
    `).run();
  } catch {}

  // Default: mesas abertas
  db.prepare(`
    INSERT OR IGNORE INTO app_settings (key, value)
    VALUES ('ordering_open', '1')
  `).run();

  db.prepare(`
    INSERT OR IGNORE INTO app_state (key, value)
    VALUES ('ordering_open', '1')
  `).run();
}

module.exports = { db, init };