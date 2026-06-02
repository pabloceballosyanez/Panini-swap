import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

const DB_PATH = process.env.PANINI_DB_PATH || 'data/panini-swap.db';

let db = null;

export async function getDb() {
  if (db) return db;
  
  // Ensure data directory exists
  try { mkdirSync('data'); } catch(_) {}
  
  const SQL = await initSqlJs();
  
  if (existsSync(DB_PATH)) {
    const buffer = readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  
  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA foreign_keys=ON');
  
  return db;
}

export function saveDb() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  writeFileSync(DB_PATH, buffer);
}

/**
 * Parameterized SELECT query.
 * Returns array of arrays (same format as db.exec(sql)[0].values).
 * Uses sql.js prepare/bind/step for safety against SQL injection.
 */
export function query(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const values = [];
  while (stmt.step()) {
    const cols = stmt.getColumnNames();
    const row = [];
    for (let i = 0; i < cols.length; i++) {
      row.push(stmt.get()[i]);
    }
    values.push(row);
  }
  stmt.free();
  return values;
}

/**
 * Parameterized INSERT/UPDATE/DELETE.
 * Returns { lastInsertRowid, changes }.
 */
export function run(db, sql, params = []) {
  db.run(sql, params);
  const info = db.exec('SELECT last_insert_rowid(), changes()');
  return {
    lastInsertRowid: info[0]?.values?.[0]?.[0],
    changes: info[0]?.values?.[0]?.[1]
  };
}

export async function initSchema() {
  const db = await getDb();
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS stickers (
      id INTEGER PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      team_code TEXT,
      team_name TEXT,
      group_name TEXT,
      category TEXT NOT NULL,
      rarity TEXT DEFAULT 'common',
      number_in_team INTEGER
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      channel TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      location TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(channel, contact_id)
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      sticker_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('needed','owned','duplicate')),
      quantity INTEGER DEFAULT 1,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (sticker_id) REFERENCES stickers(id),
      UNIQUE(user_id, sticker_id)
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_a_id INTEGER NOT NULL,
      user_b_id INTEGER NOT NULL,
      match_type TEXT NOT NULL CHECK(match_type IN ('direct','cyclic')),
      cycle_id TEXT,
      details TEXT NOT NULL,
      status TEXT DEFAULT 'proposed' CHECK(status IN ('proposed','accepted','completed','cancelled')),
      score REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_a_id) REFERENCES users(id),
      FOREIGN KEY (user_b_id) REFERENCES users(id)
    )
  `);
  
  saveDb();
  console.log('Schema initialized.');
}
