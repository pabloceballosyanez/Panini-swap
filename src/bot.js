/**
 * Panini Swap Bot — Integration module
 * 
 * Handles natural language commands from Telegram/WhatsApp.
 * Returns { reply, notifications } where notifications are 
 * messages to send to counterparties when new matches are found.
 */

import { getDb, saveDb, initSchema, query, run } from './db.js';
import { findMatches } from './einstein.js';

/**
 * @returns {{ reply: string, notifications: Array<{chatId: string, message: string}> }}
 */
export async function handleMessage(contactId, name, channel, text) {
  await initSchema();
  const db = await getDb();
  
  const msg = text.toLowerCase().trim();
  let response = '';
  let wasInventoryChange = false;
  
  // Register or find user
  let rows = query(db, 
    `SELECT id, name FROM users WHERE channel=? AND contact_id=?`, 
    [channel, contactId]
  );
  
  let userId;
  if (rows.length === 0) {
    const result = run(db,
      `INSERT INTO users (name, channel, contact_id) VALUES (?,?,?)`,
      [name, channel, contactId]
    );
    saveDb();
    userId = result.lastInsertRowid;
  } else {
    userId = rows[0][0];
    // Update name silently
    if (name && name !== 'Coleccionista' && rows[0][1] !== name) {
      run(db, `UPDATE users SET name=? WHERE id=?`, [name, userId]);
      saveDb();
    }
  }
  
  const userName = query(db, `SELECT name FROM users WHERE id=?`, [userId])[0]?.[0] || name;
  
  // ── Try bulk format first (multi-line team lists) ──
  const bulk = parseBulkMessage(text);
  if (bulk && (bulk.owned.length + bulk.needed.length + bulk.duplicate.length > 0)) {
    response = await setBulkInventory(db, userId, userName, bulk);
    wasInventoryChange = true;
  }
  // Parse intent
  else if (msg.match(/^(ayuda|help|comandos|que puedes hacer)/)) {
    response = helpMessage();
  } else if (msg.match(/^(me llamo|soy|registrarme|registrame)/)) {
    const newName = text.replace(/^(me llamo|soy|registrarme|registrame)\s*/i, '').trim() || name;
    run(db, `UPDATE users SET name=? WHERE id=?`, [newName, userId]);
    saveDb();
    response = `✅ ¡Registrado, ${newName}! 🌸\n\nTu ID de coleccionista: #${userId}\n\nAhora dime qué figuritas tienes. Por ejemplo:\n• "tengo ARG1, ARG2, MEX5"\n• "repetida BRA3, GER7"\n• "necesito MEX10, MEX15"\n\nO dime "ayuda" para ver todos los comandos.`;
  } else if (msg.match(/^(equipos|selecciones|grupos)/)) {
    response = await showTeams(db);
  } else if (msg.match(/^buscar\s/)) {
    const searchQuery = text.replace(/^buscar\s*/i, '').trim();
    response = await searchStickers(db, searchQuery);
  } else if (msg.match(/^(tengo|tengo estas|tengo las?|tengo los?)\s/)) {
    const codes = extractCodes(text);
    response = await setInventory(db, userId, codes, 'owned');
    wasInventoryChange = true;
  } else if (msg.match(/^(repetida|repetidas|repetido|repetidos|duplicada|duplicadas|dupes?)\s/)) {
    const codes = extractCodes(text);
    response = await setInventory(db, userId, codes, 'duplicate');
    wasInventoryChange = true;
  } else if (msg.match(/^(necesito|me faltan?|me falta|busco)\s/)) {
    const codes = extractCodes(text);
    response = await setInventory(db, userId, codes, 'needed');
    wasInventoryChange = true;
  } else if (msg.match(/^(cambiar|matches|intercambios?|con quien|cambio|swap)/)) {
    response = await showMatches(db, userId);
  } else if (msg.match(/^(mi album|mi progreso|mi coleccion|mi colección|progreso|resumen)/)) {
    response = await showProgress(db, userId);
  } else {
    // Default: try to interpret as sticker codes
    const codes = extractCodes(text);
    if (codes.length > 0) {
      response = `🤔 No entiendo si "${text}" son figuritas que tienes, repetidas, o necesitas.\n\nPrueba:\n• "tengo ${codes.slice(0,3).join(', ')}"\n• "repetida ${codes.slice(0,3).join(', ')}"\n• "necesito ${codes.slice(0,3).join(', ')}"\n\nO dime "ayuda" para ver qué puedo hacer.`;
    } else {
      response = `🌸 ¡Hola! Soy Flor, tu asistente de intercambio de figuritas del Mundial 2026.\n\nPuedes decirme:\n• "tengo" + códigos → figuritas que ya tienes\n• "repetida" + códigos → las que tienes de más\n• "necesito" + códigos → las que te faltan\n• "cambiar?" → ver con quién intercambiar\n• "mi álbum" → ver tu progreso\n• "buscar Messi" → buscar figuritas\n• "equipos" → ver selecciones\n\nO dime "ayuda" para el menú completo.`;
    }
  }
  
  // ── Auto-matchmaking after inventory changes ──
  let notifications = [];
  if (wasInventoryChange) {
    const alert = await getAutoMatchAlert(db, userId, userName);
    if (alert.replySuffix) response += alert.replySuffix;
    notifications = alert.notifications;
  }
  
  return { reply: response, notifications };
}

