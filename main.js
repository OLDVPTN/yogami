import 'dotenv/config';
import chalk from 'chalk';
import { handleIncoming } from './src/handler.js';
import { ensureDir, loadConfig } from './src/utils.js';
import { startWebServer } from './src/web.js';
import { validateStorageSettings } from './src/storage.js';
import { closeDatabase, loadDatabase, saveDatabase, validateDbSettings } from './src/persistence.js';
import {
  createMetaWhatsAppClient,
  extractWebhookMessages,
  validateMetaSettings,
  verifyMetaSignature,
  verifyWebhookChallenge
} from './src/meta.js';

const CONFIG_FILE = './config.json';
const DB_FILE = './database/database.json';

const config = loadConfig(CONFIG_FILE);
if (config.database.provider !== 'neon') ensureDir('./database');
if ((process.env.STORAGE_PROVIDER || config.storageProvider || '').toLowerCase() !== 'r2') {
  ensureDir('./public/uploads/testimonials');
}

function banner() {
  console.clear();
  console.log(chalk.cyan.bold('╔══════════════════════════════════════╗'));
  console.log(chalk.cyan.bold('║   POKO MEMBER BOT - META OFFICIAL   ║'));
  console.log(chalk.cyan.bold('╚══════════════════════════════════════╝'));
  console.log(chalk.gray('WhatsApp Cloud API + website testimoni EJS + R2 + Neon'));
  console.log(chalk.gray(`Prefix: ${config.prefix} | Timezone: ${config.timezone}`));
  console.log(chalk.gray(`Webhook: ${config.publicBaseUrl}${config.meta.webhookPath}`));
  console.log(chalk.gray(`Storage: ${config.storageProvider.toUpperCase()}${config.storageProvider === 'r2' && config.r2?.bucket ? ` | Bucket: ${config.r2.bucket}` : ''}`));
  console.log(chalk.gray(`Database: ${config.database.provider.toUpperCase()}${config.database.provider === 'neon' ? ` | Schema: relational | State: ${config.database.stateKey}` : ''}`));
  console.log(chalk.gray(`Graph API: ${config.meta.graphApiVersion} | Phone Number ID: ${config.meta.phoneNumberId || '-'}\n`));
}

banner();

const storageStatus = validateStorageSettings(config);
if (!storageStatus.ok) console.log(chalk.yellow(`[storage] ${storageStatus.warnings.join(' | ')}`));

const dbStatus = validateDbSettings(config);
if (!dbStatus.ok) console.log(chalk.yellow(`[database] ${dbStatus.warnings.join(' | ')}`));

const metaStatus = validateMetaSettings(config);
if (!metaStatus.ok) console.log(chalk.yellow(`[meta] ${metaStatus.warnings.join(' | ')}`));

const db = await loadDatabase(config, DB_FILE);
const waClient = createMetaWhatsAppClient(config);
let lastSave = Date.now();

async function saveNow(options = {}) {
  await saveDatabase(config, db, DB_FILE, options);
  lastSave = Date.now();
}

setInterval(() => {
  saveNow().catch((error) => console.error(chalk.red('[database save error]'), error.message));
}, 30_000);

async function shutdown(code = 0) {
  console.log(chalk.yellow('\nMenyimpan database sebelum keluar...'));
  try {
    await saveNow({ immediate: true });
    await closeDatabase(config);
  } catch (error) {
    console.error(chalk.red('[shutdown save error]'), error.message);
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('uncaughtException', async (error) => {
  console.error(chalk.red('[uncaughtException]'), error);
  await saveNow({ immediate: true }).catch(() => {});
});
process.on('unhandledRejection', async (error) => {
  console.error(chalk.red('[unhandledRejection]'), error);
  await saveNow({ immediate: true }).catch(() => {});
});

async function processWebhookPayload(payload) {
  const messages = extractWebhookMessages(payload, config);
  const results = [];

  for (const event of messages) {
    try {
      const changed = await handleIncoming(waClient, event, db, config);
      results.push({ id: event.id, from: event.from, changed });
      if (changed || Date.now() - lastSave > 10_000) {
        saveNow().catch((error) => console.error(chalk.red('[database save error]'), error.message));
      }
    } catch (error) {
      console.error(chalk.red('[webhook message error]'), error);
      results.push({ id: event.id, from: event.from, error: error.message });
      if (event.from) {
        await waClient.sendText(event.from, `Maaf, sistem sedang gagal memproses pesan kamu. Detail singkat: ${error.message}`).catch(() => {});
      }
    }
  }

  return { processed: results.length, results };
}

const metaRuntime = {
  verifyChallenge: (query) => verifyWebhookChallenge(query, config),
  verifySignature: (req) => verifyMetaSignature(req, config),
  processWebhookPayload,
  status: () => ({
    provider: 'meta-cloud-api',
    graphApiVersion: config.meta.graphApiVersion,
    phoneNumberId: config.meta.phoneNumberId,
    webhookPath: config.meta.webhookPath,
    configured: validateMetaSettings(config).ok
  })
};

startWebServer(db, config, metaRuntime, {
  onDatabaseChange: () => {
    saveNow().catch((error) => console.error(chalk.red('[database save error]'), error.message));
  }
});
