import crypto from 'crypto';
import { clampText, getMediaExtension, jidToNumber, normalizeNumber, toJid } from './utils.js';

export function getMetaSettings(config = {}) {
  return {
    graphApiVersion: String(process.env.GRAPH_API_VERSION || config.meta?.graphApiVersion || 'v25.0').replace(/^\/+/, ''),
    accessToken: String(process.env.WHATSAPP_ACCESS_TOKEN || config.meta?.accessToken || '').trim(),
    phoneNumberId: String(process.env.WHATSAPP_PHONE_NUMBER_ID || config.meta?.phoneNumberId || '').trim(),
    businessAccountId: String(process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || config.meta?.businessAccountId || '').trim(),
    verifyToken: String(process.env.WHATSAPP_VERIFY_TOKEN || config.meta?.verifyToken || '').trim(),
    appSecret: String(process.env.META_APP_SECRET || config.meta?.appSecret || '').trim(),
    webhookPath: String(process.env.WHATSAPP_WEBHOOK_PATH || config.meta?.webhookPath || '/webhook').trim() || '/webhook'
  };
}

export function validateMetaSettings(config = {}) {
  const settings = getMetaSettings(config);
  const missing = [];
  if (!settings.accessToken) missing.push('WHATSAPP_ACCESS_TOKEN');
  if (!settings.phoneNumberId) missing.push('WHATSAPP_PHONE_NUMBER_ID');
  if (!settings.verifyToken) missing.push('WHATSAPP_VERIFY_TOKEN');
  return {
    ok: missing.length === 0,
    settings,
    missing,
    warnings: missing.length ? [`Konfigurasi Meta Cloud API belum lengkap: ${missing.join(', ')}`] : []
  };
}

export function createMetaWhatsAppClient(config = {}) {
  const settings = getMetaSettings(config);
  const baseUrl = `https://graph.facebook.com/${settings.graphApiVersion}`;

  async function graphFetch(path, options = {}) {
    if (!settings.accessToken) throw new Error('WHATSAPP_ACCESS_TOKEN belum diisi.');
    const url = path.startsWith('http') ? path : `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers = {
      Authorization: `Bearer ${settings.accessToken}`,
      ...(options.headers || {})
    };

    const response = await fetch(url, { ...options, headers });
    const contentType = response.headers.get('content-type') || '';

    if (!response.ok) {
      let detail = '';
      try {
        detail = contentType.includes('application/json') ? JSON.stringify(await response.json()) : await response.text();
      } catch {
        detail = response.statusText;
      }
      throw new Error(`Meta API error ${response.status}: ${detail}`);
    }

    if (options.raw) return response;
    if (contentType.includes('application/json')) return response.json();
    return response.text();
  }

  async function sendMessage(to, payload = {}) {
    const phone = normalizeNumber(to);
    if (!phone) throw new Error('Nomor tujuan kosong.');
    if (!settings.phoneNumberId) throw new Error('WHATSAPP_PHONE_NUMBER_ID belum diisi.');

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      ...payload
    };

    return graphFetch(`/${settings.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  async function sendText(to, text) {
    return sendMessage(to, {
      type: 'text',
      text: {
        preview_url: true,
        body: clampText(text, 4000)
      }
    });
  }

  async function markMessageAsRead(messageId) {
    if (!messageId || !settings.phoneNumberId) return null;
    try {
      return graphFetch(`/${settings.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId
        })
      });
    } catch {
      return null;
    }
  }

  async function getMediaUrl(mediaId) {
    if (!mediaId) throw new Error('Media ID kosong.');
    return graphFetch(`/${mediaId}`);
  }

  async function downloadMedia(mediaId) {
    const meta = await getMediaUrl(mediaId);
    if (!meta?.url) throw new Error('Meta tidak mengembalikan URL media.');

    const response = await graphFetch(meta.url, { raw: true });
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimetype = response.headers.get('content-type') || meta.mime_type || 'application/octet-stream';
    const mediaKind = mimetype.startsWith('video/') ? 'video' : 'image';

    return {
      buffer,
      mimetype,
      mediaKind,
      sizeBytes: buffer.length,
      extension: getMediaExtension(mimetype, mediaKind),
      meta
    };
  }

  return {
    settings,
    sendMessage,
    sendText,
    markMessageAsRead,
    getMediaUrl,
    downloadMedia
  };
}

export function verifyWebhookChallenge(query = {}, config = {}) {
  const settings = getMetaSettings(config);
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];

  if (mode === 'subscribe' && token && token === settings.verifyToken) {
    return { ok: true, challenge: String(challenge || '') };
  }

  return { ok: false, challenge: '' };
}

export function verifyMetaSignature(req, config = {}) {
  const settings = getMetaSettings(config);
  if (!settings.appSecret) return true;

  const signature = req.get('x-hub-signature-256') || '';
  if (!signature.startsWith('sha256=')) return false;
  if (!req.rawBody) return false;

  const expected = `sha256=${crypto
    .createHmac('sha256', settings.appSecret)
    .update(req.rawBody)
    .digest('hex')}`;

  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function extractWebhookMessages(payload = {}, config = {}) {
  const items = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field && change.field !== 'messages') continue;
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id || '';
      const displayPhoneNumber = value.metadata?.display_phone_number || '';
      const contactsByWaId = new Map((value.contacts || []).map((contact) => [
        String(contact.wa_id || ''),
        contact
      ]));

      for (const message of value.messages || []) {
        const from = normalizeNumber(message.from || '');
        if (!from) continue;
        const contact = contactsByWaId.get(message.from) || {};
        const media = extractMedia(message);
        const text = extractText(message);
        items.push({
          provider: 'meta',
          id: message.id || '',
          from,
          sender: toJid(from),
          phoneNumberId,
          displayPhoneNumber,
          timestamp: Number(message.timestamp || 0),
          profileName: contact.profile?.name || 'Member',
          type: message.type || 'unknown',
          text,
          media,
          context: message.context || null,
          raw: message
        });
      }
    }
  }
  return items;
}

function extractText(message = {}) {
  if (message.type === 'text') return String(message.text?.body || '').trim();
  if (message.type === 'image') return String(message.image?.caption || '').trim();
  if (message.type === 'video') return String(message.video?.caption || '').trim();
  if (message.type === 'document') return String(message.document?.caption || '').trim();
  if (message.type === 'button') return String(message.button?.payload || message.button?.text || '').trim();
  if (message.type === 'interactive') {
    return String(
      message.interactive?.button_reply?.id ||
      message.interactive?.button_reply?.title ||
      message.interactive?.list_reply?.id ||
      message.interactive?.list_reply?.title ||
      ''
    ).trim();
  }
  return '';
}

function extractMedia(message = {}) {
  if (message.type === 'image' && message.image?.id) {
    return {
      kind: 'image',
      id: message.image.id,
      mimetype: message.image.mime_type || 'image/jpeg',
      sha256: message.image.sha256 || '',
      caption: message.image.caption || ''
    };
  }
  if (message.type === 'video' && message.video?.id) {
    return {
      kind: 'video',
      id: message.video.id,
      mimetype: message.video.mime_type || 'video/mp4',
      sha256: message.video.sha256 || '',
      caption: message.video.caption || ''
    };
  }
  return null;
}

export function toPhoneNumber(value = '') {
  return normalizeNumber(jidToNumber(value) || value);
}
