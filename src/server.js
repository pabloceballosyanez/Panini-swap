import express from 'express';
import { getDb, saveDb, initSchema, query, run } from './db.js';
import { findMatches } from './einstein.js';
import { handleMessage } from './bot.js';

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ── Configuration ─────────────────────────────────────────────
const PORT = process.env.PORT || 3456;
const API_KEY = process.env.PANINI_API_KEY || 'panini-swap-2026-secret';
const TELEGRAM_TOKEN = process.env.PANINI_TELEGRAM_TOKEN;
const APP_URL = process.env.PANINI_APP_URL || `http://localhost:${PORT}`;
const TELEGRAM_SECRET = TELEGRAM_TOKEN;

// ── Rate Limiter ──────────────────────────────────────────────
const rateLimitMap = {};
const RATE_WINDOW_MS = 60_000;  // 1 minute
const RATE_MAX = 60;            // 60 req/min per IP

function rateLimiter(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  if (!rateLimitMap[ip]) rateLimitMap[ip] = [];
  rateLimitMap[ip] = rateLimitMap[ip].filter(t => now - t < RATE_WINDOW_MS);
  if (rateLimitMap[ip].length >= RATE_MAX) {
    return res.status(429).json({ error: 'Too many requests. Slow down.' });
  }
  rateLimitMap[ip].push(now);
  next();
}

app.use(rateLimiter);

// ── API Key Auth Middleware ───────────────────────────────────
function requireAuth(req, res, next) {
  // Telegram webhook is verified separately (secret_token header)
  if (req.path === '/api/telegram/webhook') return next();
  // Health check doesn't need auth
  if (req.path === '/api/health') return next();
  
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized. Provide x-api-key header.' });
  }
  next();
}

// Apply auth to all /api routes except webhook + health
app.use('/api', (req, res, next) => {
  if (req.path === '/telegram/webhook' || req.path === '/health') return next();
  return requireAuth(req, res, next);
});

// ── Health check ──────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════
//  USERS
// ═══════════════════════════════════════════════════════════════

app.post('/api/users', async (req, res) => {
  const { name, channel, contact_id, location } = req.body;
  if (!name || !channel || !contact_id) {
    return res.status(400).json({ error: 'name, channel, contact_id required' });
  }
  
  const db = await getDb();
  
  // Upsert
  const existing = query(db,
    `SELECT id FROM users WHERE channel=? AND contact_id=?`,
    [channel, contact_id]
  );
  
  if (existing.length) {
    const uid = existing[0][0];
    run(db, `UPDATE users SET name=?, location=? WHERE id=?`, [name, location || '', uid]);
    saveDb();
    return res.json({ user_id: uid, created: false });
  }
  
  const result = run(db,
    `INSERT INTO users (name, channel, contact_id, location) VALUES (?,?,?,?)`,
    [name, channel, contact_id, location || '']
  );
  saveDb();
  
  res.json({ user_id: result.lastInsertRowid, created: true });
});

app.get('/api/users', async (req, res) => {
  const db = await getDb();
  const users = query(db, `
    SELECT u.*, 
           COUNT(CASE WHEN i.status='owned' THEN 1 END) as owned,
           COUNT(CASE WHEN i.status='needed' THEN 1 END) as needed,
           COUNT(CASE WHEN i.status='duplicate' THEN 1 END) as duplicates
    FROM users u
    LEFT JOIN inventory i ON u.id = i.user_id
    GROUP BY u.id
  `);
  
  res.json(users.map(u => ({
    id: u[0], name: u[1], channel: u[2], contact_id: u[3], location: u[4],
    owned: u[6], needed: u[7], duplicates: u[8]
  })));
});

// ═══════════════════════════════════════════════════════════════
//  INVENTORY
// ═══════════════════════════════════════════════════════════════

