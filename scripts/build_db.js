// Builds ffl.db (SQLite) from the raw FOF8 league-data CSV exports in the FFL folder.
// Run with: node scripts/build_db.js
'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(ROOT, 'ffl.db');

function listCsvFiles() {
  return fs.readdirSync(ROOT).filter(f => f.endsWith('.csv'));
}

// Minimal CSV line parser: handles the plain unquoted files (the FOF exports)
// as well as quoted fields (used by coaching_candidates_top7.csv).
function parseLine(line) {
  if (line.indexOf('"') === -1) return line.split(',');
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function readLines(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function sqlIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

const INT_RE = /^-?\d+$/;

function inferTypes(colNames, sampleRows) {
  const isInt = colNames.map(() => true);
  for (const row of sampleRows) {
    for (let i = 0; i < colNames.length; i++) {
      const v = row[i];
      if (v === undefined || v === '') continue;
      if (!INT_RE.test(v)) isInt[i] = false;
    }
  }
  return colNames.map((_, i) => (isInt[i] ? 'INTEGER' : 'TEXT'));
}

function createTable(db, tableName, colNames, colTypes) {
  db.exec(`DROP TABLE IF EXISTS ${sqlIdent(tableName)}`);
  const cols = colNames.map((c, i) => `${sqlIdent(c)} ${colTypes[i]}`).join(', ');
  db.exec(`CREATE TABLE ${sqlIdent(tableName)} (${cols})`);
}

function insertRows(db, tableName, colNames, rowsIterable, expectCols) {
  const placeholders = colNames.map(() => '?').join(', ');
  const stmt = db.prepare(
    `INSERT INTO ${sqlIdent(tableName)} (${colNames.map(sqlIdent).join(', ')}) VALUES (${placeholders})`
  );
  let n = 0;
  db.exec('BEGIN');
  for (const fields of rowsIterable) {
    let f = fields;
    if (f.length > expectCols) f = f.slice(0, expectCols);
    else if (f.length < expectCols) {
      f = f.slice();
      while (f.length < expectCols) f.push('');
    }
    const params = f.map(v => (v === '' ? null : v));
    stmt.run(...params);
    n++;
    if (n % 200000 === 0) {
      db.exec('COMMIT');
      db.exec('BEGIN');
    }
  }
  db.exec('COMMIT');
  return n;
}

function ingestSingleFile(db, tableName, fileName) {
  const lines = readLines(path.join(ROOT, fileName));
  const header = parseLine(lines[0]);
  const dataLines = lines.slice(1);
  const sampleRows = dataLines.slice(0, 500).map(parseLine);
  const colTypes = inferTypes(header, sampleRows);
  createTable(db, tableName, header, colTypes);
  const rows = dataLines.map(parseLine);
  const n = insertRows(db, tableName, header, rows, header.length);
  console.log(`  ${tableName.padEnd(28)} <- ${fileName.padEnd(20)} ${n} rows`);
}

function ingestGroupedFiles(db, tableName, files, headerOverride) {
  files.sort();
  const firstLines = readLines(path.join(ROOT, files[0]));
  const header = headerOverride || parseLine(firstLines[0]);
  const ncols = header.length;

  // Sample rows across a spread of files for type inference.
  const sampleFiles = [files[0], files[Math.floor(files.length / 2)], files[files.length - 1]];
  const sampleRows = [];
  for (const f of sampleFiles) {
    const lines = readLines(path.join(ROOT, f));
    for (const l of lines.slice(1, 200)) sampleRows.push(parseLine(l));
  }
  const colTypes = inferTypes(header, sampleRows);
  createTable(db, tableName, header, colTypes);

  let total = 0;
  const placeholders = header.map(() => '?').join(', ');
  const stmt = db.prepare(
    `INSERT INTO ${sqlIdent(tableName)} (${header.map(sqlIdent).join(', ')}) VALUES (${placeholders})`
  );
  for (const f of files) {
    const lines = readLines(path.join(ROOT, f));
    const dataLines = lines.slice(1);
    db.exec('BEGIN');
    let n = 0;
    for (const line of dataLines) {
      let fields = parseLine(line);
      if (fields.length > ncols) fields = fields.slice(0, ncols);
      else if (fields.length < ncols) {
        fields = fields.slice();
        while (fields.length < ncols) fields.push('');
      }
      const params = fields.map(v => (v === '' ? null : v));
      stmt.run(...params);
      n++;
    }
    db.exec('COMMIT');
    total += n;
  }
  console.log(`  ${tableName.padEnd(28)} <- ${files.length} yearly files, ${total} rows`);
  return header;
}

function main() {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = OFF');
  db.exec('PRAGMA synchronous = OFF');

  const allCsv = listCsvFiles();

  const grouped = {
    player_season: [],
    player_ratings_season: [],
    transactions: [],
  };
  const singles = [];

  for (const f of allCsv) {
    if (/^player_season_\d{4}\.csv$/.test(f)) grouped.player_season.push(f);
    else if (/^player_ratings_season_\d{4}\.csv$/.test(f)) grouped.player_ratings_season.push(f);
    else if (/^transactions_\d{4}\.csv$/.test(f)) grouped.transactions.push(f);
    else singles.push(f);
  }

  console.log('Ingesting single-file tables...');
  for (const f of singles) {
    const tableName = f.replace(/\.csv$/, '');
    ingestSingleFile(db, tableName, f);
  }

  console.log('Ingesting yearly player_season files...');
  const playerSeasonCols = ingestGroupedFiles(db, 'player_season', grouped.player_season);

  console.log('Ingesting yearly player_ratings_season files...');
  const ratingsCols = ingestGroupedFiles(db, 'player_ratings_season', grouped.player_ratings_season);

  console.log('Ingesting yearly transactions files (generic column names)...');
  const transactionsHeader = [
    'Stage', 'Year', 'Entity_ID', 'Transaction', 'Team',
    'Group_Field', 'Money', 'Detail_1', 'Detail_2',
  ];
  ingestGroupedFiles(db, 'transactions', grouped.transactions, transactionsHeader);

  console.log('Indexing...');
  db.exec('CREATE INDEX idx_player_season_pid_year ON player_season("Player_ID","Year")');
  db.exec('CREATE INDEX idx_player_season_year_week ON player_season("Year","Week")');
  db.exec('CREATE INDEX idx_ratings_pid_year ON player_ratings_season("Player_ID","Year")');
  db.exec('CREATE INDEX idx_player_info_pid ON player_information("Player_ID")');
  db.exec('CREATE INDEX idx_player_record_pid ON player_record("Player_ID")');
  db.exec('CREATE INDEX idx_standings_year_team ON standings("Year","Team")');
  db.exec('CREATE INDEX idx_transactions_year_entity ON transactions("Year","Entity_ID")');

  console.log('Building player_year_summary...');
  buildPlayerYearSummary(db, playerSeasonCols, ratingsCols);

  db.close();
  console.log('Done. Database written to ' + DB_PATH);
}

function buildPlayerYearSummary(db, playerSeasonCols, ratingsCols) {
  const skipSeason = new Set(['Record_Number', 'Player_ID', 'Week', 'Year', 'Team', 'Opponent']);
  const statCols = playerSeasonCols.filter(c => !skipSeason.has(c));

  const regSelect = statCols.map(c => `SUM(${sqlIdent(c)}) AS ${sqlIdent(c)}`).join(', ');
  const poSelect = statCols.map(c => `SUM(${sqlIdent(c)}) AS ${sqlIdent('PO_' + c)}`).join(', ');

  db.exec(`
    CREATE TABLE reg_season_agg AS
    SELECT "Player_ID", "Year", ${regSelect}
    FROM player_season
    WHERE "Week" BETWEEN 1 AND 17
    GROUP BY "Player_ID", "Year"
  `);
  db.exec(`CREATE INDEX idx_rsa_pid_year ON reg_season_agg("Player_ID","Year")`);

  db.exec(`
    CREATE TABLE playoff_agg AS
    SELECT "Player_ID", "Year", ${poSelect}
    FROM player_season
    WHERE "Week" BETWEEN 18 AND 21
    GROUP BY "Player_ID", "Year"
  `);
  db.exec(`CREATE INDEX idx_poa_pid_year ON playoff_agg("Player_ID","Year")`);

  db.exec(`
    CREATE TABLE team_for_year AS
    SELECT "Player_ID", "Year", "Team"
    FROM (
      SELECT "Player_ID", "Year", "Team",
             ROW_NUMBER() OVER (
               PARTITION BY "Player_ID", "Year"
               ORDER BY SUM("Games_Played") DESC, COUNT(*) DESC
             ) AS rn
      FROM player_season
      WHERE "Team" != 99
      GROUP BY "Player_ID", "Year", "Team"
    )
    WHERE rn = 1
  `);
  db.exec(`CREATE INDEX idx_tfy_pid_year ON team_for_year("Player_ID","Year")`);

  const skipRatings = new Set(['Record_Number', 'Year', 'Player_ID', 'Scouting']);
  const ratingCols = ratingsCols.filter(c => !skipRatings.has(c));
  const ratingSelect = ratingCols.map(c => `${sqlIdent(c)}`).join(', ');

  db.exec(`
    CREATE TABLE ratings_final AS
    SELECT "Player_ID", "Year", ${ratingSelect}
    FROM player_ratings_season
    WHERE "Scouting" = 'Exhibition'
  `);
  db.exec(`CREATE INDEX idx_rf_pid_year ON ratings_final("Player_ID","Year")`);

  const regOut = statCols.map(c => `r.${sqlIdent(c)} AS ${sqlIdent(c)}`).join(', ');
  const poOut = statCols.map(c => `p.${sqlIdent('PO_' + c)} AS ${sqlIdent('PO_' + c)}`).join(', ');
  const ratingOut = ratingCols.map(c => `g.${sqlIdent(c)} AS ${sqlIdent(c)}`).join(', ');

  db.exec(`
    CREATE TABLE player_year_summary AS
    SELECT
      base."Player_ID" AS Player_ID,
      base."Year" AS Year,
      pi."Last_Name" AS Last_Name,
      pi."First_Name" AS First_Name,
      pi."Position" AS Position,
      t."Team" AS Team,
      ${regOut},
      ${poOut},
      ${ratingOut}
    FROM (
      SELECT "Player_ID", "Year" FROM reg_season_agg
      UNION
      SELECT "Player_ID", "Year" FROM ratings_final
    ) base
    LEFT JOIN reg_season_agg r ON r."Player_ID" = base."Player_ID" AND r."Year" = base."Year"
    LEFT JOIN playoff_agg p ON p."Player_ID" = base."Player_ID" AND p."Year" = base."Year"
    LEFT JOIN team_for_year t ON t."Player_ID" = base."Player_ID" AND t."Year" = base."Year"
    LEFT JOIN ratings_final g ON g."Player_ID" = base."Player_ID" AND g."Year" = base."Year"
    LEFT JOIN player_information pi ON pi."Player_ID" = base."Player_ID"
  `);
  db.exec('CREATE INDEX idx_pys_pid_year ON player_year_summary("Player_ID","Year")');
  db.exec('CREATE INDEX idx_pys_year_team ON player_year_summary("Year","Team")');
  db.exec('CREATE INDEX idx_pys_position ON player_year_summary("Position")');

  db.exec('DROP TABLE reg_season_agg');
  db.exec('DROP TABLE playoff_agg');
  db.exec('DROP TABLE team_for_year');
  db.exec('DROP TABLE ratings_final');
}

main();
