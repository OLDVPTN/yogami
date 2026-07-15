import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import sharp from 'sharp';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { extractKeywords, getMediaExtension } from './utils.js';

export async function applyWatermarkToMedia({ buffer, mediaKind, mimetype, extension, username, text, config }) {
  const settings = getWatermarkSettings(config);
  const original = {
    buffer,
    mimetype,
    extension: extension || getMediaExtension(mimetype, mediaKind),
    watermarked: false,
    watermarkMode: 'none'
  };

  if (!buffer?.length || settings.mode === 'off' || settings.mode === 'none') return original;

  const labels = buildWatermarkLabels({ username, text, config, settings });
  const label = `${labels.top} • ${labels.bottomLeft}`.slice(0, 120);

  if (mediaKind === 'image' && settings.embedImages && ['embedded', 'both'].includes(settings.mode)) {
    try {
      const result = await embedImageWatermark({ buffer, mimetype, extension, labels, settings });
      return { ...original, ...result, watermarked: true, watermarkMode: 'embedded-image-top-bottom' };
    } catch (error) {
      console.warn('[watermark image warning]', error.message);
      return { ...original, watermarkMode: 'display-fallback' };
    }
  }

  if (mediaKind === 'video' && settings.embedVideos && ['embedded', 'both'].includes(settings.mode)) {
    try {
      const result = await embedVideoWatermark({ buffer, mimetype, extension, label, settings });
      return { ...original, ...result, watermarked: true, watermarkMode: 'embedded-video' };
    } catch (error) {
      console.warn('[watermark video warning]', error.message);
      return { ...original, watermarkMode: 'display-fallback' };
    }
  }

  return { ...original, watermarkMode: 'display-only' };
}

export function buildWatermarkLabel({ username = '', text = '', config = {}, settings = {} }) {
  const labels = buildWatermarkLabels({ username, text, config, settings });
  return `${labels.top} • ${labels.bottomLeft}`.slice(0, 120);
}

export function buildWatermarkLabels({ username = '', text = '', config = {}, settings = {} }) {
  const user = username ? `@${username}` : '@member';
  const hashtag = firstHashtag(text);
  const site = config.webTitle || 'Poko Testimoni';
  const date = formatWatermarkDate(Date.now(), config.timezone || 'Asia/Jakarta');

  const customTop = String(settings.topText || settings.text || '').trim();
  const customBottomLeft = String(settings.bottomLeft || '').trim();
  const customBottomRight = String(settings.bottomRight || '').trim();

  const replacer = (value) => String(value || '')
    .replace(/\{username\}/g, user)
    .replace(/\{hashtag\}/g, hashtag)
    .replace(/\{site\}/g, site)
    .replace(/\{date\}/g, date)
    .replace(/\{datetime\}/g, date)
    .slice(0, 140);

  return {
    top: replacer(customTop || '{username} • {hashtag}'),
    bottomLeft: replacer(customBottomLeft || '{site}'),
    bottomRight: replacer(customBottomRight || '{datetime}')
  };
}

function getWatermarkSettings(config = {}) {
  const raw = config.watermark || {};
  return {
    mode: String(process.env.WATERMARK_MODE || raw.mode || 'both').toLowerCase(),
    layout: String(process.env.WATERMARK_LAYOUT || raw.layout || 'top-bottom').toLowerCase(),
    text: String(process.env.WATERMARK_TEXT || raw.text || '').trim(),
    topText: String(process.env.WATERMARK_TOP_TEXT || raw.topText || '').trim(),
    bottomLeft: String(process.env.WATERMARK_BOTTOM_LEFT || raw.bottomLeft || '').trim(),
    bottomRight: String(process.env.WATERMARK_BOTTOM_RIGHT || raw.bottomRight || '').trim(),
    embedImages: String(process.env.WATERMARK_EMBED_IMAGES ?? raw.embedImages ?? 'true').toLowerCase() !== 'false',
    embedVideos: String(process.env.WATERMARK_EMBED_VIDEOS ?? raw.embedVideos ?? 'false').toLowerCase() === 'true',
    position: String(process.env.WATERMARK_POSITION || raw.position || 'bottom-right').toLowerCase(),
    opacity: clamp(Number(process.env.WATERMARK_OPACITY || raw.opacity || 0.72), 0.25, 0.95)
  };
}