app.post('/api/inventory', async (req, res) => {
  const { user_id, sticker_code, status, quantity } = req.body;
  if (!user_id || !sticker_code || !status) {
    return res.status(400).json({ error: 'user_id, sticker_code, status required' });
  }
  
  const db = await getDb();
  
  // Find sticker
  const sticker = query(db, `SELECT id, name, team_name FROM stickers WHERE code=?`, [sticker_code]);
  if (!sticker.length) {
    return res.status(404).json({ error: `Sticker ${sticker_code} not found` });
  }
  
  const sticker_id = sticker[0][0];
  const qty = quantity || 1;
  
  // Upsert inventory
  const existing = query(db,
    `SELECT id FROM inventory WHERE user_id=? AND sticker_id=?`,
    [user_id, sticker_id]
  );
  
  if (existing.length) {
    run(db,
      `UPDATE inventory SET status=?, quantity=?, updated_at=datetime('now') WHERE id=?`,
      [status, qty, existing[0][0]]
    );
  } else {
    run(db,
      `INSERT INTO inventory (user_id, sticker_id, status, quantity) VALUES (?,?,?,?)`,
      [user_id, sticker_id, status, qty]
    );
  }
  
  saveDb();
  
  res.json({ 
    ok: true, 
    sticker: sticker_code, 
    name: sticker[0][1],
    team: sticker[0][2],
    status,
    quantity: qty
  });
});

app.post('/api/inventory/bulk', async (req, res) => {
  const { user_id, owned_codes, duplicate_codes, needed_codes } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  
  const db = await getDb();
  const results = { owned: 0, duplicates: 0, needed: 0, errors: [] };
  
  const upsertStmt = db.prepare(`
    INSERT INTO inventory (user_id, sticker_id, status, quantity) 
    VALUES (?, (SELECT id FROM stickers WHERE code=?), ?, 1)
    ON CONFLICT(user_id, sticker_id) DO UPDATE SET status=excluded.status, quantity=excluded.quantity, updated_at=datetime('now')
  `);
  
  try {
    for (const batch of [
      { codes: owned_codes || [], status: 'owned', key: 'owned' },
      { codes: duplicate_codes || [], status: 'duplicate', key: 'duplicates' },
      { codes: needed_codes || [], status: 'needed', key: 'needed' }
    ]) {
      for (const code of batch.codes) {
        upsertStmt.bind([user_id, code, batch.status]);
        upsertStmt.step();
        upsertStmt.reset();
        results[batch.key]++;
      }
    }
  } catch(e) {
    results.errors.push(e.message);
  }
  
  upsertStmt.free();
  saveDb();
  res.json(results);
});

app.get('/api/users/:id/inventory', async (req, res) => {
  const db = await getDb();
  const inv = query(db, `
    SELECT s.code, s.name, s.team_code, s.team_name, s.category, s.rarity, i.status, i.quantity
    FROM inventory i JOIN stickers s ON i.sticker_id = s.id
    WHERE i.user_id = ?
    ORDER BY s.id
  `, [req.params.id]);
  
  const summary = { owned: 0, needed: 0, duplicates: 0, by_team: {}, items: [] };
  
  for (const row of inv) {
    const [code, name, team_code, team_name, category, rarity, status, qty] = row;
    summary[status === 'duplicate' ? 'duplicates' : status === 'owned' ? 'owned' : 'needed']++;
    
    if (team_name && !summary.by_team[team_name]) {
      summary.by_team[team_name] = { owned: 0, needed: 0, duplicates: 0, total: 20 };
    }
    if (team_name) {
      summary.by_team[team_name][status === 'duplicate' ? 'duplicates' : status]++;
    }
    
    summary.items.push({ code, name, team_code, team_name, category, rarity, status, quantity: qty });
  }
  
  res.json(summary);
});

// ═══════════════════════════════════════════════════════════════
//  STICKERS
// ═══════════════════════════════════════════════════════════════

