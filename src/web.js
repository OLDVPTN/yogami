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
  searchTestimonials
} from './db.js';
import { readStoredMedia } from './storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

export function startWebServer(db, config, metaRuntime = null) {
  const app = express();
  const port = Number(process.env.PORT || 10000);

  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT_DIR, 'views'));

  app.locals.formatNumber = formatNumber;
  app.locals.formatDateTime = formatDateTime;
  app.locals.encodeURIComponent = encodeURIComponent;

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    }
  }));
  app.use('/assets', express.static(path.join(ROOT_DIR, 'public')));
  app.use('/uploads', express.static(path.join(ROOT_DIR, 'public/uploads'), {
    maxAge: '7d',
    immutable: true
  }));

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

    const latest = latestTestimonials(db, 12);
    res.render('pages/home', viewLocals(config, {
      title: config.webTitle,
      description: 'Cari testimoni member berdasarkan keyword, lalu buka profil pengguna untuk melihat semua testimoni mereka.',
      query: q,
      latest
    }));
  });

  app.get('/search', (req, res) => {
    const q = String(req.query.q || '').trim();
    renderSearch(res, db, config, q);
  });

  app.get('/media/:id', async (req, res) => {
    const testimonial = findTestimonialById(db, req.params.id);
    if (!testimonial) {
      res.status(404).send('Media tidak ditemukan.');
      return;
    }

    try {
      const media = await readStoredMedia(testimonial, config);
      res.setHeader('Content-Type', media.contentType || 'application/octet-stream');
      res.setHeader('Cache-Control', media.cacheControl || 'public, max-age=86400');
      res.setHeader('Content-Disposition', 'inline');
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
      testimonials
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
      latestAt: item.latestAt
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

function renderSearch(res, db, config, q) {
  const results = searchTestimonials(db, q, 40);
  const normalized = normalizeSearchText(q);

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
    ...locals
  };
}

function mediaDisplayUrl(item = {}) {
  if (!item) return '';
  if (item.storageKey || item.storageProvider === 'r2') return `/media/${encodeURIComponent(item.id)}`;
  return item.mediaUrl || '';
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