function extractCodes(text) {
  const matches = text.toUpperCase().match(/[A-Z]{2,4}\d{1,2}|FW\d{1,2}|FWC\d{1,2}/g);
  return matches || [];
}

/**
 * Detect and parse bulk message format:
 * 
 * I need / Necesito / Faltan
 * MEX 🇲🇽: 8, 20
 * ARG 🇦🇷: 3, 4, 17
 * 
 * Swaps / Repetidas / Tengo para cambiar
 * BRA 🇧🇷: 9, 15
 * 
 * Tengo / Have
 * USA 🇺🇸: 2, 7
 * 
 * Returns { owned: [], needed: [], duplicate: [] } or null if not bulk format.
 */
function parseBulkMessage(text) {
  const lines = text.split('\n');
  let currentStatus = null;
  const result = { owned: [], needed: [], duplicate: [] };
  let teamLinesFound = 0;
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    const lower = trimmed.toLowerCase();
    
    // Detect section headers
    if (/^(need|necesito|faltan|faltantes|me faltan|i need|busco)\b/i.test(lower)) {
      currentStatus = 'needed';
      continue;
    }
    if (/^(swaps?|repetid[oa]s?|duplicad[oa]s?|para cambiar|tengo para cambiar|dupes?|swap|cambio|cambiar|intercambio)\b/i.test(lower)) {
      currentStatus = 'duplicate';
      continue;
    }
    if (/^(tengo|have|ya tengo|pegadas|owned|tengo estas|colecci[oó]n|album|[áa]lbum|mi [áa]lbum)\b/i.test(lower)) {
      currentStatus = 'owned';
      continue;
    }
    
    // Parse team-number line
    if (currentStatus) {
      const codes = parseTeamLine(trimmed);
      if (codes.length > 0) {
        teamLinesFound++;
        result[currentStatus].push(...codes);
      }
    }
  }
  
  // Only return bulk result if we found at least 2 team lines
  // (to avoid false positives on single-line messages)
  if (teamLinesFound >= 2) return result;
  return null;
}

/**
 * Parse a line like "MEX 🇲🇽: 8, 20" → ["MEX8", "MEX20"]
 * Also handles: "FWC 🏆: 00, 3" → ["FWC00", "FWC3"]
 *              "ARG: 1 2 3" → ["ARG1", "ARG2", "ARG3"]
 *              "BRA - 10, 20" → ["BRA10", "BRA20"]
 */
function parseTeamLine(line) {
  // Match: TEAM_CODE (2-4 letters) followed by optional emoji/flag, then separator, then numbers
  // Separator can be : or - or just whitespace
  // Numbers can be separated by , or spaces or both
  const match = line.match(/^([A-Z]{2,4})\s*(?:[^\d,:;\-]+)?\s*[:;\-]?\s*(.+)$/i);
  if (!match) return [];
  
  const teamCode = match[1].toUpperCase();
  const numbersStr = match[2];
  
  // Extract all numbers (1-2 digits)
  const numbers = numbersStr.match(/\d{1,2}/g);
  if (!numbers) return [];
  
  return numbers.map(n => `${teamCode}${n}`);
}

/**
 * Process a bulk inventory update across all three statuses.
 */