app.get('/api/stickers', async (req, res) => {
  const db = await getDb();
  const { q, team, category, limit } = req.query;
  
  const conditions = [];
  const params = [];
  
  if (q) {
    conditions.push(`(code LIKE ? OR name LIKE ?)`);
    params.push(`%${q}%`, `%${q}%`);
  }
  if (team) {
    conditions.push(`(team_code=? OR team_name LIKE ?)`);
    params.push(team, `%${team}%`);
  }
  if (category) {
    conditions.push(`category=?`);
    params.push(category);
  }
  
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT * FROM stickers ${where} ORDER BY id LIMIT ?`;
  params.push(parseInt(limit) || 100);
  
  const results = query(db, sql, params);
  res.json(results.map(r => ({
    id: r[0], code: r[1], name: r[2], team_code: r[3], team_name: r[4],
    group_name: r[5], category: r[6], rarity: r[7]
  })));
});

app.get('/api/teams', async (req, res) => {
  const db = await getDb();
  const teams = query(db, `
    SELECT team_code, team_name, group_name, 
           COUNT(*) as total,
           COUNT(CASE WHEN rarity='foil' THEN 1 END) as foils,
           COUNT(CASE WHEN category='player' THEN 1 END) as players
    FROM stickers WHERE team_code IS NOT NULL
    GROUP BY team_code ORDER BY group_name, team_name
  `);
  
  res.json(teams.map(t => ({
    code: t[0], name: t[1], group: t[2], total: t[3], foils: t[4], players: t[5]
  })));
});

// ═══════════════════════════════════════════════════════════════
//  MATCHES
// ═══════════════════════════════════════════════════════════════

app.get('/api/matches/:user_id', async (req, res) => {
  const db = await getDb();
  const { direct, cycles } = findMatches(db);
  
  const uid = parseInt(req.params.user_id);
  
  const myDirect = direct.filter(m => m.user_a_id === uid || m.user_b_id === uid);
  const myCycles = cycles.filter(c => c.users.includes(uid));
  
  // Get sticker name details
  const stickerNames = {};
  const allStickers = query(db, 'SELECT id, code, name, team_name FROM stickers');
  for (const [id, code, name, team] of allStickers) {
    stickerNames[id] = { code, name, team };
  }
  
  const enrichMatch = (m) => ({
    ...m,
    a_gives_details: (m.a_gives_to_b || []).map(sid => stickerNames[sid]),
    b_gives_details: (m.b_gives_to_a || []).map(sid => stickerNames[sid])
  });
  
  const enrichCycle = (c) => ({
    ...c,
    details: c.details.map(d => ({
      ...d,
      sticker: stickerNames[d.sticker_id],
      from_name: c.user_names[c.users.indexOf(d.from_user_id)],
      to_name: c.user_names[c.users.indexOf(d.to_user_id)]
    }))
  });
  
  res.json({
    direct_matches: myDirect.map(enrichMatch),
    cycles: myCycles.map(enrichCycle)
  });
});

app.get('/api/matches', async (req, res) => {
  const db = await getDb();
  const { direct, cycles } = findMatches(db);
  
  const stickerNames = {};
  const allStickers = query(db, 'SELECT id, code, name, team_name FROM stickers');
  for (const [id, code, name, team] of allStickers) {
    stickerNames[id] = { code, name, team };
  }
  
  res.json({
    summary: {
      total_direct_matches: direct.length,
      total_cycles: cycles.length,
      total_stickers_exchanged: direct.reduce((s,m) => s + (m.a_gives_to_b?.length || 0) + (m.b_gives_to_a?.length || 0), 0)
    },
    direct_matches: direct.map(m => ({
      ...m,
      a_gives_details: (m.a_gives_to_b || []).map(sid => stickerNames[sid]),
      b_gives_details: (m.b_gives_to_a || []).map(sid => stickerNames[sid])
    })),
    cycles: cycles.map(c => ({
      ...c,
      details: c.details.map(d => ({ ...d, sticker: stickerNames[d.sticker_id] }))
    }))
  });
});

// ═══════════════════════════════════════════════════════════════
//  STATS
// ═══════════════════════════════════════════════════════════════

app.get('/api/stats', async (req, res) => {
  const db = await getDb();
  
  const totalUsers = query(db, 'SELECT COUNT(*) FROM users')[0][0];
  const totalStickers = query(db, 'SELECT COUNT(*) FROM stickers')[0][0];
  const totalInventory = query(db, 'SELECT COUNT(*) FROM inventory')[0][0];
  
  res.json({ total_users: totalUsers, total_stickers: totalStickers, total_inventory: totalInventory });
});

// ═══════════════════════════════════════════════════════════════
//  TELEGRAM WEBHOOK
// ═══════════════════════════════════════════════════════════════

// Split long messages for Telegram's 4096 char limit
function splitLongMessage(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];
  const lines = text.split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if (current.length + line.length + 1 > maxLen) {
      chunks.push(current.trimEnd());
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  if (current) chunks.push(current.trimEnd());
  return chunks;
}

// Convert simple Markdown to Telegram HTML
function mdToTelegramHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^📋/gm, '<b>📋')
    .replace(/\n/g, '\n');
}

// Send message via Telegram Bot API
async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_TOKEN) {
    console.warn('Telegram token not configured. Skipping message.');
    return;
  }
  
  const chunks = splitLongMessage(text);
  
  for (const chunk of chunks) {
    try {
      const html = mdToTelegramHtml(chunk);
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: html,
          parse_mode: 'HTML'
        })
      });
      const data = await res.json();
      if (!data.ok) {
        console.error('Telegram send error:', data.description);
        // Retry without parse_mode if HTML fails
        if (data.description?.includes('parse')) {
          await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: chunk })
          });
        }
      }
    } catch (err) {
      console.error('Telegram send failed:', err.message);
    }
  }
}

// Set up webhook on startup
async function setupTelegramWebhook() {
  if (!TELEGRAM_TOKEN) {
    console.log('ℹ️  PANINI_TELEGRAM_TOKEN not set. Telegram bot disabled.');
    return;
  }
  
  const webhookUrl = `${APP_URL}/api/telegram/webhook`;
  
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        url: webhookUrl,
        secret_token: TELEGRAM_SECRET,
        allowed_updates: ['message']
      })
    });
    const data = await res.json();
    console.log(`📡 Telegram webhook → ${data.ok ? '✅ OK' : '❌ FAILED'}: ${data.description || ''}`);
  } catch (err) {
    console.error('❌ Webhook setup failed:', err.message);
  }
}

// Webhook endpoint
app.post('/api/telegram/webhook', async (req, res) => {
  // Verify secret token
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (TELEGRAM_SECRET && secret !== TELEGRAM_SECRET) {
    return res.status(403).json({ error: 'Invalid secret token' });
  }
  
  // Acknowledge immediately (Telegram requires fast response)
  res.sendStatus(200);
  
  try {
    const { message } = req.body;
    if (!message?.text) return;
    
    const chatId = message.chat.id;
    const name = message.from?.first_name || 'Coleccionista';
    const text = message.text;
    
    // Strip bot mention (@botname) from the start
    const cleanText = text.replace(/^@\w+\s*/, '').trim();
    if (!cleanText) return; // empty after stripping mention
    
    console.log(`📩 Telegram [${name}]: ${cleanText}`);
    const reply = await handleMessage(String(chatId), name, 'telegram', cleanText);
    
    if (reply) {
      await sendTelegramMessage(chatId, reply);
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }
});

// ═══════════════════════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════════════════════

initSchema().then(() => {
  app.listen(PORT, () => {
    console.log(`🔄 Panini Swap API → http://localhost:${PORT}`);
    console.log(`🔑 API Key auth: ${API_KEY ? 'enabled' : 'DISABLED ⚠️'}`);
    console.log(`🤖 Telegram: ${TELEGRAM_TOKEN ? 'configured' : 'not set'}`);
    
    // Set up Telegram webhook
    if (TELEGRAM_TOKEN) {
      setupTelegramWebhook();
    }
  });
});
