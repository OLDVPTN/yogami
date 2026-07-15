import crypto from 'crypto';
import {
  diffDays,
  extractKeywords,
  getTodayKey,
  makeId,
  normalizeSearchText,
  readJson,
  slugifyUsername,
  writeJson
} from './utils.js';

const DEFAULT_DB = {
  members: {},
  usernameIndex: {},
  testimonials: [],
  vouchers: {},
  redemptions: [],
  searchStats: {}
};

export function loadDb(file = './database/database.json') {
  const data = readJson(file, DEFAULT_DB);
  return normalizeDb(data);
}

export function saveDb(file = './database/database.json', db = DEFAULT_DB) {
  writeJson(file, normalizeDb(db));
}

export function normalizeDb(db = {}) {
  if (!db || typeof db !== 'object') db = {};
  if (!db.members || typeof db.members !== 'object') db.members = {};
  if (!db.usernameIndex || typeof db.usernameIndex !== 'object') db.usernameIndex = {};
  if (!Array.isArray(db.testimonials)) db.testimonials = [];
  if (!db.vouchers || typeof db.vouchers !== 'object') db.vouchers = {};
  if (!Array.isArray(db.redemptions)) db.redemptions = [];
  if (!db.searchStats || typeof db.searchStats !== 'object' || Array.isArray(db.searchStats)) db.searchStats = {};
  normalizeSearchStats(db.searchStats);

  // Perbaiki index username jika database lama belum punya usernameIndex.
  for (const [jid, member] of Object.entries(db.members)) {
    normalizeMember(member, jid);
    if (member.account?.username) {
      db.usernameIndex[member.account.username] = jid;
    }
  }

  db.testimonials = db.testimonials.map((item) => normalizeTestimonial(item)).filter(Boolean);
  return db;
}

export function createMember(jid, name = 'Member') {
  const now = Date.now();
  return normalizeMember({
    jid,
    name,
    registered: false,
    registeredAt: null,
    account: null,
    profile: {
      bio: '',
      avatar: '',
      published: true
    },
    level: 1,
    xp: 0,
    totalXp: 0,
    points: 0,
    streak: 0,
    lastCheckin: null,
    lastMessageRewardAt: 0,
    messageCount: 0,
    testimonialCount: 0,
    daily: {
      date: null,
      chatCount: 0,
      chatQuestClaimed: false,
      checkinClaimed: false
    },
    createdAt: now,
    updatedAt: now
  }, jid);
}

function normalizeMember(member, jid = '') {
  const now = Date.now();
  member.jid = member.jid || jid;
  member.name = member.name || 'Member';
  member.registered = Boolean(member.registered);
  member.registeredAt = member.registeredAt || null;
  member.account = member.account || null;
  member.profile = member.profile && typeof member.profile === 'object' ? member.profile : {};
  member.profile.bio = member.profile.bio || '';
  member.profile.avatar = member.profile.avatar || '';
  member.profile.published = member.profile.published !== false;
  member.profile.verified = Boolean(member.profile.verified);
  member.profile.verifiedAt = member.profile.verifiedAt || null;
  member.level = Number(member.level || 1);
  member.xp = Number(member.xp || 0);
  member.totalXp = Number(member.totalXp || 0);
  member.points = Number(member.points || 0);
  member.streak = Number(member.streak || 0);
  member.lastCheckin = member.lastCheckin || null;
  member.lastMessageRewardAt = Number(member.lastMessageRewardAt || 0);
  member.messageCount = Number(member.messageCount || 0);
  member.testimonialCount = Number(member.testimonialCount || 0);
  member.daily = member.daily && typeof member.daily === 'object' ? member.daily : {};
  member.daily.date = member.daily.date || null;
  member.daily.chatCount = Number(member.daily.chatCount || 0);
  member.daily.chatQuestClaimed = Boolean(member.daily.chatQuestClaimed);
  member.daily.checkinClaimed = Boolean(member.daily.checkinClaimed);
  member.createdAt = member.createdAt || now;
  member.updatedAt = member.updatedAt || now;
  return member;
}


