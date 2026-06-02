import { getDb, saveDb, initSchema } from './db.js';

// 48 teams organized in 12 groups (A-L) per official Panini Mundial 2026
const GROUPS = {
  A: ['CZE','MEX','RSA','KOR'],
  B: ['BIH','CAN','QAT','SUI'],
  C: ['BRA','HAI','MAR','SCO'],
  D: ['AUS','PAR','TUR','USA'],
  E: ['CUW','ECU','GER','CIV'],
  F: ['JPN','NED','SWE','TUN'],
  G: ['BEL','EGY','IRN','NZL'],
  H: ['CPV','KSA','ESP','URU'],
  I: ['FRA','IRQ','NOR','SEN'],
  J: ['ALG','ARG','AUT','JOR'],
  K: ['COL','COD','POR','UZB'],
  L: ['CRO','ENG','GHA','PAN']
};

const TEAM_NAMES = {
  CZE: 'Chequia', MEX: 'México', RSA: 'Sudáfrica', KOR: 'Corea del Sur',
  BIH: 'Bosnia y H.', CAN: 'Canadá', QAT: 'Catar', SUI: 'Suiza',
  BRA: 'Brasil', HAI: 'Haití', MAR: 'Marruecos', SCO: 'Escocia',
  AUS: 'Australia', PAR: 'Paraguay', TUR: 'Turquía', USA: 'EE.UU.',
  CUW: 'Curazao', ECU: 'Ecuador', GER: 'Alemania', CIV: 'Costa de Marfil',
  JPN: 'Japón', NED: 'Países Bajos', SWE: 'Suecia', TUN: 'Túnez',
  BEL: 'Bélgica', EGY: 'Egipto', IRN: 'Irán', NZL: 'Nueva Zelanda',
  CPV: 'Cabo Verde', KSA: 'Arabia Saudita', ESP: 'España', URU: 'Uruguay',
  FRA: 'Francia', IRQ: 'Irak', NOR: 'Noruega', SEN: 'Senegal',
  ALG: 'Argelia', ARG: 'Argentina', AUT: 'Austria', JOR: 'Jordania',
  COL: 'Colombia', COD: 'RD Congo', POR: 'Portugal', UZB: 'Uzbekistán',
  CRO: 'Croacia', ENG: 'Inglaterra', GHA: 'Ghana', PAN: 'Panamá'
};

// Opening foils (1-9)
const OPENING = [
  'Logo Panini', 'Emblema Oficial 1', 'Emblema Oficial 2',
  'Mascota 1', 'Mascota 2', 'Slogan Oficial',
  'Balón Oficial', 'País Anfitrión 1', 'País Anfitrión 2'
];

// FIFA Museum (FWC9-FWC19)
const MUSEUM = [
  'Uruguay 1930', 'Italia 1934', 'Italia 1938',
  'Uruguay 1950', 'Alemania 1954', 'Brasil 1958',
  'Brasil 1962', 'Inglaterra 1966', 'Brasil 1970',
  'Alemania 1974', 'Argentina 1978'
];

