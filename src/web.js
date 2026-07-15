import crypto from 'crypto';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  formatDateTime,
  formatNumber,
  normalizeSearchText,
  slugifyUsername
} from './utils.js';
import {
  findTestimonialById,
  getPublicTestimonialsByUsername,
  latestTestimonials,
  recordSearchQuery,
  recordTestimonialView,
  searchTestimonials,
  topSearchKeywordToday
} from './db.js';
import { readStoredMedia } from './storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export function startWebServer(db, config, metaRuntime = null, options = {}) {
  const app = express();
  const port = Number(process.env.PORT || 10000);

  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT_DIR, 'views'));

  app.locals.formatNumber = formatNumber;
  app.locals.formatDateTime = formatDateTime;
  app.locals.encodeURIComponent = encodeURIComponent;
  app.locals.onDatabaseChange = typeof options.onDatabaseChange === 'function' ? options.onDatabaseChange : null;

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    }
  }));
  app.get('/assets/styles.css', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.sendFile(path.join(ROOT_DIR, 'public/styles.css'));
  });

  const liveDbReads = shouldUseLiveDbReads(config);
  let lastDbRefreshAt = 0;
  app.use(async (req, res, next) => {
    if (isDynamicDataRequest(req)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
    }

    if (!liveDbReads || typeof options.reloadDatabase !== 'function' || !shouldRefreshBeforeRequest(req)) {
      next();
      return;
    }

    const minMs = Math.max(0, Number(process.env.DB_LIVE_READ_MIN_MS || 1000));
    const now = Date.now();
    if (now - lastDbRefreshAt < minMs) {
      next();
      return;
    }

    try {
      lastDbRefreshAt = now;
      await options.reloadDatabase();
    } catch (error) {
      console.error('[database refresh error]', error.message);
    }
    next();
  });

  const webhookPath = config.meta?.webhookPath || '/webhook';

  app.get(webhookPath, (req, res) => {
    if (!metaRuntime?.verifyChallenge) {
      res.sendStatus(503);
      return;
    }

    const result = metaRuntime.verifyChallenge(req.query || {});
    if (!result.ok) {
      res.sendStatus(403);
      return;
    }

    res.status(200).send(result.challenge);
  });

  app.post(webhookPath, async (req, res) => {
    if (!metaRuntime?.processWebhookPayload) {
      res.sendStatus(503);
      return;
    }

    if (metaRuntime.verifySignature && !metaRuntime.verifySignature(req)) {
      res.sendStatus(403);
      return;
    }

    // Meta expects a fast 200 response. Processing is awaited here because the
    // workload is intentionally small; move this to a queue when traffic grows.
    try {
      await metaRuntime.processWebhookPayload(req.body || {});
      res.sendStatus(200);
    } catch (error) {
      console.error('[webhook error]', error);
      res.sendStatus(200);
    }
  });

  app.get('/', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q) return renderSearch(res, db, config, q);

    const latest = latestTestimonials(db, 24);
    const stats = buildPublicStats(db);
    const trendingKeyword = buildHeroKeyword(db, config, latest);
    res.render('pages/home', viewLocals(config, {
      title: config.webTitle,
      description: 'Cari testimoni member berdasarkan keyword, lalu buka profil pengguna untuk melihat semua testimoni mereka.',
      query: q,
      latest,
      stats,
      trendingKeyword
    }));
  });

  app.get('/search', (req, res) => {
    const q = String(req.query.q || '').trim();
    renderSearch(res, db, config, q);
  });

  app.get('/t/:id', (req, res) => {
    const testimonial = findTestimonialById(db, req.params.id);
    if (!testimonial) {
      res.status(404).render('pages/not-found', viewLocals(config, {
        title: 'Testimoni tidak ditemukan',
        description: 'Testimoni tidak ditemukan.',
        username: 'unknown'
      }));
      return;
    }

    const viewResult = maybeRecordDetailView(db, req, testimonial.id);
    const detailItem = viewResult?.testimonial || testimonial;
    if (viewResult.counted && typeof options.onDatabaseChange === 'function') {
      options.onDatabaseChange({ reason: 'testimonial_view', testimonialId: testimonial.id });
    }

    const profile = getPublicTestimonialsByUsername(db, testimonial.username);
    const member = profile?.member || null;
    const related = (profile?.testimonials || []).filter((item) => item.id !== detailItem.id).slice(0, 6);

    res.render('pages/testimonial-detail', viewLocals(config, {
      title: `#${(detailItem.keywords || [detailItem.username])[0] || detailItem.username} — @${detailItem.username}`,
      description: detailItem.text || `Testimoni dari @${detailItem.username}`,
      testimonial: detailItem,
      member,
      related
    }));
  });

  app.get('/media/:id', async (req, res) => {
    const testimonial = findTestimonialById(db, req.params.id);
    if (!testimonial) {
      res.status(404).send('Media tidak ditemukan.');
      return;
    }

    try {
      const media = await readStoredMedia(testimonial, config, { rangeHeader: req.headers.range });

      res.status(media.statusCode || 200);
      res.setHeader('Content-Type', media.contentType || 'application/octet-stream');
      res.setHeader('Cache-Control', media.cacheControl || 'private, max-age=3600');
      res.setHeader('Content-Disposition', 'inline; filename="testimonial-media"');
      res.setHeader('Accept-Ranges', media.acceptRanges || 'bytes');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      if (media.contentRange) res.setHeader('Content-Range', media.contentRange);
      if (media.contentLength) res.setHeader('Content-Length', String(media.contentLength));
      if (media.etag) res.setHeader('ETag', media.etag);
      pipeMediaBody(media.body, res);
    } catch (error) {
      console.error('[media error]', error);
      res.status(502).send(`Gagal membuka media: ${error.message}`);
    }
  });

  app.get('/connect', (req, res) => {
    res.render('pages/meta-setup', viewLocals(config, {
      title: 'Meta Cloud API Setup',
      description: 'Bot ini memakai WhatsApp Cloud API resmi dari Meta, jadi tidak ada pairing code atau QR WhatsApp Web.',
      status: metaRuntime?.status ? metaRuntime.status() : null
    }));
  });

  app.get('/@:username', (req, res) => {
    const username = slugifyUsername(req.params.username || '');
    const profile = getPublicTestimonialsByUsername(db, username);

    if (!profile) {
      res.status(404).render('pages/not-found', viewLocals(config, {
        title: 'Profil tidak ditemukan',
        description: 'Profil member tidak ditemukan.',
        username
      }));
      return;
    }

    const { member, testimonials } = profile;
    const displayName = member.name || member.account.username;

    res.render('pages/profile', viewLocals(config, {
      title: `@${member.account.username} — ${displayName}`,
      description: `Kumpulan testimoni dari ${displayName}.`,
      member,
      testimonials,
      profileStats: buildProfileStats(testimonials)
    }));
  });

  app.get('/api/search', (req, res) => {
    const q = String(req.query.q || '').trim();
    const results = searchTestimonials(db, q, 30).map((item) => ({
      username: item.username,
      name: item.name,
      totalTestimonials: item.totalTestimonials,
      matchedTestimonials: item.matchedTestimonials,
      profileUrl: `/@${item.username}`,
      latestAt: item.latestAt,
      verified: Boolean(item.verified)
    }));
    res.json({ query: q, results });
  });

  app.get('/api/meta/status', (req, res) => {
    res.json({ ok: true, status: metaRuntime?.status ? metaRuntime.status() : null });
  });

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      service: config.botName,
      provider: 'meta-cloud-api',
      webhookPath,
      time: new Date().toISOString()
    });
  });

  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Website testimoni + webhook Meta aktif di port ${port}`);
    console.log(`Webhook URL: ${config.publicBaseUrl}${webhookPath}`);
  });

  return { app, server };
}


function shouldUseLiveDbReads(config = {}) {
  const raw = String(process.env.DB_LIVE_READS || '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true;
  return String(config.database?.provider || config.dbProvider || '').toLowerCase() === 'neon';
}

function isDynamicDataRequest(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const pathValue = String(req.path || '');
  if (pathValue.startsWith('/assets/') || pathValue.startsWith('/media/')) return false;
  return ['/', '/search', '/connect', '/health'].includes(pathValue)
    || pathValue.startsWith('/@')
    || pathValue.startsWith('/t/')
    || pathValue.startsWith('/api/');
}

function shouldRefreshBeforeRequest(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const pathValue = String(req.path || '');
  if (pathValue.startsWith('/assets/') || pathValue.startsWith('/media/')) return false;
  return pathValue === '/'
    || pathValue === '/search'
    || pathValue.startsWith('/@')
    || pathValue.startsWith('/t/')
    || pathValue.startsWith('/api/search');
}

function renderSearch(res, db, config, q) {
  const normalized = normalizeSearchText(q);
  if (normalized) {
    const searchRecord = recordSearchQuery(db, q, config);
    if (searchRecord.ok && typeof res.req?.app?.locals?.onDatabaseChange === 'function') {
      res.req.app.locals.onDatabaseChange({ reason: 'search_query', query: q, keyword: searchRecord.keyword });
    }
  }

  const results = searchTestimonials(db, q, 40);

  res.render('pages/search', viewLocals(config, {
    title: q ? `Cari: ${q}` : 'Cari Testimoni',
    description: 'Hasil pencarian testimoni member.',
    query: q,
    results,
    hasQuery: Boolean(normalized)
  }));
}

function viewLocals(config, locals = {}) {
  return {
    config,
    baseUrl: config.publicBaseUrl,
    webTitle: config.webTitle,
    mediaDisplayUrl,
    mediaKindLabel,
    testimonialUrl,
    viewCountOf,
    ...locals
  };
}

function mediaDisplayUrl(item = {}) {
  if (!item?.id) return '';
  return `/media/${encodeURIComponent(item.id)}`;
}

function mediaKindLabel(item = {}) {
  return item.mediaType === 'video' ? 'Video' : 'Gambar';
}

function testimonialUrl(item = {}) {
  if (!item?.id) return '#';
  return `/t/${encodeURIComponent(item.id)}`;
}

function viewCountOf(item = {}) {
  return Math.max(0, Number(item.views?.count || item.viewCount || 0));
}


function buildHeroKeyword(db = {}, config = {}, latest = []) {
  const top = topSearchKeywordToday(db, config);
  if (top) {
    return {
      label: top.label || top.keyword,
      keyword: top.keyword,
      count: Number(top.count || 0),
      source: 'today-search'
    };
  }

  const fallback = latest.find((item) => Array.isArray(item.keywords) && item.keywords[0])?.keywords?.[0];
  return {
    label: fallback || 'thalasemia',
    keyword: fallback || 'thalasemia',
    count: 0,
    source: fallback ? 'latest-testimonial' : 'default'
  };
}

function buildPublicStats(db = {}) {
  const testimonials = Array.isArray(db.testimonials) ? db.testimonials.filter((item) => item.published !== false) : [];
  const members = Object.values(db.members || {}).filter((member) => member.account?.username && member.profile?.published !== false);
  const totalViews = testimonials.reduce((sum, item) => sum + viewCountOf(item), 0);
  return {
    testimonials: testimonials.length,
    members: members.length,
    views: totalViews
  };
}

function buildProfileStats(testimonials = []) {
  return {
    views: testimonials.reduce((sum, item) => sum + viewCountOf(item), 0),
    images: testimonials.filter((item) => item.mediaType !== 'video').length,
    videos: testimonials.filter((item) => item.mediaType === 'video').length
  };
}

function maybeRecordDetailView(db, req, testimonialId) {
  if (req.method === 'HEAD' || isLikelyBot(req.headers['user-agent'])) {
    return { counted: false };
  }
  const viewerKey = makeViewerKey(req);
  return recordTestimonialView(db, testimonialId, viewerKey);
}

function makeViewerKey(req) {
  const ip = String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 240);
  return crypto.createHash('sha256').update(`${ip}|${userAgent}`).digest('hex').slice(0, 32);
}

function isLikelyBot(userAgent = '') {
  return /bot|crawler|spider|preview|facebookexternalhit|whatsapp|telegram|slurp|bing|google|lighthouse/i.test(String(userAgent || ''));
}

function pipeMediaBody(body, res) {
  if (!body) {
    res.end();
    return;
  }

  if (Buffer.isBuffer(body) || typeof body === 'string') {
    res.end(body);
    return;
  }

  if (typeof body.pipe === 'function') {
    body.on('error', (error) => {
      console.error('[media stream error]', error);
      if (!res.headersSent) res.status(502);
      res.end();
    });
    body.pipe(res);
    return;
  }

  if (typeof body.transformToByteArray === 'function') {
    body.transformToByteArray()
      .then((bytes) => res.end(Buffer.from(bytes)))
      .catch((error) => {
        console.error('[media stream error]', error);
        if (!res.headersSent) res.status(502);
        res.end();
      });
    return;
  }

  res.end();
}