function normalizeTestimonialViews(views = {}, legacyCount = 0) {
  const safeViews = views && typeof views === 'object' ? views : {};
  const viewers = safeViews.viewers && typeof safeViews.viewers === 'object' ? safeViews.viewers : {};
  return {
    count: Math.max(0, Number(safeViews.count ?? legacyCount ?? 0)),
    lastViewedAt: safeViews.lastViewedAt || null,
    viewers
  };
}


function normalizeSearchStats(searchStats = {}) {
  for (const [day, entries] of Object.entries(searchStats)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !entries || typeof entries !== 'object' || Array.isArray(entries)) {
      delete searchStats[day];
      continue;
    }

    for (const [key, item] of Object.entries(entries)) {
      if (!item || typeof item !== 'object') {
        delete entries[key];
        continue;
      }
      const normalizedKey = normalizeKeywordKey(item.keyword || item.query || key);
      if (!normalizedKey) {
        delete entries[key];
        continue;
      }
      if (normalizedKey !== key) {
        entries[normalizedKey] = item;
        delete entries[key];
      }
      entries[normalizedKey] = {
        keyword: normalizedKey,
        label: cleanSearchLabel(item.label || item.query || normalizedKey),
        count: Math.max(0, Number(item.count || 0)),
        firstSearchedAt: Number(item.firstSearchedAt || item.createdAt || Date.now()),
        lastSearchedAt: Number(item.lastSearchedAt || item.updatedAt || Date.now())
      };
    }
  }
  return searchStats;
}