async function setBulkInventory(db, userId, userName, bulk) {
  const responses = [];
  let totalFound = 0;
  let totalNotFound = 0;
  const allNotFound = [];
  
  const statusConfig = [
    { key: 'owned', label: 'Tienes' },
    { key: 'duplicate', label: 'Repetidas' },
    { key: 'needed', label: 'Necesitas' }
  ];
  
  for (const { key, label } of statusConfig) {
    const codes = bulk[key];
    if (codes.length === 0) continue;
    
    const found = [];
    const notFound = [];
    
    for (const code of codes) {
      const rows = query(db, 
        `SELECT id, name, team_name, rarity FROM stickers WHERE code=?`,
        [code]
      );
      
      if (rows.length > 0) {
        const [id, stickerName, team, rarity] = rows[0];
        found.push({ code, name: stickerName, team, rarity });
        
        run(db,
          `INSERT INTO inventory (user_id, sticker_id, status, quantity) 
           VALUES (?,?,?,1)
           ON CONFLICT(user_id, sticker_id) DO UPDATE SET status=excluded.status, updated_at=datetime('now')`,
          [userId, id, key]
        );
      } else {
        notFound.push(code);
      }
    }
    
    totalFound += found.length;
    totalNotFound += notFound.length;
    allNotFound.push(...notFound);
    
    if (found.length > 0) {
      // Group by team
      const byTeam = {};
      for (const f of found) {
        const t = f.team || 'Especiales';
        if (!byTeam[t]) byTeam[t] = [];
        byTeam[t].push(`${f.code} ${f.name}${f.rarity === 'foil' ? ' ✨' : ''}`);
      }
      
      let section = `📋 **${label}** ${found.length} figurita(s):\n`;
      for (const [team, stickers] of Object.entries(byTeam)) {
        section += `  🏆 ${team}: ${stickers.map(s => s.split(' ')[0]).join(', ')}\n`;
      }
      responses.push(section);
    }
  }
  
  saveDb();
  
  let response = `✅ ¡Procesado, ${userName}! 🌸\n\n`;
  response += `📊 ${totalFound} figuritas registradas\n`;
  if (responses.length > 0) {
    response += responses.join('\n');
  }
  if (allNotFound.length > 0) {
    response += `\n⚠️ No reconocí: ${allNotFound.join(', ')}\n`;
    response += `💡 Los códigos son como: ARG1, MEX5, FWC16, FW1`;
  }
  
  return response;
}

async function setInventory(db, userId, codes, status) {
  if (codes.length === 0) {
    return '❌ No encontré códigos de figuritas en tu mensaje.\n\nLos códigos son como: ARG1, MEX5, BRA10, FW1, FWC15\n\nEjemplo: "tengo ARG1, ARG2, MEX5"';
  }
  
  const statusNames = { owned: 'Tienes', duplicate: 'Repetida', needed: 'Necesitas' };
  const found = [];
  const notFound = [];
  
  for (const code of codes) {
    const rows = query(db, 
      `SELECT id, name, team_name, rarity FROM stickers WHERE code=?`,
      [code]
    );
    
    if (rows.length > 0) {
      const [id, stickerName, team, rarity] = rows[0];
      found.push({ code, name: stickerName, team, rarity });
      
      run(db,
        `INSERT INTO inventory (user_id, sticker_id, status, quantity) 
         VALUES (?,?,?,1)
         ON CONFLICT(user_id, sticker_id) DO UPDATE SET status=excluded.status, updated_at=datetime('now')`,
        [userId, id, status]
      );
    } else {
      notFound.push(code);
    }
  }
  
  saveDb();
  
  let response = '';
  if (found.length > 0) {
    const byTeam = {};
    for (const f of found) {
      const t = f.team || 'Especiales';
      if (!byTeam[t]) byTeam[t] = [];
      byTeam[t].push(`${f.code} ${f.name}${f.rarity === 'foil' ? ' ✨' : ''}`);
    }
    
    response += `✅ **${statusNames[status]}** ${found.length} figurita(s):\n`;
    for (const [team, stickers] of Object.entries(byTeam)) {
      response += `\n🏆 ${team}:\n${stickers.map(s => `  • ${s}`).join('\n')}`;
    }
  }
  
  if (notFound.length > 0) {
    response += `\n\n⚠️ No encontré: ${notFound.join(', ')}`;
  }
  
  return response;
}

/**
 * After inventory changes, run Einstein and return:
 * - replySuffix: match summary to append to user's reply
 * - notifications: messages to send to counterparties' Telegram
 */
