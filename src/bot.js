/**
 * Panini Swap Bot — Integration module
 * 
 * Handles natural language commands from Telegram/WhatsApp.
 * 
 * Commands understood:
 * - "me llamo X" / "soy X" → register
 * - "tengo ARG1, MEX5" → mark as owned
 * - "repetida BRA3, GER7" → mark as duplicate  
 * - "necesito MEX10, ARG15" → mark as needed
 * - "cambiar?" / "matches" / "intercambios" → show matches
 * - "mi album" / "mi progreso" → show progress
 * - "equipos" / "selecciones" → list teams
 * - "buscar MEX" or "buscar Messi" → search stickers
 * - "ayuda" → show help
 */

import { getDb, saveDb, initSchema, query, run } from './db.js';
import { findMatches } from './einstein.js';

export async function handleMessage(contactId, name, channel, text) {
  await initSchema();
  const db = await getDb();
  
  const msg = text.toLowerCase().trim();
  
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
  }
  
  // Parse intent
  if (msg.match(/^(ayuda|help|comandos|que puedes hacer)/)) {
    return helpMessage();
  }
  
  if (msg.match(/^(me llamo|soy|registrarme|registrame)/)) {
    const newName = text.replace(/^(me llamo|soy|registrarme|registrame)\s*/i, '').trim() || name;
    run(db, `UPDATE users SET name=? WHERE id=?`, [newName, userId]);
    saveDb();
    return `✅ ¡Registrado, ${newName}! 🌸\n\nTu ID de coleccionista: #${userId}\n\nAhora dime qué figuritas tienes. Por ejemplo:\n• "tengo ARG1, ARG2, MEX5"\n• "repetida BRA3, GER7"\n• "necesito MEX10, MEX15"\n\nO dime "ayuda" para ver todos los comandos.`;
  }
  
  if (msg.match(/^(equipos|selecciones|grupos)/)) {
    return await showTeams(db);
  }
  
  if (msg.match(/^buscar\s/)) {
    const searchQuery = text.replace(/^buscar\s*/i, '').trim();
    return await searchStickers(db, searchQuery);
  }
  
  if (msg.match(/^(tengo|tengo estas|tengo las?|tengo los?)\s/)) {
    const codes = extractCodes(text);
    return await setInventory(db, userId, codes, 'owned');
  }
  
  if (msg.match(/^(repetida|repetidas|repetido|repetidos|duplicada|duplicadas|dupes?)\s/)) {
    const codes = extractCodes(text);
    return await setInventory(db, userId, codes, 'duplicate');
  }
  
  if (msg.match(/^(necesito|me faltan?|me falta|busco)\s/)) {
    const codes = extractCodes(text);
    return await setInventory(db, userId, codes, 'needed');
  }
  
  if (msg.match(/^(cambiar|matches|intercambios?|con quien|cambio|swap)/)) {
    return await showMatches(db, userId);
  }
  
  if (msg.match(/^(mi album|mi progreso|mi coleccion|mi colección|progreso|resumen)/)) {
    return await showProgress(db, userId);
  }
  
  // Default: try to interpret as sticker codes
  const codes = extractCodes(text);
  if (codes.length > 0) {
    return `🤔 No entiendo si "${text}" son figuritas que tienes, repetidas, o necesitas.\n\nPrueba:\n• "tengo ${codes.slice(0,3).join(', ')}"\n• "repetida ${codes.slice(0,3).join(', ')}"\n• "necesito ${codes.slice(0,3).join(', ')}"\n\nO dime "ayuda" para ver qué puedo hacer.`;
  }
  
  return `🌸 ¡Hola! Soy Flor, tu asistente de intercambio de figuritas del Mundial 2026.\n\nPuedes decirme:\n• "tengo" + códigos → figuritas que ya tienes\n• "repetida" + códigos → las que tienes de más\n• "necesito" + códigos → las que te faltan\n• "cambiar?" → ver con quién intercambiar\n• "mi álbum" → ver tu progreso\n• "buscar Messi" → buscar figuritas\n• "equipos" → ver selecciones\n\nO dime "ayuda" para el menú completo.`;
}

function extractCodes(text) {
  // Match codes like: ARG1, MEX15, BRA20, FW1, FWC10
  const matches = text.toUpperCase().match(/[A-Z]{2,4}\d{1,2}|FW\d{1,2}|FWC\d{1,2}/g);
  return matches || [];
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
  
  // Get sticker names
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
  
  // Team progress
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
