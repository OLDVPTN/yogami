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

const SCHEMA_VERSION = 2;

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

  const db = await readRelationalState(client, settings.stateKey);
  if (db) return normalizeDb(db);

  const legacyState = await readLegacyAppState(client, settings.stateKey);
  if (legacyState) {
    const migrated = normalizeDb(legacyState);
    await writeRelationalState(client, settings.stateKey, migrated);
    await markMeta(client, settings.stateKey, { migratedFrom: 'app_state' });
    console.log('[database] Data lama dari app_state berhasil dimigrasikan ke tabel relational.');
    return migrated;
  }

  const initial = normalizeDb(readJson(file, DEFAULT_DB));
  await writeRelationalState(client, settings.stateKey, initial);
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
    return { ok: true, provider: 'neon', schema: 'relational', scheduled: true };
  }

  clearTimeout(saveTimer);
  saveTimer = null;
  saveQueue = saveQueue.then(() => flushNeonSave(settings));
  return saveQueue;
}

async function flushNeonSave(settings) {
  if (!pendingSnapshot) return { ok: true, provider: 'neon', schema: 'relational', skipped: true };
  const snapshot = pendingSnapshot;
  pendingSnapshot = null;

  const client = getPool(settings);
  await ensureSchema(client);
  await writeRelationalState(client, settings.stateKey, snapshot);
  return { ok: true, provider: 'neon', schema: 'relational' };
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
  // Tabel legacy tetap dibuat supaya migrasi otomatis dari app_state lama tetap aman.
  await client.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS member_bot_meta (
      state_key TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL DEFAULT ${SCHEMA_VERSION},
      migrated_from TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS member_bot_members (
      state_key TEXT NOT NULL,
      jid TEXT NOT NULL,
      username TEXT,
      name TEXT NOT NULL DEFAULT 'Member',
      registered BOOLEAN NOT NULL DEFAULT FALSE,
      registered_at BIGINT,
      account JSONB,
      profile JSONB NOT NULL DEFAULT '{}'::jsonb,
      level INTEGER NOT NULL DEFAULT 1,
      xp INTEGER NOT NULL DEFAULT 0,
      total_xp INTEGER NOT NULL DEFAULT 0,
      points INTEGER NOT NULL DEFAULT 0,
      streak INTEGER NOT NULL DEFAULT 0,
      last_checkin TEXT,
      last_message_reward_at BIGINT NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0,
      testimonial_count INTEGER NOT NULL DEFAULT 0,
      daily JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (state_key, jid)
    )
  `);

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS member_bot_members_username_uq
    ON member_bot_members (state_key, username)
    WHERE username IS NOT NULL AND username <> ''
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS member_bot_testimonials (
      state_key TEXT NOT NULL,
      id TEXT NOT NULL,
      jid TEXT NOT NULL,
      username TEXT NOT NULL,
      member_name TEXT NOT NULL DEFAULT 'Member',
      text TEXT NOT NULL DEFAULT '',
      keywords TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      media_type TEXT NOT NULL DEFAULT 'image',
      media_url TEXT NOT NULL DEFAULT '',
      storage_provider TEXT NOT NULL DEFAULT 'local',
      storage_key TEXT NOT NULL DEFAULT '',
      mimetype TEXT NOT NULL DEFAULT '',
      size_bytes BIGINT NOT NULL DEFAULT 0,
      views JSONB NOT NULL DEFAULT '{}'::jsonb,
      published BOOLEAN NOT NULL DEFAULT TRUE,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (state_key, id)
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS member_bot_testimonials_user_idx
    ON member_bot_testimonials (state_key, jid, created_at DESC)
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS member_bot_testimonials_keywords_idx
    ON member_bot_testimonials USING GIN (keywords)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS member_bot_vouchers (
      state_key TEXT NOT NULL,
      code TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 0,
      xp INTEGER NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 1,
      description TEXT NOT NULL DEFAULT '',
      claimed JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (state_key, code)
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS member_bot_redemptions (
      state_key TEXT NOT NULL,
      id TEXT NOT NULL,
      jid TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT 'Member',
      reward_id TEXT NOT NULL DEFAULT '',
      reward_name TEXT NOT NULL DEFAULT '',
      cost INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      PRIMARY KEY (state_key, id)
    )
  `);

  await markMeta(client, 'main', {}, { onlyIfMissing: true }).catch(() => {});
}

