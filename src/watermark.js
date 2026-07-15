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

  const label = buildWatermarkLabel({ username, text, config, settings });

  if (mediaKind === 'image' && settings.embedImages && ['embedded', 'both'].includes(settings.mode)) {
    try {
      const result = await embedImageWatermark({ buffer, mimetype, extension, label, settings });
      return { ...original, ...result, watermarked: true, watermarkMode: 'embedded-image' };
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
  const custom = String(settings.text || '').trim();
  if (custom) {
    return custom
      .replace(/\{username\}/g, username ? `@${username}` : '@member')
      .replace(/\{hashtag\}/g, firstHashtag(text))
      .replace(/\{site\}/g, config.webTitle || 'Testimoni Member')
      .slice(0, 96);
  }

  const user = username ? `@${username}` : '@member';
  const tag = firstHashtag(text);
  const site = config.webTitle || 'Testimoni Member';
  return `${user} • ${tag} • ${site}`.slice(0, 96);
}

function getWatermarkSettings(config = {}) {
  const raw = config.watermark || {};
  return {
    mode: String(process.env.WATERMARK_MODE || raw.mode || 'both').toLowerCase(),
    text: String(process.env.WATERMARK_TEXT || raw.text || '').trim(),
    embedImages: String(process.env.WATERMARK_EMBED_IMAGES ?? raw.embedImages ?? 'true').toLowerCase() !== 'false',
    embedVideos: String(process.env.WATERMARK_EMBED_VIDEOS ?? raw.embedVideos ?? 'false').toLowerCase() === 'true',
    position: String(process.env.WATERMARK_POSITION || raw.position || 'bottom-right').toLowerCase(),
    opacity: clamp(Number(process.env.WATERMARK_OPACITY || raw.opacity || 0.76), 0.25, 0.95)
  };
}

async function embedImageWatermark({ buffer, mimetype, extension, label, settings }) {
  const image = sharp(buffer, { failOn: 'none', animated: false }).rotate();
  const meta = await image.metadata();
  const width = Number(meta.width || 1080);
  const height = Number(meta.height || 1080);
  const overlay = buildWatermarkSvg({ label, width, height, opacity: settings.opacity, compact: true });

  const composite = image.composite([{ input: Buffer.from(overlay), gravity: gravityFromPosition(settings.position) }]);
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
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'poko-wm-'));
  const inputExt = safeExt(extension || getMediaExtension(mimetype, 'video') || 'mp4');
  const inputPath = path.join(tmpDir, `input.${inputExt}`);
  const overlayPath = path.join(tmpDir, 'watermark.png');
  const outputPath = path.join(tmpDir, 'output.mp4');

  try {
    await fs.writeFile(inputPath, buffer);
    await sharp(Buffer.from(buildWatermarkSvg({ label, width: 520, height: 88, opacity: settings.opacity, compact: false })))
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

function buildWatermarkSvg({ label, width, height, opacity, compact }) {
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