async function embedImageWatermark({ buffer, mimetype, extension, labels, settings }) {
  const image = sharp(buffer, { failOn: 'none', animated: false }).rotate();
  const meta = await image.metadata();
  const width = Number(meta.width || 1080);
  const height = Number(meta.height || 1080);
  const overlay = settings.layout === 'badge'
    ? buildBadgeWatermarkSvg({ label: `${labels.top} • ${labels.bottomLeft}`, width, height, opacity: settings.opacity, compact: true })
    : buildTopBottomWatermarkSvg({ labels, width, height, opacity: settings.opacity });

  const composite = settings.layout === 'badge'
    ? image.composite([{ input: Buffer.from(overlay), gravity: gravityFromPosition(settings.position) }])
    : image.composite([{ input: Buffer.from(overlay), left: 0, top: 0 }]);

  const mime = String(mimetype || '').toLowerCase();
  const ext = String(extension || '').toLowerCase();

  if (mime.includes('png') || ext === 'png') {
    return { buffer: await composite.png({ compressionLevel: 9 }).toBuffer(), mimetype: 'image/png', extension: 'png' };
  }

  if (mime.includes('webp') || ext === 'webp') {
    return { buffer: await composite.webp({ quality: 88 }).toBuffer(), mimetype: 'image/webp', extension: 'webp' };
  }

  return { buffer: await composite.jpeg({ quality: 90, mozjpeg: true }).toBuffer(), mimetype: 'image/jpeg', extension: 'jpg' };
}