async function getAutoMatchAlert(db, userId, userName) {
  const { direct, cycles } = findMatches(db);
  
  const myDirect = direct.filter(m => m.user_a_id === userId || m.user_b_id === userId);
  const myCycles = cycles.filter(c => c.users.includes(userId));
  const total = myDirect.length + myCycles.length;
  
  let replySuffix = '';
  if (total > 0) {
    replySuffix = `\n\n🧠 **Einstein encontró ${total} posible(s) intercambio(s).**\nDi "cambiar?" para ver los detalles.`;
  }
  
  // ── Build notifications for counterparties ──
  const notifications = [];
  const notifiedUsers = new Set();
  
  // Get sticker names
  const stickerNames = {};
  const allStickers = query(db, 'SELECT id, code, name, team_name FROM stickers');
  for (const [id, code, name, team] of allStickers) {
    stickerNames[id] = { code, name, team };
  }
  
  for (const m of myDirect.slice(0, 5)) {
    const otherId = m.user_a_id === userId ? m.user_b_id : m.user_a_id;
    if (notifiedUsers.has(otherId)) continue;
    notifiedUsers.add(otherId);
    
    const otherName = m.user_a_id === userId ? m.user_b_name : m.user_a_name;
    const otherUser = query(db, 'SELECT channel, contact_id FROM users WHERE id=?', [otherId]);
    
    if (otherUser.length > 0 && otherUser[0][0] === 'telegram') {
      // What this other user would give/get
      const gives = m.user_a_id === userId ? m.b_gives_to_a : m.a_gives_to_b;
      const gets = m.user_a_id === userId ? m.a_gives_to_b : m.b_gives_to_a;
      
      const givesList = gives?.map(sid => {
        const s = stickerNames[sid];
        return s ? `${s.code} ${s.name}` : '';
      }).filter(Boolean) || [];
      
      const getsList = gets?.map(sid => {
        const s = stickerNames[sid];
        return s ? `${s.code} ${s.name}` : '';
      }).filter(Boolean) || [];
      
      let msg = `🧠 ¡Einstein encontró un intercambio! **${userName}** tiene figuritas que coinciden contigo.\n\n`;
      if (givesList.length) msg += `📤 Darías: ${givesList.join(', ')}\n`;
      if (getsList.length) msg += `📥 Recibirías: ${getsList.join(', ')}\n`;
      msg += `\nDi "cambiar?" para ver todos tus intercambios.`;
      
      notifications.push({
        chatId: otherUser[0][1],
        message: msg
      });
    }
  }
  
  return { replySuffix, notifications };
}

async function showMatches(db, userId) {
  const userRows = query(db, `SELECT name FROM users WHERE id=?`, [userId]);
  const userName = userRows[0]?.[0] || 'Tú';
  
  const { direct, cycles } = findMatches(db);
  
  const myDirect = direct.filter(m => m.user_a_id === userId || m.user_b_id === userId);
  const myCycles = cycles.filter(c => c.users.includes(userId));
  
  if (myDirect.length === 0 && myCycles.length === 0) {
    return `🔍 No hay matches para ti todavía.\n\nRegistra más figuritas y tus repetidas para que Einstein encuentre intercambios.\n\nTambién puedes ver todo tu progreso con "mi álbum".`;
  }
  
  let response = `🧠 **Einstein encontró ${myDirect.length + myCycles.length} oportunidades:**\n`;
  
  const stickerNames = {};
  const allStickers = query(db, 'SELECT id, code, name, team_name FROM stickers');
  for (const [id, code, stickerName, team] of allStickers) {
    stickerNames[id] = { code, name: stickerName, team };
  }
  
  if (myDirect.length > 0) {
    response += `\n✨ **Intercambios directos:**\n`;
    for (const m of myDirect.slice(0, 5)) {
      const otherName = m.user_a_id === userId ? m.user_b_name : m.user_a_name;
      const givesToList = m.user_a_id === userId ? m.a_gives_to_b : m.b_gives_to_a;
      const getsFromList = m.user_a_id === userId ? m.b_gives_to_a : m.a_gives_to_b;
      
      const gives = givesToList?.map(sid => {
        const s = stickerNames[sid];
        return s ? `${s.code} ${s.name}` : `#${sid}`;
      }) || [];
      
      const gets = getsFromList?.map(sid => {
        const s = stickerNames[sid];
        return s ? `${s.code} ${s.name}` : `#${sid}`;
      }) || [];
      
      response += `\n**${userName} ↔ ${otherName}** (score: ${m.score.toFixed(0)})\n`;
      if (gives.length) response += `  Tú das: ${gives.join(', ')}\n`;
      if (gets.length) response += `  Recibes: ${gets.join(', ')}\n`;
    }
    if (myDirect.length > 5) response += `\n...y ${myDirect.length - 5} más.`;
  }
  
  if (myCycles.length > 0) {
    response += `\n🔄 **Intercambios en cadena:**\n`;
    for (const c of myCycles.slice(0, 3)) {
      response += `\n${c.user_names.join(' → ')} → ${c.user_names[0]}\n`;
    }
  }
  
  return response;
}