async function readRelationalState(client, stateKey) {
  const [membersResult, testimonialsResult, vouchersResult, redemptionsResult] = await Promise.all([
    client.query('SELECT * FROM member_bot_members WHERE state_key = $1 ORDER BY created_at ASC', [stateKey]),
    client.query('SELECT * FROM member_bot_testimonials WHERE state_key = $1 ORDER BY created_at DESC', [stateKey]),
    client.query('SELECT * FROM member_bot_vouchers WHERE state_key = $1 ORDER BY created_at DESC', [stateKey]),
    client.query('SELECT * FROM member_bot_redemptions WHERE state_key = $1 ORDER BY created_at DESC', [stateKey])
  ]);

  const hasAnyRows = membersResult.rowCount || testimonialsResult.rowCount || vouchersResult.rowCount || redemptionsResult.rowCount;
  if (!hasAnyRows) return null;

  const db = structuredCloneSafe(DEFAULT_DB);

  for (const row of membersResult.rows) {
    const member = rowToMember(row);
    db.members[member.jid] = member;
    if (member.account?.username) db.usernameIndex[member.account.username] = member.jid;
  }

  db.testimonials = testimonialsResult.rows.map(rowToTestimonial);

  for (const row of vouchersResult.rows) {
    const voucher = rowToVoucher(row);
    db.vouchers[voucher.code] = voucher;
  }

  db.redemptions = redemptionsResult.rows.map(rowToRedemption);

  return normalizeDb(db);
}