function normalizeKeywordKey(value = '') {
  return normalizeSearchText(value)
    .replace(/^#+/, '')
    .split(' ')
    .filter(Boolean)
    .filter((word) => !['testimoni', 'testimonial', 'pengalaman', 'cari', 'search'].includes(word))
    .join(' ')
    .slice(0, 80);
}

function cleanSearchLabel(value = '') {
  const key = normalizeKeywordKey(value);
  return key || '';
}

function normalizeTestimonial(item = {}) {
  if (!item || typeof item !== 'object') return null;
  if (!item.id || !item.jid || !item.username || !item.mediaUrl) return null;
  return {
    id: item.id,
    jid: item.jid,
    username: item.username,
    memberName: item.memberName || 'Member',
    text: item.text || '',
    keywords: Array.isArray(item.keywords) && item.keywords.length ? item.keywords.slice(0, 1) : extractKeywords(item.text || ''),
    mediaType: item.mediaType || 'image',
    mediaUrl: item.mediaUrl,
    storageProvider: item.storageProvider || 'local',
    storageKey: item.storageKey || '',
    mimetype: item.mimetype || '',
    sizeBytes: Number(item.sizeBytes || 0),
    watermarked: Boolean(item.watermarked),
    watermarkMode: item.watermarkMode || '',
    verified: Boolean(item.verified),
    verifiedBy: item.verifiedBy || '',
    verifiedAt: item.verifiedAt || null,
    views: normalizeTestimonialViews(item.views, item.viewCount),
    published: item.published !== false,
    createdAt: item.createdAt || Date.now(),
    updatedAt: item.updatedAt || item.createdAt || Date.now()
  };
}

export function getMember(db, jid, name = 'Member') {
  normalizeDb(db);
  if (!db.members[jid]) db.members[jid] = createMember(jid, name);
  normalizeMember(db.members[jid], jid);
  if (name && (!db.members[jid].name || db.members[jid].name === 'Member')) {
    db.members[jid].name = name;
  }
  db.members[jid].updatedAt = Date.now();
  return db.members[jid];
}

export function registerMember(db, jid, name) {
  const member = getMember(db, jid, name);
  member.name = name || member.name || 'Member';
  if (!member.registered) {
    member.registered = true;
    member.registeredAt = Date.now();
  }
  member.updatedAt = Date.now();
  return member;
}

export function createOrUpdateAccount(db, jid, name, usernameInput, password) {
  normalizeDb(db);
  const username = slugifyUsername(usernameInput);
  const member = registerMember(db, jid, name || 'Member');

  if (!username || password.length < 6) {
    return { ok: false, reason: 'invalid_input', username, member };
  }

  const existingJid = db.usernameIndex[username];
  if (existingJid && existingJid !== jid) {
    return { ok: false, reason: 'username_taken', username, member };
  }

  if (member.account?.username && member.account.username !== username) {
    delete db.usernameIndex[member.account.username];
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = crypto.scryptSync(String(password), salt, 64).toString('hex');

  member.account = {
    username,
    passwordHash,
    salt,
    createdAt: member.account?.createdAt || Date.now(),
    updatedAt: Date.now()
  };
  member.profile.published = true;
  member.updatedAt = Date.now();
  db.usernameIndex[username] = jid;

  return { ok: true, username, member };
}

export function verifyPassword(member, password) {
  if (!member?.account?.passwordHash || !member?.account?.salt) return false;
  const hash = crypto.scryptSync(String(password), member.account.salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(member.account.passwordHash, 'hex'));
}

export function findMemberByUsername(db, usernameInput) {
  normalizeDb(db);
  const username = slugifyUsername(usernameInput);
  const jid = db.usernameIndex[username];
  return jid ? db.members[jid] || null : null;
}

export function getProfileUrl(config, username = '') {
  const base = String(config.publicBaseUrl || '').replace(/\/$/, '');
  return `${base}/@${username}`;
}

export function addTestimonial(db, member, payload = {}) {
  normalizeDb(db);
  if (!member?.account?.username) {
    return { ok: false, reason: 'no_account' };
  }

  const id = makeId('TST');
  const text = String(payload.text || '').trim().slice(0, 1000);
  const storageKey = payload.storageKey || '';
  const mediaUrl = payload.mediaUrl || (storageKey ? `/media/${id}` : '');
  const testimonial = normalizeTestimonial({
    id,
    jid: member.jid,
    username: member.account.username,
    memberName: member.name || member.account.username,
    text,
    // Hashtag/keyword publik hanya diambil dari judul/kata pertama testimoni.
    // Search tetap membaca isi text penuh lewat searchTestimonials().
    keywords: extractKeywords(text),
    mediaType: payload.mediaType || 'image',
    mediaUrl,
    storageProvider: payload.storageProvider || 'local',
    storageKey,
    mimetype: payload.mimetype || '',
    sizeBytes: payload.sizeBytes || 0,
    watermarked: Boolean(payload.watermarked),
    watermarkMode: payload.watermarkMode || '',
    verified: Boolean(payload.verified),
    verifiedBy: payload.verifiedBy || '',
    verifiedAt: payload.verifiedAt || null,
    published: true,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });

  if (!testimonial) return { ok: false, reason: 'invalid_payload' };
  db.testimonials.unshift(testimonial);
  member.testimonialCount = getTestimonialsByMember(db, member.jid).length;
  member.updatedAt = Date.now();
  return { ok: true, testimonial };
}

export function findTestimonialById(db, id) {
  normalizeDb(db);
  const normalizedId = String(id || '').trim();
  if (!normalizedId) return null;
  return db.testimonials.find((item) => item.id === normalizedId && item.published !== false) || null;
}


export function setTestimonialVerified(db, id, verifierJid = '', verified = true) {
  normalizeDb(db);
  const testimonial = db.testimonials.find((item) => item.id === String(id || '').trim() && item.published !== false);
  if (!testimonial) return { ok: false, reason: 'not_found' };

  const now = Date.now();
  testimonial.verified = Boolean(verified);
  testimonial.verifiedBy = verified ? verifierJid : '';
  testimonial.verifiedAt = verified ? now : null;
  testimonial.updatedAt = now;

  const member = db.members[testimonial.jid];
  if (member) {
    normalizeMember(member, testimonial.jid);
    const hasVerified = db.testimonials.some((item) => item.jid === testimonial.jid && item.published !== false && item.verified);
    member.profile.verified = hasVerified;
    member.profile.verifiedAt = hasVerified
      ? Math.max(...db.testimonials
        .filter((item) => item.jid === testimonial.jid && item.published !== false && item.verified)
        .map((item) => Number(item.verifiedAt || item.updatedAt || item.createdAt || 0)))
      : null;
    member.updatedAt = now;
  }

  return { ok: true, testimonial, verified: Boolean(verified) };
}

function sortPublicTestimonials(items = []) {
  return [...items].sort((a, b) => {
    if (Boolean(b.verified) !== Boolean(a.verified)) return Boolean(b.verified) - Boolean(a.verified);
    return Number(b.createdAt || 0) - Number(a.createdAt || 0);
  });
}

export function recordTestimonialView(db, id, viewerKey = '') {
  const testimonial = findTestimonialById(db, id);
  if (!testimonial) return { ok: false, reason: 'not_found' };

  if (!testimonial.views || typeof testimonial.views !== 'object') {
    testimonial.views = normalizeTestimonialViews(testimonial.views, testimonial.viewCount);
  }

  const key = String(viewerKey || '').trim();
  const now = Date.now();
  const alreadySeen = key && testimonial.views.viewers?.[key];

  if (!alreadySeen) {
    testimonial.views.count = Math.max(0, Number(testimonial.views.count || 0)) + 1;
    testimonial.views.lastViewedAt = now;
    if (key) {
      testimonial.views.viewers[key] = now;
      pruneViewers(testimonial.views.viewers, 10000);
    }
    testimonial.updatedAt = now;
    return { ok: true, counted: true, count: testimonial.views.count, testimonial };
  }

  return { ok: true, counted: false, count: testimonial.views.count, testimonial };
}

function pruneViewers(viewers = {}, limit = 10000) {
  const entries = Object.entries(viewers);
  if (entries.length <= limit) return;
  entries
    .sort((a, b) => Number(a[1] || 0) - Number(b[1] || 0))
    .slice(0, entries.length - limit)
    .forEach(([key]) => delete viewers[key]);
}


export function recordSearchQuery(db, query = '', config = {}, meta = {}) {
  normalizeDb(db);
  const keyword = normalizeKeywordKey(query);
  if (!keyword || keyword.length < 2) return { ok: false, reason: 'empty' };

  const day = meta.day || getTodayKey(config.timezone || 'Asia/Jakarta');
  if (!db.searchStats[day]) db.searchStats[day] = {};
  const now = Date.now();
  const current = db.searchStats[day][keyword] || {
    keyword,
    label: cleanSearchLabel(query) || keyword,
    count: 0,
    firstSearchedAt: now,
    lastSearchedAt: now
  };

  current.count = Math.max(0, Number(current.count || 0)) + 1;
  current.label = cleanSearchLabel(query) || current.label || keyword;
  current.lastSearchedAt = now;
  db.searchStats[day][keyword] = current;
  pruneSearchStats(db.searchStats);

  return { ok: true, day, keyword, item: current };
}

export function topSearchKeywords(db, config = {}, { day, limit = 5 } = {}) {
  normalizeDb(db);
  const targetDay = day || getTodayKey(config.timezone || 'Asia/Jakarta');
  const entries = Object.values(db.searchStats?.[targetDay] || {});
  return entries
    .filter((item) => item && Number(item.count || 0) > 0)
    .sort((a, b) => {
      if (Number(b.count || 0) !== Number(a.count || 0)) return Number(b.count || 0) - Number(a.count || 0);
      return Number(b.lastSearchedAt || 0) - Number(a.lastSearchedAt || 0);
    })
    .slice(0, Math.max(1, Number(limit || 5)));
}

export function topSearchKeywordToday(db, config = {}) {
  return topSearchKeywords(db, config, { limit: 1 })[0] || null;
}

function pruneSearchStats(searchStats = {}, keepDays = 30) {
  const days = Object.keys(searchStats).sort();
  while (days.length > keepDays) {
    const day = days.shift();
    delete searchStats[day];
  }
}

export function getTestimonialsByMember(db, jid, { includeHidden = false } = {}) {
  normalizeDb(db);
  return sortPublicTestimonials(
    db.testimonials.filter((item) => item.jid === jid && (includeHidden || item.published))
  );
}

export function getPublicTestimonialsByUsername(db, username) {
  const member = findMemberByUsername(db, username);
  if (!member || member.profile?.published === false) return null;
  return {
    member,
    testimonials: getTestimonialsByMember(db, member.jid)
  };
}

export function searchTestimonials(db, query = '', limit = 30) {
  normalizeDb(db);
  const normalizedQuery = normalizeSearchText(query);
  const terms = normalizedQuery.split(' ').filter(Boolean);

  const visible = sortPublicTestimonials(db.testimonials.filter((item) => item.published));
  const matched = !terms.length
    ? visible.slice(0, limit)
    : visible.filter((item) => {
      const haystack = normalizeSearchText([
        item.username,
        item.memberName,
        item.text,
        ...(item.keywords || [])
      ].join(' '));
      return terms.every((term) => haystack.includes(term));
    });

  const grouped = new Map();
  for (const item of matched) {
    const member = findMemberByUsername(db, item.username);
    if (!member || member.profile?.published === false) continue;

    const current = grouped.get(item.username) || {
      username: item.username,
      name: member.name || item.memberName,
      jid: item.jid,
      totalTestimonials: getTestimonialsByMember(db, item.jid).length,
      matchedTestimonials: 0,
      latestAt: 0,
      samples: [],
      verified: Boolean(member.profile?.verified)
    };

    current.matchedTestimonials += 1;
    current.latestAt = Math.max(current.latestAt, item.createdAt || 0);
    if (current.samples.length < 3) current.samples.push(item);
    grouped.set(item.username, current);
  }

  return [...grouped.values()]
    .sort((a, b) => {
      if (b.matchedTestimonials !== a.matchedTestimonials) return b.matchedTestimonials - a.matchedTestimonials;
      return b.latestAt - a.latestAt;
    })
    .slice(0, limit);
}

export function latestTestimonials(db, limit = 12) {
  normalizeDb(db);
  return sortPublicTestimonials(db.testimonials.filter((item) => item.published)).slice(0, limit);
}

export function resetDailyIfNeeded(member, config) {
  const today = getTodayKey(config.timezone);
  if (member.daily?.date !== today) {
    member.daily = {
      date: today,
      chatCount: 0,
      chatQuestClaimed: false,
      checkinClaimed: member.lastCheckin === today
    };
  }
  return member.daily;
}

export function neededXp(level, config) {
  const base = Number(config.levelBaseXp || 120);
  const current = Math.max(1, Number(level || 1));
  return base * current * current;
}

export function addXp(member, amount, config) {
  const gain = Math.max(0, Math.floor(Number(amount || 0)));
  if (!gain) return { gained: 0, levelUp: 0, currentLevel: member.level, nextNeed: neededXp(member.level, config) };

  let levelUp = 0;
  member.xp += gain;
  member.totalXp += gain;

  while (member.xp >= neededXp(member.level, config)) {
    member.xp -= neededXp(member.level, config);
    member.level += 1;
    levelUp += 1;
  }

  member.updatedAt = Date.now();
  return {
    gained: gain,
    levelUp,
    currentLevel: member.level,
    nextNeed: neededXp(member.level, config)
  };
}

export function addPoints(member, amount) {
  const gain = Math.floor(Number(amount || 0));
  member.points = Math.max(0, Number(member.points || 0) + gain);
  member.updatedAt = Date.now();
  return member.points;
}

export function passiveMessageReward(db, jid, name, config) {
  const member = getMember(db, jid, name);
  if (!member.registered) return { ignored: true, reason: 'not_registered' };

  const daily = resetDailyIfNeeded(member, config);
  member.messageCount += 1;

  const now = Date.now();
  const cooldown = Math.max(5, Number(config.messageCooldownSeconds || 60)) * 1000;
  const hitDailyCap = daily.chatCount >= Number(config.dailyChatCap || 100);
  const inCooldown = now - Number(member.lastMessageRewardAt || 0) < cooldown;

  if (!hitDailyCap && !inCooldown) {
    daily.chatCount += 1;
    member.lastMessageRewardAt = now;
    addPoints(member, Number(config.pointPerMessage || 1));
    const xpResult = addXp(member, Number(config.xpPerMessage || 5), config);

    const questResult = maybeCompleteChatQuest(member, config);
    return { ignored: false, rewarded: true, xpResult, questResult, member };
  }

  return { ignored: false, rewarded: false, reason: hitDailyCap ? 'daily_cap' : 'cooldown', member };
}

export function maybeCompleteChatQuest(member, config) {
  const daily = resetDailyIfNeeded(member, config);
  const target = Number(config.dailyChatQuestTarget || 10);
  if (!daily.chatQuestClaimed && daily.chatCount >= target) {
    daily.chatQuestClaimed = true;
    const bonusPoint = Number(config.dailyChatQuestPoint || 25);
    const bonusXp = Number(config.dailyChatQuestXp || 30);
    addPoints(member, bonusPoint);
    const xpResult = addXp(member, bonusXp, config);
    return { completed: true, bonusPoint, bonusXp, xpResult };
  }
  return { completed: false };
}

export function checkinMember(db, jid, name, config) {
  const member = getMember(db, jid, name);
  if (!member.registered) return { ok: false, reason: 'not_registered', member };

  const today = getTodayKey(config.timezone);
  resetDailyIfNeeded(member, config);

  if (member.lastCheckin === today) {
    return { ok: false, reason: 'already_checkin', member };
  }

  const gap = diffDays(today, member.lastCheckin);
  member.streak = gap === 1 ? Number(member.streak || 0) + 1 : 1;
  member.lastCheckin = today;
  member.daily.checkinClaimed = true;

  const streakBonus = Math.min(50, Math.max(0, member.streak - 1) * 5);
  const pointGain = Number(config.checkinReward || 50) + streakBonus;
  const xpGain = Number(config.checkinXp || 100);

  addPoints(member, pointGain);
  const xpResult = addXp(member, xpGain, config);

  return { ok: true, member, pointGain, xpGain, streakBonus, xpResult };
}

export function topMembers(db, limit = 10) {
  normalizeDb(db);
  return Object.values(db.members)
    .filter((member) => member.registered)
    .sort((a, b) => {
      if (b.level !== a.level) return b.level - a.level;
      if (b.totalXp !== a.totalXp) return b.totalXp - a.totalXp;
      return b.points - a.points;
    })
    .slice(0, limit);
}

export function addVoucher(db, payload) {
  normalizeDb(db);
  const code = String(payload.code || '').trim().toUpperCase();
  if (!code) throw new Error('Kode voucher kosong.');
  db.vouchers[code] = {
    code,
    points: Math.max(0, Math.floor(Number(payload.points || 0))),
    xp: Math.max(0, Math.floor(Number(payload.xp || 0))),
    stock: Math.max(1, Math.floor(Number(payload.stock || 1))),
    desc: payload.desc || 'Voucher member',
    claimed: Array.isArray(payload.claimed) ? payload.claimed : [],
    createdAt: Date.now()
  };
  return db.vouchers[code];
}

export function claimVoucher(db, jid, name, rawCode, config) {
  const member = getMember(db, jid, name);
  if (!member.registered) return { ok: false, reason: 'not_registered', member };

  const code = String(rawCode || '').trim().toUpperCase();
  const voucher = db.vouchers[code];
  if (!voucher) return { ok: false, reason: 'not_found' };
  if (voucher.claimed.includes(jid)) return { ok: false, reason: 'already_claimed', voucher };
  if (voucher.claimed.length >= voucher.stock) return { ok: false, reason: 'empty', voucher };

  voucher.claimed.push(jid);
  addPoints(member, voucher.points);
  const xpResult = addXp(member, voucher.xp || 0, config);

  return { ok: true, member, voucher, xpResult };
}

export function createRedemption(db, member, reward) {
  normalizeDb(db);
  const redemption = {
    id: makeId('RDM'),
    jid: member.jid,
    name: member.name,
    rewardId: reward.id,
    rewardName: reward.name,
    cost: reward.price,
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  db.redemptions.unshift(redemption);
  return redemption;
}

export function updateRedemption(db, id, status) {
  normalizeDb(db);
  const redemption = db.redemptions.find((item) => item.id === id);
  if (!redemption) return null;
  redemption.status = status;
  redemption.updatedAt = Date.now();
  return redemption;
}
