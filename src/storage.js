import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { ensureDir } from './utils.js';

const LOCAL_UPLOAD_DIR = './public/uploads/testimonials';
const LOCAL_PUBLIC_PATH = '/uploads/testimonials';

let r2Client = null;
let r2ClientKey = '';

export function getStorageSettings(config = {}) {
  const r2Config = config.r2 || {};
  const provider = String(process.env.STORAGE_PROVIDER || config.storageProvider || 'local').toLowerCase();

  return {
    provider,
    r2: {
      accountId: String(process.env.R2_ACCOUNT_ID || r2Config.accountId || '').trim(),
      accessKeyId: String(process.env.R2_ACCESS_KEY_ID || r2Config.accessKeyId || '').trim(),
      secretAccessKey: String(process.env.R2_SECRET_ACCESS_KEY || r2Config.secretAccessKey || '').trim(),
      bucket: String(process.env.R2_BUCKET || r2Config.bucket || '').trim(),
      publicBaseUrl: String(process.env.R2_PUBLIC_BASE_URL || r2Config.publicBaseUrl || '').trim().replace(/\/$/, ''),
      uploadPrefix: String(process.env.R2_UPLOAD_PREFIX || r2Config.uploadPrefix || 'testimonials').trim().replace(/^\/+|\/+$/g, '')
    }
  };
}

export function validateStorageSettings(config = {}) {
  const settings = getStorageSettings(config);
  if (settings.provider !== 'r2') {
    return { ok: true, provider: settings.provider, warnings: [] };
  }

  const missing = [];
  if (!settings.r2.accountId) missing.push('R2_ACCOUNT_ID');
  if (!settings.r2.accessKeyId) missing.push('R2_ACCESS_KEY_ID');
  if (!settings.r2.secretAccessKey) missing.push('R2_SECRET_ACCESS_KEY');
  if (!settings.r2.bucket) missing.push('R2_BUCKET');
  if (!settings.r2.publicBaseUrl) missing.push('R2_PUBLIC_BASE_URL');

  return {
    ok: missing.length === 0,
    provider: settings.provider,
    missing,
    warnings: missing.length ? [`Konfigurasi R2 belum lengkap: ${missing.join(', ')}`] : []
  };
}

export async function saveTestimonialMedia({ buffer, username, mediaKind, mimetype, extension, config }) {
  const settings = getStorageSettings(config);

  if (settings.provider === 'r2') {
    return uploadToR2({ buffer, username, mediaKind, mimetype, extension, settings });
  }

  return saveToLocal({ buffer, username, mimetype, extension });
}

async function uploadToR2({ buffer, username, mediaKind, mimetype, extension, settings }) {
  const missing = validateStorageSettings({ storageProvider: 'r2', r2: settings.r2 }).missing || [];
  if (missing.length) {
    throw new Error(`Konfigurasi R2 belum lengkap: ${missing.join(', ')}`);
  }

  const client = getR2Client(settings.r2);
  const key = buildObjectKey({
    prefix: settings.r2.uploadPrefix,
    username,
    extension,
    mediaKind
  });

  await client.send(new PutObjectCommand({
    Bucket: settings.r2.bucket,
    Key: key,
    Body: buffer,
    ContentType: mimetype || fallbackContentType(mediaKind, extension),
    ContentLength: buffer.length,
    CacheControl: 'public, max-age=31536000, immutable',
    Metadata: {
      app: 'poko-member-bot',
      username: sanitizeMeta(username),
      kind: sanitizeMeta(mediaKind)
    }
  }));

  return {
    provider: 'r2',
    key,
    url: `${settings.r2.publicBaseUrl}/${encodeObjectKey(key)}`,
    sizeBytes: buffer.length,
    mimetype: mimetype || fallbackContentType(mediaKind, extension)
  };
}

async function saveToLocal({ buffer, username, mimetype, extension }) {
  ensureDir(LOCAL_UPLOAD_DIR);
  const filename = `${safePathPart(username)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${extension || 'jpg'}`;
  const filePath = path.join(LOCAL_UPLOAD_DIR, filename);
  await fs.writeFile(filePath, buffer);

  return {
    provider: 'local',
    key: filename,
    url: `${LOCAL_PUBLIC_PATH}/${filename}`,
    sizeBytes: buffer.length,
    mimetype
  };
}

function getR2Client(r2) {
  const cacheKey = `${r2.accountId}:${r2.accessKeyId}`;
  if (r2Client && r2ClientKey === cacheKey) return r2Client;

  r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey
    }
  });
  r2ClientKey = cacheKey;
  return r2Client;
}

function buildObjectKey({ prefix, username, extension, mediaKind }) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const safeUsername = safePathPart(username || 'member');
  const safeKind = safePathPart(mediaKind || 'media');
  const ext = safePathPart(extension || 'bin').replace(/^\.+/, '') || 'bin';
  const random = crypto.randomBytes(8).toString('hex');
  const basePrefix = prefix ? `${prefix}/` : '';
  return `${basePrefix}${yyyy}/${mm}/${safeUsername}/${Date.now()}-${safeKind}-${random}.${ext}`;
}

function encodeObjectKey(key = '') {
  return String(key).split('/').map((part) => encodeURIComponent(part)).join('/');
}

function safePathPart(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80) || 'file';
}

function sanitizeMeta(value = '') {
  return String(value || '').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64) || '-';
}

function fallbackContentType(mediaKind = '', extension = '') {
  const ext = String(extension || '').toLowerCase();
  if (mediaKind === 'video') {
    if (ext === 'webm') return 'video/webm';
    if (ext === 'mov') return 'video/quicktime';
    return 'video/mp4';
  }
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/jpeg';
}