async function writeRelationalState(client, stateKey, inputDb) {
  const db = normalizeDb(structuredCloneSafe(inputDb));
  const now = Date.now();

  await client.query('BEGIN');
  try {
    await ensureSchema(client);

    await client.query('DELETE FROM member_bot_redemptions WHERE state_key = $1', [stateKey]);
    await client.query('DELETE FROM member_bot_vouchers WHERE state_key = $1', [stateKey]);
    await client.query('DELETE FROM member_bot_testimonials WHERE state_key = $1', [stateKey]);
    await client.query('DELETE FROM member_bot_members WHERE state_key = $1', [stateKey]);

    for (const member of Object.values(db.members || {})) {
      await client.query(
        `INSERT INTO member_bot_members (
          state_key, jid, username, name, registered, registered_at, account, profile,
          level, xp, total_xp, points, streak, last_checkin, last_message_reward_at,
          message_count, testimonial_count, daily, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb,
          $9, $10, $11, $12, $13, $14, $15,
          $16, $17, $18::jsonb, $19, $20
        )`,
        [
          stateKey,
          member.jid,
          member.account?.username || null,
          member.name || 'Member',
          Boolean(member.registered),
          nullableNumber(member.registeredAt),
          jsonParam(member.account),
          jsonParam(member.profile || {}),
          intParam(member.level, 1),
          intParam(member.xp, 0),
          intParam(member.totalXp, 0),
          intParam(member.points, 0),
          intParam(member.streak, 0),
          member.lastCheckin || null,
          numberParam(member.lastMessageRewardAt, 0),
          intParam(member.messageCount, 0),
          intParam(member.testimonialCount, 0),
          jsonParam(member.daily || {}),
          numberParam(member.createdAt, now),
          numberParam(member.updatedAt, now)
        ]
      );
    }

    for (const item of db.testimonials || []) {
      await client.query(
        `INSERT INTO member_bot_testimonials (
          state_key, id, jid, username, member_name, text, keywords, media_type,
          media_url, storage_provider, storage_key, mimetype, size_bytes, views,
          published, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7::text[], $8,
          $9, $10, $11, $12, $13, $14::jsonb,
          $15, $16, $17
        )`,
        [
          stateKey,
          item.id,
          item.jid,
          item.username,
          item.memberName || 'Member',
          item.text || '',
          Array.isArray(item.keywords) ? item.keywords : [],
          item.mediaType || 'image',
          item.mediaUrl || '',
          item.storageProvider || 'local',
          item.storageKey || '',
          item.mimetype || '',
          numberParam(item.sizeBytes, 0),
          jsonParam(item.views || {}),
          item.published !== false,
          numberParam(item.createdAt, now),
          numberParam(item.updatedAt, now)
        ]
      );
    }

    for (const voucher of Object.values(db.vouchers || {})) {
      await client.query(
        `INSERT INTO member_bot_vouchers (
          state_key, code, points, xp, stock, description, claimed, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [
          stateKey,
          String(voucher.code || '').toUpperCase(),
          intParam(voucher.points, 0),
          intParam(voucher.xp, 0),
          intParam(voucher.stock, 1),
          voucher.desc || voucher.description || 'Voucher member',
          jsonParam(Array.isArray(voucher.claimed) ? voucher.claimed : []),
          numberParam(voucher.createdAt, now)
        ]
      );
    }

    for (const redemption of db.redemptions || []) {
      await client.query(
        `INSERT INTO member_bot_redemptions (
          state_key, id, jid, name, reward_id, reward_name, cost, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          stateKey,
          redemption.id,
          redemption.jid,
          redemption.name || 'Member',
          redemption.rewardId || '',
          redemption.rewardName || '',
          intParam(redemption.cost, 0),
          redemption.status || 'pending',
          numberParam(redemption.createdAt, now),
          numberParam(redemption.updatedAt, now)
        ]
      );
    }

    await markMeta(client, stateKey, {});
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function readLegacyAppState(client, stateKey) {
  const result = await client.query(
    'SELECT data FROM app_state WHERE id = $1 LIMIT 1',
    [stateKey]
  ).catch(() => ({ rows: [] }));

  return result.rows[0]?.data || null;
}

async function markMeta(client, stateKey, meta = {}, options = {}) {
  const migratedFrom = meta.migratedFrom || null;
  if (options.onlyIfMissing) {
    await client.query(
      `INSERT INTO member_bot_meta (state_key, schema_version, migrated_from, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (state_key) DO NOTHING`,
      [stateKey, SCHEMA_VERSION, migratedFrom]
    );
    return;
  }

  await client.query(
    `INSERT INTO member_bot_meta (state_key, schema_version, migrated_from, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (state_key)
     DO UPDATE SET schema_version = EXCLUDED.schema_version,
                   migrated_from = COALESCE(member_bot_meta.migrated_from, EXCLUDED.migrated_from),
                   updated_at = NOW()`,
    [stateKey, SCHEMA_VERSION, migratedFrom]
  );
}

function rowToMember(row) {
  return {
    jid: row.jid,
    name: row.name || 'Member',
    registered: Boolean(row.registered),
    registeredAt: nullableNumber(row.registered_at),
    account: row.account || null,
    profile: row.profile || {},
    level: intParam(row.level, 1),
    xp: intParam(row.xp, 0),
    totalXp: intParam(row.total_xp, 0),
    points: intParam(row.points, 0),
    streak: intParam(row.streak, 0),
    lastCheckin: row.last_checkin || null,
    lastMessageRewardAt: numberParam(row.last_message_reward_at, 0),
    messageCount: intParam(row.message_count, 0),
    testimonialCount: intParam(row.testimonial_count, 0),
    daily: row.daily || {},
    createdAt: numberParam(row.created_at, Date.now()),
    updatedAt: numberParam(row.updated_at, Date.now())
  };
}

function rowToTestimonial(row) {
  return {
    id: row.id,
    jid: row.jid,
    username: row.username,
    memberName: row.member_name || 'Member',
    text: row.text || '',
    keywords: Array.isArray(row.keywords) ? row.keywords : [],
    mediaType: row.media_type || 'image',
    mediaUrl: row.media_url || '',
    storageProvider: row.storage_provider || 'local',
    storageKey: row.storage_key || '',
    mimetype: row.mimetype || '',
    sizeBytes: numberParam(row.size_bytes, 0),
    views: row.views || {},
    published: row.published !== false,
    createdAt: numberParam(row.created_at, Date.now()),
    updatedAt: numberParam(row.updated_at, Date.now())
  };
}

function rowToVoucher(row) {
  return {
    code: row.code,
    points: intParam(row.points, 0),
    xp: intParam(row.xp, 0),
    stock: intParam(row.stock, 1),
    desc: row.description || 'Voucher member',
    claimed: Array.isArray(row.claimed) ? row.claimed : [],
    createdAt: numberParam(row.created_at, Date.now())
  };
}

function rowToRedemption(row) {
  return {
    id: row.id,
    jid: row.jid,
    name: row.name || 'Member',
    rewardId: row.reward_id || '',
    rewardName: row.reward_name || '',
    cost: intParam(row.cost, 0),
    status: row.status || 'pending',
    createdAt: numberParam(row.created_at, Date.now()),
    updatedAt: numberParam(row.updated_at, Date.now())
  };
}

function jsonParam(value) {
  return JSON.stringify(value ?? null);
}

function intParam(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function numberParam(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function nullableNumber(value) {
  if (value === null || typeof value === 'undefined' || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function structuredCloneSafe(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}
