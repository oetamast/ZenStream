const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs-extra');
const { dataRoot } = require('../utils/storage');

const dbDir = path.join(dataRoot, 'db');
fs.ensureDirSync(dbDir);
const dbPath = path.join(dbDir, 'zenstream.sqlite');
const migrationsDir = path.join(__dirname, 'migrations');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error connecting to database:', err.message);
  }
});

db.exec('PRAGMA foreign_keys = ON;');
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) {
        return reject(err);
      }
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        return reject(err);
      }
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        return reject(err);
      }
      resolve(rows);
    });
  });
}

function exec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) {
        return reject(err);
      }
      resolve();
    });
  });
}

async function ensureMigrationsTable() {
  await run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
}

async function getAppliedMigrations() {
  await ensureMigrationsTable();
  const rows = await all('SELECT name FROM schema_migrations');
  return new Set(rows.map((row) => row.name));
}

async function applyMigration(name, sql) {
  await run('BEGIN');
  try {
    await exec(sql);
    await run('INSERT INTO schema_migrations (name) VALUES (?)', [name]);
    await run('COMMIT');
  } catch (err) {
    await run('ROLLBACK');
    throw err;
  }
}

async function runMigrations() {
  await ensureMigrationsTable();
  if (!fs.existsSync(migrationsDir)) {
    return;
  }

  const applied = await getAppliedMigrations();
  const files = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await applyMigration(file, sql);
    console.log(`Applied migration: ${file}`);
  }
}

async function getCurrentMigrationVersion() {
  await ensureMigrationsTable();
  const row = await get(
    'SELECT name FROM schema_migrations ORDER BY applied_at DESC, id DESC LIMIT 1'
  );
  return row ? row.name : null;
}

async function initializeDatabase() {
  await runMigrations();
  console.log(`Database initialized at ${dbPath}`);
}

async function checkIfUsersExist() {
  try {
    const result = await get('SELECT COUNT(*) as count FROM users');
    return result && result.count > 0;
  } catch (err) {
    return false;
  }
}

async function checkIfAdminExists() {
  try {
    const result = await get("SELECT COUNT(*) as count FROM users WHERE LOWER(user_role) = 'admin'");
    return result && result.count > 0;
  } catch (err) {
    return false;
  }
}

module.exports = {
  db,
  dbPath,
  run,
  get,
  all,
  initializeDatabase,
  checkIfUsersExist,
  checkIfAdminExists,
  getCurrentMigrationVersion,
};

if (require.main === module) {
  initializeDatabase()
    .then(() => {
      console.log('Migrations complete.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Failed to initialize database', err);
      process.exit(1);
    });
}