// Player names per team (common/recent real player names for realism)
const PLAYERS = {
  MEX: ['Ochoa','Álvarez','Montes','Vásquez','Arteaga','Sánchez','Chávez','Pineda','Lozano','Jiménez','Martín','Huerta','Rodríguez','Araujo','Gallardo','Giménez','Antuna','Vega'],
  ARG: ['Martínez','Romero','Otamendi','Tagliafico','Molina','Mac Allister','De Paul','Fernández','Messi','Álvarez','Dybala','Martínez','Lo Celso','Acuña','Palacios','Garnacho','Simeone','González'],
  BRA: ['Alisson','Marquinhos','Militão','Danilo','Lodi','Casemiro','Paquetá','Guimarães','Vinicius Jr','Rodrygo','Raphinha','Neymar','Richarlison','Gabriel','Martinelli','Endrick','João Gomes','Ederson'],
  FRA: ['Maignan','Upamecano','Konaté','Hernández','Koundé','Tchouaméni','Camavinga','Griezmann','Mbappé','Thuram','Dembélé','Kolo Muani','Coman','Zaïre-Emery','Saliba','Rabiot','Giroud','Barcola'],
  GER: ['Ter Stegen','Rüdiger','Schlotterbeck','Raum','Kimmich','Gündogan','Musiala','Wirtz','Sané','Havertz','Füllkrug','Müller','Kroos','Goretzka','Gnabry','Henrichs','Mittelstädt','Andrich'],
  ESP: ['Simón','Laporte','Le Normand','Carvajal','Grimaldo','Rodri','Pedri','Gavi','Yamal','Morata','Williams','Olmo','Ruiz','Torres','Merino','Cucurella','Navas','Oyarzabal'],
  ENG: ['Pickford','Stones','Guéhi','Walker','Shaw','Rice','Bellingham','Foden','Saka','Kane','Palmer','Watkins','Alexander-Arnold','Mainoo','Gordon','Gallagher','Bowen','Eze'],
  POR: ['Costa','Dias','Inácio','Dalot','Mendes','Palhinha','Fernandes','Silva','Leão','Ronaldo','Félix','Ramos','Neves','Jota','Conceição','Neto','Vitinha','Nunes'],
  NED: ['Verbruggen','Van Dijk','Aké','Dumfries','Blind','De Jong','Reijnders','Simons','Gakpo','Depay','Malen','Bergwijn','Wijnaldum','Koopmeiners','Timber','Gravenberch','Zirkzee','Lang'],
  COL: ['Vargas','Cuesta','Lucumí','Mojica','Muñoz','Lerma','Ríos','Carrascal','Díaz','Córdoba','Sinisterra','Borré','James','Uribe','Arias','Durán','Asprilla','Quintero'],
  URU: ['Rochet','Araújo','Giménez','Viña','Nández','Ugarte','Valverde','De Arrascaeta','Pellistri','Núñez','Olivera','Torres','Bentancur','Varela','Canobbio','De la Cruz','Suárez','Satriano'],
  CRO: ['Livaković','Gvardiol','Šutalo','Sosa','Stanišić','Modrić','Kovačić','Brozović','Pašalić','Kramarić','Perišić','Petković','Majer','Juranović','Vlašić','Ivanušec','Budimir','Baturina'],
  MAR: ['Bono','Aguerd','Saïss','Mazraoui','Hakimi','Amrabat','Ounahi','Amallah','Ziyech','En-Nesyri','Boufal','Harit','El Khannouss','Dari','Richardson','Adli','Rahimi','Akhomach'],
  JPN: ['Suzuki','Itakura','Tomiyasu','Sugawara','Ito','Endo','Mitoma','Kubo','Doan','Ueda','Minamino','Kamada','Tanaka','Furuhashi','Hatate','Nakamura','Maeda','Morita'],
  USA: ['Turner','Richards','Ream','Dest','Robinson','McKennie','Musah','Reyna','Pulisic','Balogun','Weah','Aaronson','Cardoso','Pepi','Tillman','Adams','Sargent','Wright'],
  CAN: ['Crépeau','Bombito','Cornelius','Davies','Johnston','Eustáquio','Koné','Buchanan','David','Larin','Millar','Osorio','Laryea','Choinière','Shaffelburg','Ahmed','Bair','Russell-Rowe'],
  BEL: ['Casteels','Faes','Debast','Castagne','Theate','Onana','De Bruyne','Tielemans','Doku','Lukaku','Trossard','Openda','Bakayoko','Mangala','Lavia','De Ketelaere','Lukebakio','Carrasco'],
  ECU: ['Domínguez','Hincapié','Torres','Estupiñán','Preciado','Caicedo','Gruezo','Páez','Minda','Valencia','Sarmiento','Rodríguez','Franco','Cifuentes','Plata','Arroyo','Pacho','Yeboah'],
  GHA: ['Ati-Zigi','Djiku','Salisu','Mensah','Lamptey','Partey','Kudus','Sulemana','Williams','Semenyo','Nuamah','Baba','Owusu','Fatawu','Paintsil','Ashimeru','Adams','Seidu'],
  SEN: ['Mendy','Koulibaly','Diallo','Jakobs','Sabaly','Gueye','Camara','Sarr','Mané','Jackson','Dia','Diatta','Ndiaye','Lamine Camara','Faye','Dieng','Sima','Sarr'],
  KOR: ['Kim S.','Kim M.','Park','Lee K.','Seol','Hwang','Lee J.','Son','Kang','Cho','Jeong','Lee D.','Oh','Bae','Yang','Hong','Kim Y.','Hwang H.'],
  SUI: ['Sommer','Akanji','Elvedi','Rodríguez','Widmer','Xhaka','Freuler','Zakaria','Vargas','Amdouni','Embolo','Shaqiri','Ndoye','Okafor','Jashari','Aebischer','Rieder','Itten'],
  DEN: ['Schmeichel','Christensen','Andersen','Mæhle','Kristensen','Højbjerg','Eriksen','Jensen','Damsgaard','Højlund','Wind','Olsen','Lindstrøm','Nørgaard','Kjær','Bah','Skov Olsen','Dolberg'],
  SWE: ['Olsen','Lindelöf','Hien','Gudmundsson','Krafth','Cajuste','Forsberg','Elanga','Kulusevski','Isak','Gyökeres','Karlström','Svanberg','Holm','Olsson','Bardghji','Bergvall','Nanasi'],
  NOR: ['Nyland','Østigård','Ajer','Bjørkan','Ryerson','Berge','Ødegaard','Bobb','Sørloth','Haaland','Nusa','Larsen','Aursnes','Pedersen','Schjelderup','Wolfe','Thorstvedt','Hauge'],
  TUR: ['Çakır','Demiral','Bardakcı','Kadıoğlu','Çelik','Çalhanoğlu','Yüksek','Güler','Yıldız','Yılmaz','Aktürkoğlu','Ünal','Kahveci','Akaydin','Özcan','Kökçü','Dervişoğlu','Kılıçsoy'],
  PAR: ['Silva','Balbuena','Alderete','Arzamendia','Rojas','Villasanti','Gómez','Almirón','Enciso','Bareiro','Romero','Sosa','Cubas','Espinoza','Sanabria','Bobadilla','González','Giménez'],
  CHI: ['Cortés','Maripán','Díaz','Suazo','Isla','Pulgar','Núñez','Valdés','Brereton','Sánchez','Osorio','Dávila','Méndez','Catalán','Aravena','Loyola','Guerrero','Pizarro'],
  AUS: ['Ryan','Souttar','Burgess','Bos','Karacic','Irvine','McGree','Hrustic','Goodwin','Duke','Boyle','Yengi','O\'Neill','Circati','Tilio','Genreau','Silvera','Irankunda'],
  NZL: ['Crocombe','Boxall','Pijnaker','Cacace','Payne','Bell','Stamenic','Garbett','Just','Wood','Barbarouses','McCowatt','Rufer','Tuiloma','Singh','Waine','Old','Rojas'],
  RSA: ['Williams','Mvala','Mudau','Modiba','Mobbie','Mokoena','Zwane','Tau','Foster','Makgopa','Lorch','Mayambela','Mosele','Lepasa','Mailula','Adams','Sithole','Blom'],
  ALG: ['Mandrea','Bensebaini','Touba','Aït-Nouri','Atal','Bennacer','Boudaoui','Chaïbi','Mahrez','Bounedjah','Benrahma','Amoura','Zerrouki','Aouar','Gouiri','Kadri','Farsi','Belloumi'],
  IRN: ['Beiranvand','Kanani','Khalilzadeh','Mohammadi','Rezaeian','Ezatolahi','Ghoddos','Jahanbakhsh','Taremi','Azmoun','Gholizadeh','Mohebi','Torabi','Hosseini','Ghaedi','Moharrami','Asadi','Sayyadmanesh'],
  IRQ: ['Hassan','Natiq','Sulaka','Adnan','Al-Ammari','Al-Amari','Rashid','Jasim','Ali','Hussein','Attwan','Iqbal','Tahseen','Bayesh','Mohammed','Saadoun','Al-Hamadi','Resan'],
  QAT: ['Al-Sheeb','Khoukhi','Miguel','Ahmed','Salman','Al-Haydos','Boudiaf','Afif','Ali','Abdurisag','Al-Rawi','Alaaeldin','Muntari','Ali Hassan','Fathy','Waad','Mazeed','Mohammad'],
  EGY: ['El Shenawy','Hegazy','Abdelmonem','Hamdy','Hany','Elneny','Fathi','Zizo','Salah','Mohamed','Marmoush','Trézéguet','Koka','Attia','Ashour','Adel','Omar','Rabia'],
  TUN: ['Dahmen','Talbi','Meriah','Abdi','Dräger','Skhiri','Laïdouni','Ben Romdhane','Msakni','Jaziri','Slimane','Rafia','Khenissi','Valery','Jouini','Achouri','Mejbri','Ltaief'],
  CIV: ['Fofana','Ndicka','Boly','Konan','Singo','Kessié','Fofana','Diakité','Pépé','Haller','Adingra','Boga','Sangaré','Kouamé','Doué','Traoré','Bamba','Amad'],
  CMR: ['Onana','Castelletto','Wooh','Tolo','Mukiele','Anguissa','Neyou','Ngamaleu','Aboubakar','Mbeumo','Choupo-Moting','Ekambi','Hongla','Nkoudou','Nsame','Tchato','Eto\'o fils','Doualla'],
  CPV: ['Vozinha','Lopes','Borges','Pereira','Moreira','Duarte','Monteiro','Mendes','Bebé','Tavares','Rodrigues','Rocha','Gonçalves','Andrade','Semedo','Cabral','Pina','Lima'],
  KSA: ['Al-Owais','Al-Boleahi','Al-Shahrani','Tambakti','Al-Ghannam','Kanno','Al-Malki','Al-Dawsari','Al-Shehri','Al-Buraikan','Ghareeb','Al-Muwallad','Al-Faraj','Al-Hassan','Al-Hamddan','Radif','Al-Naji','Otayf'],
  AUT: ['Schlager','Danso','Lienhart','Mwene','Posch','Seiwald','Sabitzer','Baumgartner','Wimmer','Arnautovic','Gregoritsch','Grillitsch','Prass','Kainz','Schmid','Seidl','Adamu','Grüll'],
  CZE: ['Kovář','Holeš','Zima','Jurásek','Coufal','Souček','Sadílek','Provod','Hložek','Kuchta','Chytil','Lingr','Černý','Ševčík','Barák','Douděra','Krejčí','Čvančara'],
  SCO: ['Gunn','Hendry','Porteous','Robertson','Hickey','McTominay','McGinn','Gilmour','McGinn','Adams','Christie','Brown','Armstrong','McLean','Patterson','Doak','Ferguson','Bain'],
  BIH: ['Šehić','Hadžikadunić','Ahmedhodžić','Dedić','Gazibegović','Pjanić','Krunić','Tahirović','Džeko','Prevljak','Demirović','Gojak','Stevanović','Prcić','Bašić','Hodžić','Tabaković','Šarić'],
  HAI: ['Pierre','Arcus','Lambese','Christian','Alcéus','Pierrot','Antoine','Nazon','Etienne','Deedson','Jean Jacques','Simonsen','Metellus','Saba','Guillaume','Picault','Lafontant','Destin'],
  CUW: ['Room','Gaari','Martina','Floranus','Maria','Anita','Bacuna','Leandro Bacuna','Janga','Antonie','Kuwas','Gorré','Van Ewijk','Kastaneer','Lont','Brennét','Margaritha','Zimmerman'],
  JOR: ['Abu Laila','Al-Arab','Al-Ajalin','Haddad','Nasib','Al-Rawabdeh','Al-Taamari','Al-Mardi','Al-Naimat','Olwan','Rateb','Shelbaieh','Ayed','Samir','Abu Zraiq','Abu Hasheesh','Al-Dardour','Zrayq'],
  UZB: ['Yusupov','Ashurmatov','Alikulov','Sayfiev','Khusanov','Shukurov','Masharipov','Urunov','Shomurodov','Fayzullaev','Erkinov','Khamrobekov','Nasrullaev','Abdikholikov','Turgunboev','Iskanderov','Aliqulov','Nematov'],
  PAN: ['Mosquera','Escobar','Córdoba','Davis','Murillo','Godoy','Carrasquilla','Bárcenas','Yanis','Waterman','Fajardo','Gondola','Pimentel','Welch','Rodríguez','Phillips','Guerrero','Anderson'],
  COD: ['Mpasi','Mbemba','Inonga','Masuaku','Kalulu','Moutoussamy','Kakuta','Wissa','Bakambu','Bongonda','Mayele','Tshibola','Pickel','Batubinsika','Silas','Elia','Katompa','Kayembe']
};

