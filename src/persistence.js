import pg from 'pg';
import { readJson, writeJson } from './utils.js';
import { normalizeDb } from './db.js';

const { Pool } = pg;

const DEFAULT_DB = {
  members: {},
  usernameIndex: {},
  testimonials: [],
  vouchers: {},
  redemptions: []
};

let pool = null;
let lastPoolUrl = '';
let saveQueue = Promise.resolve();
let saveTimer = null;
let pendingSnapshot = null;

export function getDbSettings(config = {}) {
  const provider = String(process.env.DB_PROVIDER || config.database?.provider || config.dbProvider || 'local').toLowerCase();
  const databaseUrl = String(process.env.DATABASE_URL || config.database?.url || '').trim();
  const stateKey = String(process.env.DB_STATE_KEY || config.database?.stateKey || 'main').trim() || 'main';
  const saveDebounceMs = Math.max(250, Number(process.env.DB_SAVE_DEBOUNCE_MS || config.database?.saveDebounceMs || 1500));

  return {
    provider,
    databaseUrl,
    stateKey,
    saveDebounceMs
  };
}

export function validateDbSettings(config = {}) {
  const settings = getDbSettings(config);
  if (settings.provider !== 'neon') {
    return { ok: true, provider: settings.provider, warnings: [] };
  }

  const missing = [];
  if (!settings.databaseUrl) missing.push('DATABASE_URL');

  return {
    ok: missing.length === 0,
    provider: settings.provider,
    missing,
    warnings: missing.length ? [`Konfigurasi Neon belum lengkap: ${missing.join(', ')}`] : []
  };
}

export async function loadDatabase(config = {}, file = './database/database.json') {
  const settings = getDbSettings(config);
  if (settings.provider === 'neon') {
    return loadDbFromNeon(settings, file);
  }

  return normalizeDb(readJson(file, DEFAULT_DB));
}

export async function saveDatabase(config = {}, db = DEFAULT_DB, file = './database/database.json', { immediate = false } = {}) {
  const settings = getDbSettings(config);
  if (settings.provider === 'neon') {
    return saveDbToNeon(settings, db, { immediate });
  }

  writeJson(file, normalizeDb(db));
  return { ok: true, provider: 'local' };
}

export async function closeDatabase(config = {}) {
  clearTimeout(saveTimer);
  saveTimer = null;

  const settings = getDbSettings(config);
  if (settings.provider === 'neon' && pendingSnapshot) {
    await saveDbToNeon(settings, pendingSnapshot, { immediate: true });
  }

  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
    lastPoolUrl = '';
  }
}

async function loadDbFromNeon(settings, file) {
  if (!settings.databaseUrl) {
    throw new Error('DATABASE_URL belum diisi. Isi connection string Neon di .env atau Render Environment Variables.');
  }

  const client = getPool(settings);
  await ensureSchema(client);

  const result = await client.query(
    'SELECT data FROM app_state WHERE id = $1 LIMIT 1',
    [settings.stateKey]
  );

  if (result.rows[0]?.data) {
    return normalizeDb(result.rows[0].data);
  }

  const initial = normalizeDb(readJson(file, DEFAULT_DB));
  await upsertState(client, settings.stateKey, initial);
  return initial;
}

async function saveDbToNeon(settings, db, { immediate = false } = {}) {
  if (!settings.databaseUrl) {
    throw new Error('DATABASE_URL belum diisi. Database Neon tidak bisa disimpan.');
  }

  const snapshot = normalizeDb(structuredCloneSafe(db));
  pendingSnapshot = snapshot;

  if (!immediate) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveQueue = saveQueue
        .then(() => flushNeonSave(settings))
        .catch((error) => {
          console.error('[database save error]', error.message);
        });
    }, settings.saveDebounceMs);
    return { ok: true, provider: 'neon', scheduled: true };
  }

  clearTimeout(saveTimer);
  saveTimer = null;
  saveQueue = saveQueue.then(() => flushNeonSave(settings));
  return saveQueue;
}

async function flushNeonSave(settings) {
  if (!pendingSnapshot) return { ok: true, provider: 'neon', skipped: true };
  const snapshot = pendingSnapshot;
  pendingSnapshot = null;

  const client = getPool(settings);
  await ensureSchema(client);
  await upsertState(client, settings.stateKey, snapshot);
  return { ok: true, provider: 'neon' };
}

function getPool(settings) {
  if (pool && lastPoolUrl === settings.databaseUrl) return pool;

  if (pool) {
    pool.end().catch(() => {});
  }

  pool = new Pool({
    connectionString: settings.databaseUrl,
    ssl: {
      require: true
    },
    max: Number(process.env.DB_POOL_MAX || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000
  });
  lastPoolUrl = settings.databaseUrl;
  return pool;
}

async function ensureSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function upsertState(client, stateKey, data) {
  await client.query(
    `INSERT INTO app_state (id, data, updated_at)
     VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (id)
     DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [stateKey, JSON.stringify(data)]
  );
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