async function showProgress(db, userId) {
  const stats = query(db, `
    SELECT 
      COUNT(CASE WHEN i.status='owned' THEN 1 END) as owned,
      COUNT(CASE WHEN i.status='duplicate' THEN 1 END) as dupes,
      COUNT(CASE WHEN i.status='needed' THEN 1 END) as needed
    FROM inventory i WHERE user_id=?
  `, [userId]);
  
  const [owned, dupes, needed] = stats[0] || [0, 0, 0];
  const total = owned + dupes + needed || 1;
  const pct = ((owned / 980) * 100).toFixed(1);
  
  let response = `📊 **Tu Álbum**\n\n`;
  response += `✅ ${owned} pegadas | 📦 ${dupes} repetidas | 🔍 ${needed} faltantes\n`;
  response += `📈 ${pct}% del álbum completo (${owned}/980)\n`;
  
  const teams = query(db, `
    SELECT s.team_name, s.group_name,
           COUNT(CASE WHEN i.status IN ('owned','duplicate') THEN 1 END) as have,
           COUNT(*) as total
    FROM stickers s
    LEFT JOIN inventory i ON s.id = i.sticker_id AND i.user_id = ?
    WHERE s.team_name IS NOT NULL
    GROUP BY s.team_code
    ORDER BY have DESC
    LIMIT 10
  `, [userId]);
  
  response += `\n🏆 **Mejores equipos:**\n`;
  for (const [team, group, have, total] of teams) {
    const bar = '█'.repeat(Math.round(have / total * 10)) + '░'.repeat(10 - Math.round(have / total * 10));
    response += `${bar} ${team} (${have}/${total})\n`;
  }
  
  return response;
}

async function showTeams(db) {
  const teams = query(db, `
    SELECT team_code, team_name, group_name FROM stickers 
    WHERE team_code IS NOT NULL 
    GROUP BY team_code ORDER BY group_name, team_name
  `);
  
  let response = `🌍 **48 selecciones del Mundial 2026**\n\n`;
  let currentGroup = '';
  
  for (const [code, name, group] of teams) {
    if (group !== currentGroup) {
      currentGroup = group;
      response += `\n📋 **Grupo ${group}:**\n`;
    }
    response += `  ${code} ${name}\n`;
  }
  
  response += `\n💡 Usa los códigos (ej: ARG1, MEX5) para registrar tus figuritas.`;
  return response;
}

async function searchStickers(db, searchQuery) {
  const q = searchQuery.toUpperCase();
  const likePattern = `%${searchQuery}%`;
  
  const results = query(db, `
    SELECT code, name, team_name, category, rarity FROM stickers 
    WHERE code LIKE ? OR name LIKE ? OR team_code=? OR team_name LIKE ?
    LIMIT 15
  `, [likePattern, likePattern, q, likePattern]);
  
  if (!results.length) return `🔍 No encontré figuritas para "${searchQuery}". Prueba con el código del equipo (MEX, ARG, BRA) o el nombre de un jugador.`;
  
  let response = `🔍 Resultados para "${searchQuery}":\n`;
  for (const [code, stickerName, team, cat, rarity] of results) {
    const badges = { foil: '✨', star: '⭐', common: '' };
    response += `\n• ${code} — ${stickerName}${badges[rarity] || ''} (${team || 'Especial'})`;
  }
  
  return response;
}

function helpMessage() {
  return `🌸 **Flor — Asistente de Intercambio Panini** 🌸\n
📋 **Comandos:**\n
**Registro:**
• "me llamo [nombre]" — registrarte

**Inventario:**
• "tengo ARG1, MEX5, BRA10" — figuritas que ya pegaste
• "repetida BRA3, GER7" — figuritas repetidas para cambiar
• "necesito MEX10, MEX15" — figuritas que te faltan

**Consultas:**
• "cambiar?" — ver con quién puedes intercambiar
• "mi álbum" — ver tu progreso
• "equipos" — lista de las 48 selecciones
• "buscar Messi" o "buscar MEX" — buscar figuritas

**Códigos de figuritas:**
• ARG1 = Escudo Argentina, ARG2 = Foto equipo
• ARG3-ARG20 = jugadores (Messi = ARG12)
• MEX1 = Escudo México, MEX2 = Foto equipo
• FW1-FW9 = stickers especiales de apertura
• FWC10-FWC19 = FIFA Museum (copas históricas)

💡 *Tip: dime "equipos" para ver todas las selecciones.*`;
}