// Generate all players for any missing teams
function getPlayersFor(teamCode) {
  if (PLAYERS[teamCode]) return PLAYERS[teamCode];
  // Generate generic player names if we don't have real ones
  const surnames = ['Silva','Santos','Costa','Pereira','Rodríguez','Martínez','García','Fernández','López','González','Torres','Díaz','Moreno','Alonso','Ramos','Hernández','Ruiz','Jiménez','Morales','Ortiz','Castillo','Flores','Chávez','Rivera','Reyes','Gómez','Vargas','Cruz','Medina','Aguilar','Pérez','Muñoz','Peña','Álvarez','Romero','Mendoza','Suárez','Paredes','Castro','Guzmán','Rojas','Navarro','Delgado','Herrera','Vega','Campos','Acosta','Ríos','Cabrera','Luna'];
  return Array.from({length:18}, (_,i) => surnames[(i*7 + teamCode.charCodeAt(0)) % surnames.length]);
}

export async function seed() {
  await initSchema();
  const db = await getDb();
  
  // Clear existing
  db.run('DELETE FROM inventory');
  db.run('DELETE FROM matches');
  db.run('DELETE FROM users');
  db.run('DELETE FROM stickers');
  
  const inserts = [];
  
  // 1. Opening foils (stickers 1-9)
  OPENING.forEach((name, i) => {
    const code = `FW${i+1}`;
    inserts.push(`('${code}','${name.replace(/'/g,"''")}',NULL,NULL,NULL,'opening','foil',${i+1})`);
  });
  
  // 2. FIFA Museum (stickers FWC9-FWC19)
  MUSEUM.forEach((name, i) => {
    const code = `FWC${i+9}`;
    inserts.push(`('${code}','${name.replace(/'/g,"''")}',NULL,NULL,NULL,'museum','foil',${i+9})`);
  });
  
  // 3. Teams: 48 teams x 20 stickers = 960
  for (const [group, teams] of Object.entries(GROUPS)) {
    for (const teamCode of teams) {
      const teamName = (TEAM_NAMES[teamCode] || teamCode).replace(/'/g,"''");
      const players = getPlayersFor(teamCode);
      
      // Team badge (foil)
      inserts.push(`('${teamCode}1','Escudo ${teamName}','${teamCode}','${teamName}','${group}','badge','foil',1)`);
      
      // Team photo
      inserts.push(`('${teamCode}2','Foto ${teamName}','${teamCode}','${teamName}','${group}','team_photo','common',2)`);
      
      // 18 players
      for (let i = 0; i < 18; i++) {
        const playerNum = i + 3;
        const playerName = players[i].replace(/'/g,"''");
        const isStar = i < 3 ? 'star' : 'common';
        inserts.push(`('${teamCode}${playerNum}','${playerName}','${teamCode}','${teamName}','${group}','player','${isStar}',${playerNum})`);
      }
    }
  }
  
  // Batch insert in chunks of 100 to avoid SQL size limits
  const sql = 'INSERT INTO stickers (code, name, team_code, team_name, group_name, category, rarity, number_in_team) VALUES ';
  for (let i = 0; i < inserts.length; i += 100) {
    const chunk = inserts.slice(i, i + 100).join(',');
    db.run(sql + chunk);
  }
  
  saveDb();
  
  const count = db.exec('SELECT COUNT(*) as c FROM stickers')[0].values[0][0];
  console.log(`✅ Seeded ${count} stickers into database.`);
}

// Run directly if called as main script
if (process.argv[1]?.includes('seed.js')) {
  seed().catch(console.error);
}
