import fs from 'fs';
import path from 'path';

export function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function readJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (error) {
    console.error(`[JSON] Gagal membaca ${file}:`, error.message);
    return fallback;
  }
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export function loadConfig(file = './config.json') {
  const config = readJson(file, {});
  return {
    botName: config.botName || 'Member Bot',
    ownerNumber: normalizeNumber(config.ownerNumber || process.env.OWNER_NUMBER || ''),
    botNumber: normalizeNumber(config.botNumber || process.env.BOT_NUMBER || ''),
    prefix: config.prefix || '.',
    timezone: config.timezone || 'Asia/Jakarta',
    groupOnly: false,
    autoRead: Boolean(config.autoRead),
    publicBaseUrl: String(process.env.PUBLIC_BASE_URL || config.publicBaseUrl || `http://localhost:${process.env.PORT || 10000}`).replace(/\/$/, ''),
    webTitle: config.webTitle || 'Testimoni Member',
    meta: {
      graphApiVersion: String(process.env.GRAPH_API_VERSION || config.meta?.graphApiVersion || 'v25.0').replace(/^\/+/, ''),
      accessToken: String(process.env.WHATSAPP_ACCESS_TOKEN || config.meta?.accessToken || '').trim(),
      phoneNumberId: String(process.env.WHATSAPP_PHONE_NUMBER_ID || config.meta?.phoneNumberId || '').trim(),
      businessAccountId: String(process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || config.meta?.businessAccountId || '').trim(),
      verifyToken: String(process.env.WHATSAPP_VERIFY_TOKEN || config.meta?.verifyToken || '').trim(),
      appSecret: String(process.env.META_APP_SECRET || config.meta?.appSecret || '').trim(),
      webhookPath: normalizePath(process.env.WHATSAPP_WEBHOOK_PATH || config.meta?.webhookPath || '/webhook')
    },
    storageProvider: String(process.env.STORAGE_PROVIDER || config.storageProvider || 'local').toLowerCase(),
    dbProvider: String(process.env.DB_PROVIDER || config.database?.provider || config.dbProvider || 'local').toLowerCase(),
    database: {
      provider: String(process.env.DB_PROVIDER || config.database?.provider || config.dbProvider || 'local').toLowerCase(),
      url: String(process.env.DATABASE_URL || config.database?.url || '').trim(),
      stateKey: String(process.env.DB_STATE_KEY || config.database?.stateKey || 'main').trim() || 'main',
      saveDebounceMs: Number(process.env.DB_SAVE_DEBOUNCE_MS || config.database?.saveDebounceMs || 1500)
    },
    r2: {
      accountId: String(process.env.R2_ACCOUNT_ID || config.r2?.accountId || '').trim(),
      accessKeyId: String(process.env.R2_ACCESS_KEY_ID || config.r2?.accessKeyId || '').trim(),
      secretAccessKey: String(process.env.R2_SECRET_ACCESS_KEY || config.r2?.secretAccessKey || '').trim(),
      bucket: String(process.env.R2_BUCKET || config.r2?.bucket || '').trim(),
      publicBaseUrl: String(process.env.R2_PUBLIC_BASE_URL || config.r2?.publicBaseUrl || '').trim().replace(/\/$/, ''),
      uploadPrefix: String(process.env.R2_UPLOAD_PREFIX || config.r2?.uploadPrefix || 'testimonials').trim()
    },
    maxMediaMb: Number(config.maxMediaMb ?? 30),
    testimonialPointReward: Number(config.testimonialPointReward ?? 10),
    testimonialXpReward: Number(config.testimonialXpReward ?? 30),
    xpPerMessage: Number(config.xpPerMessage ?? 5),
    pointPerMessage: Number(config.pointPerMessage ?? 1),
    messageCooldownSeconds: Number(config.messageCooldownSeconds ?? 60),
    dailyChatCap: Number(config.dailyChatCap ?? 100),
    checkinReward: Number(config.checkinReward ?? 50),
    checkinXp: Number(config.checkinXp ?? 100),
    dailyChatQuestTarget: Number(config.dailyChatQuestTarget ?? 10),
    dailyChatQuestPoint: Number(config.dailyChatQuestPoint ?? 25),
    dailyChatQuestXp: Number(config.dailyChatQuestXp ?? 30),
    levelBaseXp: Number(config.levelBaseXp ?? 120)
  };
}


export function normalizePairingCode(input = '') {
  const value = String(input || '').trim();
  if (!value) return '';

  const clean = value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  if (!clean || ['AUTO', 'RANDOM', 'SERVER', 'WHATSAPP'].includes(clean)) return '';

  return clean.slice(0, 8);
}


export function normalizePath(input = '') {
  const clean = String(input || '').trim() || '/webhook';
  return clean.startsWith('/') ? clean : `/${clean}`;
}

export function normalizeNumber(input = '') {
  let number = String(input).replace(/[^0-9]/g, '');
  if (number.startsWith('0')) number = '62' + number.slice(1);
  return number;
}

