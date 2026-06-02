/**
 * Einstein's Swap Optimizer
 * 
 * Estrategia de matching:
 * 1. Matches directos: A tiene repetida X que B necesita, B tiene repetida Y que A necesita
 * 2. Detección de ciclos (3+ personas): A→B→C→A 
 * 3. Scoring: rareza × completitud de equipo × cantidad de stickers
 * 4. Prioridad: quien está más cerca de completar un equipo recibe matches primero
 */

export function findMatches(db) {
  // Get all users with inventory
  const users = db.exec(`
    SELECT u.id, u.name, u.location,
           COUNT(CASE WHEN i.status='needed' THEN 1 END) as needed_count,
           COUNT(CASE WHEN i.status='duplicate' THEN 1 END) as duplicate_count,
           COUNT(CASE WHEN i.status='owned' THEN 1 END) as owned_count
    FROM users u
    LEFT JOIN inventory i ON u.id = i.user_id
    GROUP BY u.id
  `)[0]?.values || [];
  
  if (users.length < 2) return { direct: [], cycles: [] };
  
  // Build "has" and "needs" maps per user
  const userDupes = {};  // user_id -> [sticker_ids they have duplicates of]
  const userNeeds = {};  // user_id -> [sticker_ids they need]
  
  for (const [uid] of users) {
    const dupes = db.exec(`
      SELECT sticker_id, quantity FROM inventory 
      WHERE user_id=${uid} AND status='duplicate'
    `)[0]?.values || [];
    userDupes[uid] = dupes.map(r => ({ sticker_id: r[0], qty: r[1] }));
    
    const needs = db.exec(`
      SELECT sticker_id FROM inventory 
      WHERE user_id=${uid} AND status='needed'
    `)[0]?.values || [];
    userNeeds[uid] = new Set(needs.map(r => r[0]));
  }
  
  // Get sticker details for scoring
  const stickerInfo = {};
  const allStickers = db.exec('SELECT id, rarity, team_code, team_name, category FROM stickers')[0]?.values || [];
  for (const [id, rarity, team_code, team_name, cat] of allStickers) {
    stickerInfo[id] = { rarity, team_code, team_name, category: cat };
  }
  
  // Rarity weight
  const rarityWeight = { foil: 3, star: 2, common: 1 };
  
  // Compute team completion % per user
  const userTeamProgress = {};
  for (const [uid] of users) {
    const progress = db.exec(`
      SELECT s.team_code, 
             COUNT(CASE WHEN i.status IN ('owned','duplicate') THEN 1 END) as have,
             COUNT(*) as total
      FROM stickers s
      JOIN inventory i ON s.id = i.sticker_id AND i.user_id = ${uid}
      WHERE s.team_code IS NOT NULL
      GROUP BY s.team_code
    `)[0]?.values || [];
    userTeamProgress[uid] = {};
    for (const [team, have, total] of progress) {
      userTeamProgress[uid][team] = have / total;
    }
  }
  
  // === DIRECT MATCHES ===
  const directMatches = [];
  const usedStickers = new Set(); // track already-matched stickers to avoid conflicts
  
  // Score all possible pairs
  const pairScores = [];
  
  for (let i = 0; i < users.length; i++) {
    for (let j = i + 1; j < users.length; j++) {
      const uidA = users[i][0];
      const uidB = users[j][0];
      
      const aGivesToB = [];
      const bGivesToA = [];
      
      // What A can give to B (A has duplicate, B needs)
      for (const dupe of userDupes[uidA]) {
        if (userNeeds[uidB]?.has(dupe.sticker_id)) {
          aGivesToB.push(dupe.sticker_id);
        }
      }
      
      // What B can give to A (B has duplicate, A needs)
      for (const dupe of userDupes[uidB]) {
        if (userNeeds[uidA]?.has(dupe.sticker_id)) {
          bGivesToA.push(dupe.sticker_id);
        }
      }
      
      if (aGivesToB.length === 0 && bGivesToA.length === 0) continue;
      
      // Score this pair
      let score = 0;
      for (const sid of [...aGivesToB, ...bGivesToA]) {
        const info = stickerInfo[sid];
        if (info) {
          score += rarityWeight[info.rarity] || 1;
        }
      }
      
      // Bonus: both sides benefit
      if (aGivesToB.length > 0 && bGivesToA.length > 0) score *= 2;
      
      // Bonus: team completion proximity
      const teamsInvolved = new Set();
      for (const sid of [...aGivesToB, ...bGivesToA]) {
        if (stickerInfo[sid]?.team_code) teamsInvolved.add(stickerInfo[sid].team_code);
      }
      for (const t of teamsInvolved) {
        const progA = userTeamProgress[uidA]?.[t] || 0;
        const progB = userTeamProgress[uidB]?.[t] || 0;
        score += (progA + progB) * 5; // boost for near-complete teams
      }
      
      pairScores.push({
        userA: uidA, userB: uidB,
        aGivesToB, bGivesToA,
        score,
        nameA: users[i][1], nameB: users[j][1]
      });
    }
  }
  
  // Sort by score descending
  pairScores.sort((a, b) => b.score - a.score);
  
  // Greedy assignment (avoid double-booking stickers)
  const assignedToUser = {}; // user_id -> Set of sticker_ids already promised
  
  for (const pair of pairScores) {
    for (const uid of [pair.userA, pair.userB]) {
      if (!assignedToUser[uid]) assignedToUser[uid] = new Set();
    }
    
    // Filter out already-assigned stickers
    const availableAtoB = pair.aGivesToB.filter(sid => !assignedToUser[pair.userA].has(sid));
    const availableBtoA = pair.bGivesToA.filter(sid => !assignedToUser[pair.userB].has(sid));
    
    if (availableAtoB.length === 0 && availableBtoA.length === 0) continue;
    
    // Mark as assigned
    for (const sid of availableAtoB) assignedToUser[pair.userA].add(sid);
    for (const sid of availableBtoA) assignedToUser[pair.userB].add(sid);
    
    directMatches.push({
      type: 'direct',
      user_a_id: pair.userA,
      user_b_id: pair.userB,
      user_a_name: pair.nameA,
      user_b_name: pair.nameB,
      a_gives_to_b: availableAtoB,
      b_gives_to_a: availableBtoA,
      score: pair.score
    });
  }
  
  // === CYCLE DETECTION ===
  // Build a directed graph: userA -> userB if A has a dupe that B needs
  const graph = {};
  for (const uid of users.map(u => u[0])) {
    graph[uid] = [];
  }
  
  for (const [uid] of users) {
    for (const v of users) {
      if (uid === v[0]) continue;
      const canGive = userDupes[uid]?.filter(d => userNeeds[v[0]]?.has(d.sticker_id)) || [];
      if (canGive.length > 0) {
        graph[uid].push(v[0]);
      }
    }
  }
  
  // Find cycles of length 3+
  const cycles = [];
  const cycleNodes = new Set();
  
  // BFS/DFS to find cycles
  function findCycles(start, current, path, depth) {
    if (depth > 6) return; // max cycle length
    
    for (const next of (graph[current] || [])) {
      if (depth >= 3 && next === start) {
        // Found cycle!
        const cycleKey = [...path].sort().join(',');
        if (!cycleNodes.has(cycleKey)) {
          cycleNodes.add(cycleKey);
          cycles.push({
            users: [...path],
            length: depth
          });
        }
        continue;
      }
      if (!path.includes(next) && depth < 6) {
        findCycles(start, next, [...path, next], depth + 1);
      }
    }
  }
  
  for (const [uid] of users) {
    findCycles(uid, uid, [uid], 1);
  }
  
  // Build cycle match details
  const cycleMatches = [];
  for (const cycle of cycles) {
    const details = [];
    let totalScore = 0;
    
    for (let i = 0; i < cycle.users.length; i++) {
      const giver = cycle.users[i];
      const receiver = cycle.users[(i + 1) % cycle.users.length];
      
      const canGive = userDupes[giver]?.filter(d => userNeeds[receiver]?.has(d.sticker_id)) || [];
      if (canGive.length === 0) continue;
      
      const bestSid = canGive.sort((a, b) => {
        const ra = rarityWeight[stickerInfo[a.sticker_id]?.rarity] || 1;
        const rb = rarityWeight[stickerInfo[b.sticker_id]?.rarity] || 1;
        return rb - ra;
      })[0];
      
      details.push({
        from_user_id: giver,
        to_user_id: receiver,
        sticker_id: bestSid.sticker_id
      });
      totalScore += rarityWeight[stickerInfo[bestSid.sticker_id]?.rarity] || 1;
    }
    
    if (details.length === cycle.users.length) {
      const userNames = cycle.users.map(uid => {
        const u = users.find(u => u[0] === uid);
        return u?.[1] || `User#${uid}`;
      });
      
      cycleMatches.push({
        type: 'cyclic',
        users: cycle.users,
        user_names: userNames,
        details,
        score: totalScore * cycle.users.length,
        cycle_id: `cycle_${cycleMatches.length}`
      });
    }
  }
  
  cycleMatches.sort((a, b) => b.score - a.score);
  
  return { direct: directMatches, cycles: cycleMatches };
}
