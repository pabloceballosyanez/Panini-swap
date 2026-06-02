import { getDb, saveDb, initSchema } from './db.js';
import { findMatches } from './einstein.js';
import { seed } from './seed.js';

async function test() {
  console.log('🌱 Seeding database...');
  await seed();
  
  const db = await getDb();
  
  // Create sample users
  console.log('\n👤 Creating test users...');
  const users = [
    { name: 'Pablo', channel: 'telegram', contact_id: '8604770039', location: 'CDMX' },
    { name: 'María', channel: 'whatsapp', contact_id: '5215551111111', location: 'Guadalajara' },
    { name: 'Carlos', channel: 'telegram', contact_id: '555222222', location: 'Monterrey' },
    { name: 'Ana', channel: 'whatsapp', contact_id: '5215553333333', location: 'CDMX' },
    { name: 'Luis', channel: 'telegram', contact_id: '555444444', location: 'Puebla' },
  ];
  
  // Clear existing test users first
  db.run('DELETE FROM inventory');
  db.run('DELETE FROM matches');
  db.run('DELETE FROM users');
  saveDb();
  
  const userIds = [];
  for (const u of users) {
    db.run(`INSERT INTO users (name, channel, contact_id, location) VALUES ('${u.name}','${u.channel}','${u.contact_id}','${u.location}')`);
    const uid = db.exec("SELECT last_insert_rowid()")[0].values[0][0];
    userIds.push({ id: uid, name: u.name });
  }
  saveDb();
  
  // Assign random stickers to each user
  console.log('\n🎴 Assigning stickers...');
  
  // Get all sticker IDs grouped by team
  const allStickers = db.exec('SELECT id, code, team_code, category, rarity FROM stickers ORDER BY id')[0].values;
  
  // Pablo: needs MEX (uncompleted), has some ARG dupes, nearly complete on BRA
  randomAssign(db, userIds[0].id, allStickers, {
    ownedPct: 0.25,
    duplicatePct: 0.15,
    neededPct: 0.60,
    favoriteTeams: ['MEX'],
    duplicateTeams: ['ARG']
  });
  
  // María: needs ARG, has some MEX dupes, nearly complete on ESP
  randomAssign(db, userIds[1].id, allStickers, {
    ownedPct: 0.30,
    duplicatePct: 0.12,
    neededPct: 0.58,
    favoriteTeams: ['ESP'],
    duplicateTeams: ['MEX']
  });
  
  // Carlos: random mix
  randomAssign(db, userIds[2].id, allStickers, {
    ownedPct: 0.28,
    duplicatePct: 0.10,
    neededPct: 0.62,
    duplicateTeams: ['BRA', 'GER']
  });
  
  // Ana: needs BRA, has GER dupes
  randomAssign(db, userIds[3].id, allStickers, {
    ownedPct: 0.22,
    duplicatePct: 0.14,
    neededPct: 0.64,
    favoriteTeams: ['BRA'],
    duplicateTeams: ['GER', 'FRA']
  });
  
  // Luis: needs GER, has BRA dupes
  randomAssign(db, userIds[4].id, allStickers, {
    ownedPct: 0.26,
    duplicatePct: 0.11,
    neededPct: 0.63,
    favoriteTeams: ['GER'],
    duplicateTeams: ['BRA']
  });
  
  saveDb();
  
  // Show user summaries
  console.log('\n📊 User Summaries:');
  for (const u of userIds) {
    const stats = db.exec(`
      SELECT 
        COUNT(CASE WHEN status='owned' THEN 1 END),
        COUNT(CASE WHEN status='needed' THEN 1 END),
        COUNT(CASE WHEN status='duplicate' THEN 1 END)
      FROM inventory WHERE user_id=${u.id}
    `)[0].values[0];
    console.log(`  ${u.name}: ${stats[0]} owned, ${stats[2]} dupes, ${stats[1]} needed`);
  }
  
  // Run Einstein!
  console.log('\n🧠 Running Einstein Swap Optimizer...');
  const { direct, cycles } = findMatches(db);
  
  console.log(`\n📈 RESULTS:`);
  console.log(`  Direct matches found: ${direct.length}`);
  console.log(`  Cycles found: ${cycles.length}`);
  
  if (direct.length > 0) {
    console.log('\n✨ TOP DIRECT MATCHES:');
    const top5 = direct.slice(0, 5);
    for (const m of top5) {
      const stickerNames = {};
      const ids = [...m.a_gives_to_b, ...m.b_gives_to_a];
      if (ids.length > 0) {
        const placeholders = ids.join(',');
        const names = db.exec(`SELECT id, code, name, team_name FROM stickers WHERE id IN (${placeholders})`)[0]?.values || [];
        for (const [id, code, name, team] of names) {
          stickerNames[id] = `${code} ${name} (${team})`;
        }
      }
      
      console.log(`\n  ${m.user_a_name} ↔ ${m.user_b_name} (score: ${m.score.toFixed(1)})`);
      if (m.a_gives_to_b.length > 0) {
        console.log(`    ${m.user_a_name} da: ${m.a_gives_to_b.map(sid => stickerNames[sid] || `#${sid}`).join(', ')}`);
      }
      if (m.b_gives_to_a.length > 0) {
        console.log(`    ${m.user_b_name} da: ${m.b_gives_to_a.map(sid => stickerNames[sid] || `#${sid}`).join(', ')}`);
      }
    }
  }
  
  if (cycles.length > 0) {
    console.log('\n🔄 CYCLES FOUND:');
    for (const c of cycles.slice(0, 3)) {
      console.log(`  ${c.user_names.join(' → ')} → ${c.user_names[0]} (score: ${c.score.toFixed(1)})`);
    }
  }
  
  console.log('\n✅ Test complete!');
}

function randomAssign(db, userId, allStickers, opts) {
  const stickers = [...allStickers];
  shuffle(stickers);
  
  const teamStickers = {};
  for (const [id, code, team_code, cat, rarity] of stickers) {
    if (team_code) {
      if (!teamStickers[team_code]) teamStickers[team_code] = [];
      teamStickers[team_code].push({ id, code, team_code, cat, rarity });
    }
  }
  
  const assigned = new Set();
  const statuses = {};
  
  // First, assign favorites: own more of those
  if (opts.favoriteTeams) {
    for (const team of opts.favoriteTeams) {
      const teamSticks = teamStickers[team] || [];
      for (const s of teamSticks) {
        if (Math.random() < 0.7) {
          statuses[s.id] = 'owned';
          assigned.add(s.id);
        }
      }
    }
  }
  
  // Assign duplicates from duplicateTeams
  if (opts.duplicateTeams) {
    for (const team of opts.duplicateTeams) {
      const teamSticks = teamStickers[team] || [];
      for (const s of teamSticks) {
        if (Math.random() < 0.5 && !assigned.has(s.id)) {
          statuses[s.id] = 'duplicate';
          assigned.add(s.id);
        }
      }
    }
  }
  
  // Fill remaining
  for (const [id, code, team_code, cat, rarity] of stickers) {
    if (assigned.has(id)) continue;
    const r = Math.random();
    if (r < opts.ownedPct) {
      statuses[id] = 'owned';
    } else if (r < opts.ownedPct + opts.duplicatePct) {
      statuses[id] = 'duplicate';
    } else {
      // Some stay as "needed" — only mark explicitly needed ones
      if (Math.random() < 0.8) {
        statuses[id] = 'needed';
      } else {
        statuses[id] = 'owned';
      }
    }
    assigned.add(id);
  }
  
  // Insert — use multiple rows batch for performance
  const rows = [];
  for (const [sid, status] of Object.entries(statuses)) {
    rows.push(`(${userId},${parseInt(sid)},'${status}',1)`);
  }
  // Batch in chunks
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).join(',');
    db.run(`INSERT INTO inventory (user_id, sticker_id, status, quantity) VALUES ${chunk}`);
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

test().catch(console.error);