export function toJid(input = '') {
  const value = String(input).trim();
  if (value.includes('@')) return value;
  const number = normalizeNumber(value);
  return number ? `${number}@s.whatsapp.net` : '';
}

export function jidToNumber(jid = '') {
  return String(jid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

export function sameUser(a = '', b = '') {
  const x = jidToNumber(a);
  const y = jidToNumber(b);
  return Boolean(x && y && x === y);
}

export function mentionTag(jid = '') {
  return `@${jidToNumber(jid)}`;
}

export function parseMentions(text = '') {
  const matches = [...String(text).matchAll(/@([0-9]{5,20})/g)];
  return [...new Set(matches.map((match) => `${match[1]}@s.whatsapp.net`))];
}

export function unwrapMessage(message = {}) {
  let content = message;
  for (let i = 0; i < 6; i++) {
    if (content?.ephemeralMessage?.message) content = content.ephemeralMessage.message;
    else if (content?.viewOnceMessage?.message) content = content.viewOnceMessage.message;
    else if (content?.viewOnceMessageV2?.message) content = content.viewOnceMessageV2.message;
    else if (content?.documentWithCaptionMessage?.message) content = content.documentWithCaptionMessage.message;
    else break;
  }
  return content || {};
}

export function getMessageType(message = {}) {
  const content = unwrapMessage(message);
  return Object.keys(content || {})[0] || 'unknown';
}

export function getBody(message = {}) {
  const content = unwrapMessage(message);
  const type = getMessageType(content);

  if (content.conversation) return content.conversation;
  if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
  if (content.imageMessage?.caption) return content.imageMessage.caption;
  if (content.videoMessage?.caption) return content.videoMessage.caption;
  if (content.documentMessage?.caption) return content.documentMessage.caption;
  if (content.buttonsResponseMessage?.selectedButtonId) return content.buttonsResponseMessage.selectedButtonId;
  if (content.listResponseMessage?.singleSelectReply?.selectedRowId) return content.listResponseMessage.singleSelectReply.selectedRowId;
  if (content.templateButtonReplyMessage?.selectedId) return content.templateButtonReplyMessage.selectedId;
  if (content.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson) {
    try {
      const params = JSON.parse(content.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson);
      return params.id || params.display_text || '';
    } catch {
      return '';
    }
  }

  if (type === 'reactionMessage') return '';
  return '';
}

export function getMessageContext(message = {}) {
  const content = unwrapMessage(message);
  return (
    content.extendedTextMessage?.contextInfo ||
    content.imageMessage?.contextInfo ||
    content.videoMessage?.contextInfo ||
    content.documentMessage?.contextInfo ||
    content.audioMessage?.contextInfo ||
    content.stickerMessage?.contextInfo ||
    {}
  );
}

export function getTodayKey(timezone = 'Asia/Jakarta') {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(new Date());
}

export function diffDays(dateA, dateB) {
  if (!dateA || !dateB) return null;
  const parse = (value) => {
    const [year, month, day] = String(value).split('-').map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((parse(dateA) - parse(dateB)) / 86400000);
}

export function formatNumber(number = 0) {
  return new Intl.NumberFormat('id-ID').format(Number(number || 0));
}

export function clampText(text = '', max = 1800) {
  const clean = String(text || '').trim();
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

export function makeId(prefix = 'RDM') {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${rand}`;
}

export function slugifyUsername(input = '') {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/[._-]{2,}/g, '-')
    .slice(0, 24);
}

export function isValidUsername(username = '') {
  return /^[a-z0-9][a-z0-9._-]{2,23}$/.test(username) && !username.includes('..');
}

export function escapeHtml(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function normalizeSearchText(value = '') {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s#@._-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractPrimaryHashtag(text = '') {
  const words = normalizeSearchText(text)
    .split(' ')
    .map((word) => word.replace(/^#+/, '').trim())
    .filter(Boolean);

  // Caption lama sering ditulis seperti: .testimoni testimoni thalassemia ...
  // Supaya hashtag tidak menjadi #testimoni, lewati kata pembuka yang terlalu umum.
  const ignoredOpeningWords = new Set(['testimoni', 'testimonial', 'pengalaman']);
  const firstTitleWord = words.find((word) => word.length >= 2 && !ignoredOpeningWords.has(word));
  return firstTitleWord || '';
}

export function extractKeywords(text = '') {
  const primary = extractPrimaryHashtag(text);
  return primary ? [primary] : [];
}

export function getMediaExtension(mimetype = '', mediaKind = '') {
  const mime = String(mimetype || '').toLowerCase();
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('quicktime')) return 'mov';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4')) return 'mp4';
  if (mediaKind === 'video') return 'mp4';
  return 'jpg';
}

export function formatDateTime(timestamp, timezone = 'Asia/Jakarta') {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(timestamp || Date.now()));
}