async function embedVideoWatermark({ buffer, mimetype, extension, label, settings }) {
  // Video watermark permanen tetap memakai badge ringan supaya proses FFmpeg tidak terlalu berat.
  // Untuk watermark top-bottom video, lebih aman diproses lewat worker khusus di luar webhook utama.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'poko-wm-'));
  const inputExt = safeExt(extension || getMediaExtension(mimetype, 'video') || 'mp4');
  const inputPath = path.join(tmpDir, `input.${inputExt}`);
  const overlayPath = path.join(tmpDir, 'watermark.png');
  const outputPath = path.join(tmpDir, 'output.mp4');

  try {
    await fs.writeFile(inputPath, buffer);
    await sharp(Buffer.from(buildBadgeWatermarkSvg({ label, width: 560, height: 88, opacity: settings.opacity, compact: false })))
      .png()
      .toFile(overlayPath);

    const overlayFilter = overlayPositionFilter(settings.position);
    await runFfmpeg([
      '-hide_banner',
      '-y',
      '-i', inputPath,
      '-i', overlayPath,
      '-filter_complex', `[0:v][1:v]overlay=${overlayFilter}:format=auto`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '24',
      '-c:a', 'aac',
      '-movflags', '+faststart',
      outputPath
    ]);

    const output = await fs.readFile(outputPath);
    return { buffer: output, mimetype: 'video/mp4', extension: 'mp4' };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function runFfmpeg(args) {
  const ffmpegPath = process.env.FFMPEG_PATH || ffmpegInstaller.path;
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg gagal dengan kode ${code}. ${stderr.trim()}`));
    });
  });
}

function buildTopBottomWatermarkSvg({ labels, width, height, opacity }) {
  const w = Math.round(width);
  const h = Math.round(height);
  const minSide = Math.min(w, h);
  const topH = Math.round(clamp(height * 0.062, 42, 88));
  const bottomH = Math.round(clamp(height * 0.074, 52, 104));
  const padX = Math.round(clamp(width * 0.032, 18, 46));
  const topFont = Math.round(clamp(minSide * 0.034, 16, 34));
  const bottomMainFont = Math.round(clamp(minSide * 0.040, 18, 38));
  const bottomSubFont = Math.round(clamp(minSide * 0.030, 14, 28));
  const bottomY = h - Math.round(bottomH / 2);
  const rightX = w - padX;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs>
      <linearGradient id="topFade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="rgba(5,8,22,${opacity})"/>
        <stop offset="1" stop-color="rgba(5,8,22,${Math.max(0.2, opacity - 0.18)})"/>
      </linearGradient>
      <linearGradient id="bottomFade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="rgba(5,8,22,${Math.max(0.2, opacity - 0.12)})"/>
        <stop offset="1" stop-color="rgba(5,8,22,${opacity})"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${w}" height="${topH}" fill="url(#topFade)"/>
    <rect x="0" y="${h - bottomH}" width="${w}" height="${bottomH}" fill="url(#bottomFade)"/>
    <text x="${padX}" y="${Math.round(topH / 2)}" dominant-baseline="middle" fill="rgba(255,255,255,.96)" font-family="Arial, Helvetica, sans-serif" font-size="${topFont}" font-weight="800">${escapeXml(labels.top)}</text>
    <text x="${padX}" y="${bottomY}" dominant-baseline="middle" fill="rgba(255,255,255,.97)" font-family="Arial, Helvetica, sans-serif" font-size="${bottomMainFont}" font-weight="900" letter-spacing="-0.5">${escapeXml(labels.bottomLeft)}</text>
    <text x="${rightX}" y="${bottomY}" text-anchor="end" dominant-baseline="middle" fill="rgba(255,255,255,.88)" font-family="Arial, Helvetica, sans-serif" font-size="${bottomSubFont}" font-weight="700">${escapeXml(labels.bottomRight)}</text>
  </svg>`;
}

function buildBadgeWatermarkSvg({ label, width, height, opacity, compact }) {
  const safeLabel = escapeXml(label);
  const boxWidth = compact ? Math.min(Math.max(width * 0.52, 250), 620) : width;
  const boxHeight = compact ? Math.min(Math.max(height * 0.07, 54), 90) : height;
  const fontSize = compact ? Math.max(16, Math.min(28, boxHeight * 0.34)) : 22;
  const padX = compact ? Math.max(20, boxHeight * 0.28) : 24;
  const radius = Math.max(18, boxHeight * 0.32);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(boxWidth)}" height="${Math.round(boxHeight)}" viewBox="0 0 ${Math.round(boxWidth)} ${Math.round(boxHeight)}">
    <rect x="0" y="0" width="${Math.round(boxWidth)}" height="${Math.round(boxHeight)}" rx="${Math.round(radius)}" fill="rgba(5,8,22,${opacity})"/>
    <rect x="1" y="1" width="${Math.round(boxWidth - 2)}" height="${Math.round(boxHeight - 2)}" rx="${Math.round(radius - 1)}" fill="none" stroke="rgba(255,255,255,.32)" stroke-width="2"/>
    <text x="${Math.round(padX)}" y="50%" dominant-baseline="middle" fill="rgba(255,255,255,.94)" font-family="Arial, Helvetica, sans-serif" font-size="${Math.round(fontSize)}" font-weight="800">${safeLabel}</text>
  </svg>`;
}

function firstHashtag(text = '') {
  const [tag] = extractKeywords(text);
  return tag ? `#${tag}` : '#testimoni';
}

function formatWatermarkDate(timestamp = Date.now(), timezone = 'Asia/Jakarta') {
  try {
    const parts = new Intl.DateTimeFormat('id-ID', {
      timeZone: timezone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(new Date(timestamp));
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${map.day}/${map.month}/${map.year} ${map.hour}:${map.minute}`;
  } catch {
    return new Date(timestamp).toISOString().slice(0, 16).replace('T', ' ');
  }
}

function gravityFromPosition(position = '') {
  if (position.includes('left') && position.includes('top')) return 'northwest';
  if (position.includes('right') && position.includes('top')) return 'northeast';
  if (position.includes('left')) return 'southwest';
  if (position.includes('center')) return 'center';
  return 'southeast';
}

function overlayPositionFilter(position = '') {
  const margin = 24;
  if (position.includes('left') && position.includes('top')) return `${margin}:${margin}`;
  if (position.includes('right') && position.includes('top')) return `main_w-overlay_w-${margin}:${margin}`;
  if (position.includes('left')) return `${margin}:main_h-overlay_h-${margin}`;
  if (position.includes('center')) return `(main_w-overlay_w)/2:(main_h-overlay_h)/2`;
  return `main_w-overlay_w-${margin}:main_h-overlay_h-${margin}`;
}

function safeExt(value = '') {
  return String(value || 'mp4').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'mp4';
}

function escapeXml(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
