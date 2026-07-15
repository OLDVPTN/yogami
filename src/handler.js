import {
  addPoints,
  addTestimonial,
  addVoucher,
  addXp,
  checkinMember,
  claimVoucher,
  createOrUpdateAccount,
  createRedemption,
  getMember,
  getProfileUrl,
  getTestimonialsByMember,
  neededXp,
  passiveMessageReward,
  registerMember,
  resetDailyIfNeeded,
  topMembers,
  updateRedemption
} from './db.js';
import { findReward, rewardListText } from './rewards.js';
import { saveTestimonialMedia } from './storage.js';
import {
  clampText,
  formatNumber,
  getMediaExtension,
  mentionTag,
  parseMentions,
  sameUser,
  slugifyUsername,
  toJid,
  jidToNumber
} from './utils.js';

export async function handleIncoming(client, event, db, config) {
  const ctx = buildContext(client, event, db, config);
  if (!ctx.body && !ctx.isCommand) return false;

  if (config.autoRead && event.id && client.markMessageAsRead) {
    await client.markMessageAsRead(event.id).catch(() => {});
  }

  if (!ctx.isCommand) {
    const result = passiveMessageReward(db, ctx.sender, ctx.pushName, config);

    if (result?.questResult?.completed) {
      await ctx.reply(
        `🎯 *Quest harian selesai!*\n\nKamu berhasil aktif ngobrol hari ini.\n+${formatNumber(result.questResult.bonusPoint)} poin\n+${formatNumber(result.questResult.bonusXp)} XP`
      );
    }

    if (result?.xpResult?.levelUp) {
      await ctx.reply(
        `✨ *Level Up!*\n\n${mentionTag(ctx.sender)} naik ke *Level ${result.xpResult.currentLevel}*.\nLanjutkan aktivitas biar ranking kamu makin naik.`
      );
    }

    return !result?.ignored;
  }

  return handleCommand(ctx);
}

export function buildContext(client, event, db, config) {
  const fromNumber = event.from;
  const sender = event.sender || toJid(fromNumber);
  const body = String(event.text || '').trim();
  const pushName = event.profileName || 'Member';
  const prefix = config.prefix || '.';
  const isCommand = body.startsWith(prefix);
  const withoutPrefix = isCommand ? body.slice(prefix.length).trim() : '';
  const args = withoutPrefix ? withoutPrefix.split(/\s+/).slice(1) : [];
  const command = withoutPrefix ? withoutPrefix.split(/\s+/)[0].toLowerCase() : '';
  const text = args.join(' ');
  const isOwner = sameUser(sender, `${config.ownerNumber}@s.whatsapp.net`);
  const mentioned = parseMentions(body);

  const reply = async (textMessage) => {
    return client.sendText(fromNumber, clampText(textMessage));
  };

  return {
    client,
    rawMsg: event,
    msg: event,
    db,
    config,
    from: fromNumber,
    fromNumber,
    isGroup: false,
    sender,
    body,
    prefix,
    isCommand,
    command,
    args,
    text,
    mentioned,
    quotedSender: '',
    pushName,
    isOwner,
    reply
  };
}

async function handleCommand(ctx) {
  const { command, config } = ctx;

  switch (command) {
    case 'menu':
    case 'help':
      return menuCommand(ctx);

    case 'akun':
    case 'account':
      return accountCommand(ctx);

    case 'testimoni':
    case 'testimonial':
      return testimonialCommand(ctx);

    case 'link':
    case 'weblink':
      return webLinkCommand(ctx);

    case 'daftar':
    case 'register':
      return registerCommand(ctx);

    case 'profil':
    case 'profile':
    case 'me':
      return profileCommand(ctx);

    case 'checkin':
    case 'daily':
      return checkinCommand(ctx);

    case 'quest':
    case 'misi':
      return questCommand(ctx);

    case 'rank':
    case 'leaderboard':
    case 'lb':
      return rankCommand(ctx);

    case 'claim':
      return claimCommand(ctx);

    case 'shop':
    case 'reward':
      return shopCommand(ctx);

    case 'beli':
    case 'redeem':
      return buyCommand(ctx);

    case 'transfer':
      return transferCommand(ctx);

    case 'addpoint':
    case 'addpoin':
      return ownerPointCommand(ctx, 'add');

    case 'minpoint':
    case 'minpoin':
      return ownerPointCommand(ctx, 'min');

    case 'addxp':
      return ownerXpCommand(ctx);

    case 'addvoucher':
    case 'buatvoucher':
      return ownerVoucherCommand(ctx);

    case 'delvoucher':
    case 'hapusvoucher':
      return ownerDeleteVoucherCommand(ctx);

    case 'memberlist':
    case 'members':
      return ownerMemberListCommand(ctx);

    case 'pending':
      return ownerPendingCommand(ctx);

    case 'done':
      return ownerRedemptionStatusCommand(ctx, 'done');

    case 'cancel':
    case 'batal':
      return ownerRedemptionStatusCommand(ctx, 'cancelled');

    case 'ping':
      await ctx.reply('Pong ✅');
      return true;

    default:
      await ctx.reply(`Command tidak dikenal. Ketik *${config.prefix}menu* untuk melihat menu.`);
      return false;
  }
}

async function menuCommand(ctx) {
  const { prefix, pushName } = ctx;
  const adminMenu = ctx.isOwner
    ? `\n\n*Owner*\n• ${prefix}addpoint @user 100\n• ${prefix}minpoint @user 100\n• ${prefix}addxp @user 100\n• ${prefix}addvoucher KODE poin stok deskripsi\n• ${prefix}delvoucher KODE\n• ${prefix}memberlist\n• ${prefix}pending\n• ${prefix}done ID\n• ${prefix}cancel ID`
    : '';

  await ctx.reply(
    `🎮 *Poko Member Bot*\n\nHalo, *${pushName}*.\nBot ini fokus untuk gamifikasi member + website publik testimoni.\n\n*Testimoni Website*\n• ${prefix}akun username password\n• Kirim foto/video dengan caption: ${prefix}testimoni teks testimoni\n• ${prefix}link\n\n*Member Gamification*\n• ${prefix}daftar Nama Kamu\n• ${prefix}profil\n• ${prefix}checkin\n• ${prefix}quest\n• ${prefix}rank\n• ${prefix}claim KODE\n• ${prefix}shop\n• ${prefix}beli ID_REWARD\n• ${prefix}transfer @user jumlah${adminMenu}`
  );
  return true;
}

async function accountCommand(ctx) {
  const [rawUsername, rawPassword, ...nameParts] = ctx.args;
  const username = slugifyUsername(rawUsername || '');
  const password = String(rawPassword || '');
  const displayName = nameParts.join(' ').trim() || ctx.pushName || username || 'Member';

  if (!rawUsername || !rawPassword) {
    await ctx.reply(
      `Format: *${ctx.prefix}akun username password*\n\nContoh:\n*${ctx.prefix}akun poko rahasia123*\n\nUsername dipakai untuk link publik seperti:\n${ctx.config.publicBaseUrl}/@poko`
    );
    return false;
  }

  if (!/^[a-z0-9][a-z0-9._-]{2,23}$/.test(username)) {
    await ctx.reply('Username harus 3–24 karakter, huruf kecil/angka/titik/strip/underscore, dan tidak boleh diawali simbol.');
    return false;
  }

  if (password.length < 6) {
    await ctx.reply('Password minimal 6 karakter. Jangan pakai password yang sama dengan akun penting kamu.');
    return false;
  }

  const result = createOrUpdateAccount(ctx.db, ctx.sender, displayName, username, password);
  if (!result.ok) {
    if (result.reason === 'username_taken') {
      await ctx.reply(`Username *@${username}* sudah dipakai member lain. Coba username lain.`);
      return false;
    }
    await ctx.reply(`Format belum valid. Contoh: *${ctx.prefix}akun poko rahasia123*`);
    return false;
  }

  await ctx.reply(
    `✅ *Akun testimoni berhasil dibuat!*\n\nUsername: *@${result.username}*\nLink profil: ${getProfileUrl(ctx.config, result.username)}\n\nSekarang kamu bisa kirim foto/video dengan caption:\n*${ctx.prefix}testimoni tulis pengalaman kamu di sini*`
  );
  return true;
}

async function testimonialCommand(ctx) {
  const member = getMember(ctx.db, ctx.sender, ctx.pushName);
  if (!member.account?.username) {
    await ctx.reply(`Kamu perlu buat akun dulu.\n\nFormat:\n*${ctx.prefix}akun username password*\n\nContoh:\n*${ctx.prefix}akun poko rahasia123*`);
    return false;
  }

  const media = getTestimonialMedia(ctx.rawMsg);
  if (!media) {
    await ctx.reply(
      `Kirim *foto atau video* dengan caption:\n*${ctx.prefix}testimoni teks testimoni*\n\nBisa juga reply foto/video lalu ketik:\n*${ctx.prefix}testimoni teks testimoni*`
    );
    return false;
  }

  const testimonialText = ctx.text.trim();
  if (testimonialText.length < 5) {
    await ctx.reply('Tulis testimoni minimal 5 karakter supaya bisa dicari orang. Contoh: *.testimoni pengalaman terapi thalassemia di sini sangat membantu*');
    return false;
  }

  const maxBytes = Math.max(1, Number(ctx.config.maxMediaMb || 30)) * 1024 * 1024;
  const downloadedMedia = await ctx.client.downloadMedia(media.id);
  const downloaded = downloadedMedia.buffer;
  if (downloaded.length > maxBytes) {
    await ctx.reply(`Media terlalu besar. Maksimal ${ctx.config.maxMediaMb} MB.`);
    return false;
  }

  const ext = downloadedMedia.extension || getMediaExtension(downloadedMedia.mimetype || media.mimetype, media.kind);
  let storedMedia;
  try {
    storedMedia = await saveTestimonialMedia({
      buffer: downloaded,
      username: member.account.username,
      mediaKind: media.kind,
      mimetype: downloadedMedia.mimetype || media.mimetype,
      extension: ext,
      config: ctx.config
    });
  } catch (error) {
    await ctx.reply(`Gagal upload media ke storage. Detail: ${error.message}`);
    return false;
  }

  const result = addTestimonial(ctx.db, member, {
    text: testimonialText,
    mediaType: media.kind,
    mediaUrl: storedMedia.url,
    storageProvider: storedMedia.provider,
    storageKey: storedMedia.key,
    mimetype: storedMedia.mimetype || downloadedMedia.mimetype || media.mimetype,
    sizeBytes: storedMedia.sizeBytes || downloadedMedia.sizeBytes || downloaded.length
  });

  if (!result.ok) {
    await ctx.reply('Gagal menyimpan testimoni. Coba kirim ulang media dan captionnya.');
    return false;
  }

  const pointReward = Number(ctx.config.testimonialPointReward || 0);
  const xpReward = Number(ctx.config.testimonialXpReward || 0);
  if (pointReward) addPoints(member, pointReward);
  const xpResult = xpReward ? addXp(member, xpReward, ctx.config) : { levelUp: 0, currentLevel: member.level };

  await ctx.reply(
    `✅ *Testimoni berhasil dipublish!*\n\nProfil: ${getProfileUrl(ctx.config, member.account.username)}\nID: *${result.testimonial.id}*\nStorage: *${storedMedia.provider.toUpperCase()}*\nKeyword otomatis: ${result.testimonial.keywords.length ? result.testimonial.keywords.map((key) => `#${key}`).join(' ') : '-'}\n\nReward: +${formatNumber(pointReward)} poin, +${formatNumber(xpReward)} XP${xpResult.levelUp ? `\n✨ Level up ke *Level ${xpResult.currentLevel}*!` : ''}`
  );
  return true;
}

async function webLinkCommand(ctx) {
  const member = getMember(ctx.db, ctx.sender, ctx.pushName);
  if (!member.account?.username) {
    await ctx.reply(`Kamu belum punya link profil. Buat dulu dengan *${ctx.prefix}akun username password*.`);
    return false;
  }

  await ctx.reply(
    `🔗 *Link Profil Testimoni*\n\n${getProfileUrl(ctx.config, member.account.username)}\n\nTotal testimoni: *${formatNumber(getTestimonialsByMember(ctx.db, member.jid).length)}*`
  );
  return true;
}

async function registerCommand(ctx) {
  const name = ctx.text.trim() || ctx.pushName || 'Member';
  if (name.length < 2) {
    await ctx.reply(`Format: *${ctx.prefix}daftar Nama Kamu*`);
    return false;
  }

  const member = registerMember(ctx.db, ctx.sender, name.slice(0, 40));
  await ctx.reply(
    `✅ *Pendaftaran berhasil!*\n\nNama: *${member.name}*\nLevel: *${member.level}*\nPoin: *${formatNumber(member.points)}*\n\nUntuk membuat halaman testimoni publik, ketik:\n*${ctx.prefix}akun username password*`
  );
  return true;
}

async function profileCommand(ctx) {
  const targetJid = getTargetJid(ctx) || ctx.sender;
  const member = getMember(ctx.db, targetJid, targetJid === ctx.sender ? ctx.pushName : 'Member');
  if (!member.registered) {
    await ctx.reply(targetJid === ctx.sender ? `Kamu belum terdaftar. Ketik *${ctx.prefix}daftar Nama Kamu* dulu.` : 'Member itu belum terdaftar.');
    return false;
  }

  resetDailyIfNeeded(member, ctx.config);
  const nextNeed = neededXp(member.level, ctx.config);
  const webLine = member.account?.username
    ? `\nLink Testimoni: ${getProfileUrl(ctx.config, member.account.username)}\nTotal Testimoni: *${formatNumber(getTestimonialsByMember(ctx.db, member.jid).length)}*`
    : `\nLink Testimoni: belum dibuat. Ketik *${ctx.prefix}akun username password*`;

  await ctx.reply(
    `👤 *Profil Member*\n\nNama: *${member.name}*\nNomor: ${mentionTag(member.jid)}\nLevel: *${member.level}*\nXP: *${formatNumber(member.xp)} / ${formatNumber(nextNeed)}*\nTotal XP: *${formatNumber(member.totalXp)}*\nPoin: *${formatNumber(member.points)}*\nStreak Check-in: *${formatNumber(member.streak)} hari*\nChat Quest Hari Ini: *${formatNumber(member.daily.chatCount)} / ${formatNumber(ctx.config.dailyChatQuestTarget)}*${webLine}`,
    { mentions: [member.jid] }
  );
  return true;
}

async function checkinCommand(ctx) {
  const result = checkinMember(ctx.db, ctx.sender, ctx.pushName, ctx.config);
  if (!result.ok) {
    if (result.reason === 'not_registered') {
      await ctx.reply(`Kamu belum terdaftar. Ketik *${ctx.prefix}daftar Nama Kamu* dulu.`);
      return false;
    }
    if (result.reason === 'already_checkin') {
      await ctx.reply('Kamu sudah check-in hari ini. Balik lagi besok ya ✅');
      return false;
    }
  }

  await ctx.reply(
    `✅ *Check-in berhasil!*\n\n+${formatNumber(result.pointGain)} poin\n+${formatNumber(result.xpGain)} XP\nStreak: *${formatNumber(result.member.streak)} hari*\nLevel: *${result.member.level}*${result.xpResult.levelUp ? `\n\n✨ Level up ke *Level ${result.xpResult.currentLevel}*!` : ''}`
  );
  return true;
}

async function questCommand(ctx) {
  const member = getMember(ctx.db, ctx.sender, ctx.pushName);
  if (!member.registered) {
    await ctx.reply(`Kamu belum terdaftar. Ketik *${ctx.prefix}daftar Nama Kamu* dulu.`);
    return false;
  }

  resetDailyIfNeeded(member, ctx.config);
  const chatDone = member.daily.chatQuestClaimed ? '✅' : '⬜';
  const checkinDone = member.lastCheckin === member.daily.date ? '✅' : '⬜';

  await ctx.reply(
    `🎯 *Quest Harian*\n\n${checkinDone} Check-in harian\nReward: +${formatNumber(ctx.config.checkinReward)} poin, +${formatNumber(ctx.config.checkinXp)} XP\n\n${chatDone} Aktif ngobrol ${formatNumber(ctx.config.dailyChatQuestTarget)}x\nProgress: *${formatNumber(member.daily.chatCount)} / ${formatNumber(ctx.config.dailyChatQuestTarget)}*\nReward: +${formatNumber(ctx.config.dailyChatQuestPoint)} poin, +${formatNumber(ctx.config.dailyChatQuestXp)} XP\n\n⬜ Kirim testimoni foto/video\nReward: +${formatNumber(ctx.config.testimonialPointReward)} poin, +${formatNumber(ctx.config.testimonialXpReward)} XP\n\nCatatan: XP chat punya cooldown supaya tidak gampang difarming.`
  );
  return true;
}

async function rankCommand(ctx) {
  const limit = Math.min(20, Math.max(3, Number(argsToNumber(ctx.args, 0) || 10)));
  const top = topMembers(ctx.db, limit);
  if (!top.length) {
    await ctx.reply('Belum ada member yang terdaftar.');
    return false;
  }

  const lines = top.map((member, index) => {
    return `${index + 1}. *${member.name}* — Lv.${member.level} | ${formatNumber(member.points)} poin | ${formatNumber(member.totalXp)} XP | ${formatNumber(member.testimonialCount || 0)} testimoni`;
  });

  await ctx.reply(`🏆 *Leaderboard Member*\n\n${lines.join('\n')}`);
  return true;
}

async function claimCommand(ctx) {
  const code = ctx.args[0];
  if (!code) {
    await ctx.reply(`Format: *${ctx.prefix}claim KODE*`);
    return false;
  }

  const result = claimVoucher(ctx.db, ctx.sender, ctx.pushName, code, ctx.config);
  if (!result.ok) {
    const message = {
      not_registered: `Kamu belum terdaftar. Ketik *${ctx.prefix}daftar Nama Kamu* dulu.`,
      not_found: 'Kode voucher tidak ditemukan.',
      already_claimed: 'Kamu sudah pernah claim voucher ini.',
      empty: 'Stock voucher sudah habis.'
    }[result.reason] || 'Voucher gagal diclaim.';
    await ctx.reply(message);
    return false;
  }

  await ctx.reply(
    `🎁 *Voucher berhasil diclaim!*\n\nKode: *${result.voucher.code}*\nReward: +${formatNumber(result.voucher.points)} poin${result.voucher.xp ? `, +${formatNumber(result.voucher.xp)} XP` : ''}\nSisa stock: *${formatNumber(result.voucher.stock - result.voucher.claimed.length)}*`
  );
  return true;
}

async function shopCommand(ctx) {
  await ctx.reply(
    `🛒 *Reward Shop*\n\n${rewardListText()}\n\nCara beli:\n*${ctx.prefix}beli ID_REWARD*\n\nContoh:\n*${ctx.prefix}beli voucher-diskon*`
  );
  return true;
}

async function buyCommand(ctx) {
  const member = getMember(ctx.db, ctx.sender, ctx.pushName);
  if (!member.registered) {
    await ctx.reply(`Kamu belum terdaftar. Ketik *${ctx.prefix}daftar Nama Kamu* dulu.`);
    return false;
  }

  const rewardId = ctx.args[0];
  const reward = findReward(rewardId);
  if (!reward) {
    await ctx.reply(`Reward tidak ditemukan. Ketik *${ctx.prefix}shop* untuk melihat daftar reward.`);
    return false;
  }

  if (member.points < reward.price) {
    await ctx.reply(`Poin kamu belum cukup.\n\nButuh: *${formatNumber(reward.price)} poin*\nPoin kamu: *${formatNumber(member.points)} poin*`);
    return false;
  }

  addPoints(member, -reward.price);
  const redemption = createRedemption(ctx.db, member, reward);

  await ctx.reply(
    `✅ *Redeem berhasil dibuat!*\n\nID: *${redemption.id}*\nReward: *${reward.name}*\nStatus: *pending*\n\nOwner perlu memproses reward ini secara manual.`
  );

  const ownerJid = toJid(ctx.config.ownerNumber);
  if (ownerJid) {
    await ctx.client.sendText(jidToNumber(ownerJid), `🔔 *Redeem baru*\n\nID: *${redemption.id}*\nMember: ${member.name} (${mentionTag(member.jid)})\nReward: *${reward.name}*\nCost: *${formatNumber(reward.price)} poin*\n\nKetik *${ctx.prefix}done ${redemption.id}* setelah diproses.`).catch(() => {});
  }

  return true;
}

async function transferCommand(ctx) {
  const senderMember = getMember(ctx.db, ctx.sender, ctx.pushName);
  if (!senderMember.registered) {
    await ctx.reply(`Kamu belum terdaftar. Ketik *${ctx.prefix}daftar Nama Kamu* dulu.`);
    return false;
  }

  const targetJid = getTargetJid(ctx);
  const amount = argsToNumber(ctx.args);

  if (!targetJid || !amount) {
    await ctx.reply(`Format: *${ctx.prefix}transfer @user jumlah*`);
    return false;
  }

  if (sameUser(targetJid, ctx.sender)) {
    await ctx.reply('Tidak bisa transfer ke diri sendiri.');
    return false;
  }

  if (amount < 1) {
    await ctx.reply('Jumlah transfer minimal 1 poin.');
    return false;
  }

  const targetMember = getMember(ctx.db, targetJid, 'Member');
  if (!targetMember.registered) {
    await ctx.reply('Target belum terdaftar sebagai member.');
    return false;
  }

  if (senderMember.points < amount) {
    await ctx.reply(`Poin kamu tidak cukup. Poin kamu sekarang: *${formatNumber(senderMember.points)}*`);
    return false;
  }

  addPoints(senderMember, -amount);
  addPoints(targetMember, amount);

  await ctx.reply(
    `✅ Transfer berhasil.\n\n${mentionTag(ctx.sender)} mengirim *${formatNumber(amount)} poin* ke ${mentionTag(targetJid)}.`,
    { mentions: [ctx.sender, targetJid] }
  );
  return true;
}

async function ownerPointCommand(ctx, mode) {
  if (!(await requireOwner(ctx))) return false;
  const targetJid = getTargetJid(ctx);
  const amount = argsToNumber(ctx.args);

  if (!targetJid || !amount) {
    await ctx.reply(`Format: *${ctx.prefix}${mode === 'add' ? 'addpoint' : 'minpoint'} @user jumlah*`);
    return false;
  }

  const member = getMember(ctx.db, targetJid, 'Member');
  const delta = mode === 'add' ? amount : -amount;
  addPoints(member, delta);

  await ctx.reply(
    `✅ Poin ${mode === 'add' ? 'ditambahkan' : 'dikurangi'}.\n\nMember: ${mentionTag(targetJid)}\nPerubahan: *${formatNumber(delta)}*\nPoin sekarang: *${formatNumber(member.points)}*`,
    { mentions: [targetJid] }
  );
  return true;
}

async function ownerXpCommand(ctx) {
  if (!(await requireOwner(ctx))) return false;
  const targetJid = getTargetJid(ctx);
  const amount = argsToNumber(ctx.args);

  if (!targetJid || !amount) {
    await ctx.reply(`Format: *${ctx.prefix}addxp @user jumlah*`);
    return false;
  }

  const member = getMember(ctx.db, targetJid, 'Member');
  const xp = addXp(member, amount, ctx.config);

  await ctx.reply(
    `✅ XP ditambahkan.\n\nMember: ${mentionTag(targetJid)}\n+${formatNumber(amount)} XP\nLevel sekarang: *${member.level}*${xp.levelUp ? `\n✨ Naik ${xp.levelUp} level.` : ''}`,
    { mentions: [targetJid] }
  );
  return true;
}

async function ownerVoucherCommand(ctx) {
  if (!(await requireOwner(ctx))) return false;
  const [code, pointsRaw, stockRaw, ...descParts] = ctx.args;
  const points = Number(pointsRaw);
  const stock = Number(stockRaw || 1);
  const desc = descParts.join(' ') || 'Voucher member';

  if (!code || !Number.isFinite(points) || points < 1) {
    await ctx.reply(`Format: *${ctx.prefix}addvoucher KODE poin stok deskripsi*\nContoh: *${ctx.prefix}addvoucher POKO50 50 20 Bonus launching*`);
    return false;
  }

  const voucher = addVoucher(ctx.db, { code, points, stock, desc });
  await ctx.reply(
    `✅ Voucher dibuat.\n\nKode: *${voucher.code}*\nReward: *${formatNumber(voucher.points)} poin*\nStock: *${formatNumber(voucher.stock)}*\nDeskripsi: ${voucher.desc}`
  );
  return true;
}

async function ownerDeleteVoucherCommand(ctx) {
  if (!(await requireOwner(ctx))) return false;
  const code = String(ctx.args[0] || '').toUpperCase();
  if (!code) {
    await ctx.reply(`Format: *${ctx.prefix}delvoucher KODE*`);
    return false;
  }
  if (!ctx.db.vouchers[code]) {
    await ctx.reply('Voucher tidak ditemukan.');
    return false;
  }
  delete ctx.db.vouchers[code];
  await ctx.reply(`✅ Voucher *${code}* dihapus.`);
  return true;
}

async function ownerMemberListCommand(ctx) {
  if (!(await requireOwner(ctx))) return false;
  const members = topMembers(ctx.db, 30);
  if (!members.length) {
    await ctx.reply('Belum ada member terdaftar.');
    return false;
  }

  const lines = members.map((member, index) => {
    const username = member.account?.username ? `@${member.account.username}` : '-';
    return `${index + 1}. ${member.name} (${jidToNumber(member.jid)}) — ${username} — Lv.${member.level}, ${formatNumber(member.points)} poin, ${formatNumber(getTestimonialsByMember(ctx.db, member.jid).length)} testimoni`;
  });

  await ctx.reply(`👥 *Daftar Member*\n\n${lines.join('\n')}`);
  return true;
}

async function ownerPendingCommand(ctx) {
  if (!(await requireOwner(ctx))) return false;
  const pending = ctx.db.redemptions.filter((item) => item.status === 'pending').slice(0, 20);
  if (!pending.length) {
    await ctx.reply('Tidak ada redeem pending.');
    return true;
  }

  const lines = pending.map((item, index) => {
    return `${index + 1}. *${item.id}*\n   ${item.name} — ${item.rewardName} — ${formatNumber(item.cost)} poin`;
  });

  await ctx.reply(`🧾 *Redeem Pending*\n\n${lines.join('\n\n')}\n\nGunakan:\n*${ctx.prefix}done ID*\natau\n*${ctx.prefix}cancel ID*`);
  return true;
}

async function ownerRedemptionStatusCommand(ctx, status) {
  if (!(await requireOwner(ctx))) return false;
  const id = ctx.args[0];
  if (!id) {
    await ctx.reply(`Format: *${ctx.prefix}${status === 'done' ? 'done' : 'cancel'} ID*`);
    return false;
  }

  const redemption = updateRedemption(ctx.db, id, status);
  if (!redemption) {
    await ctx.reply('ID redeem tidak ditemukan.');
    return false;
  }

  if (status === 'cancelled') {
    const member = getMember(ctx.db, redemption.jid, redemption.name);
    addPoints(member, redemption.cost);
  }

  await ctx.reply(`✅ Redeem *${redemption.id}* diubah menjadi *${status}*.`);
  await ctx.client.sendText(jidToNumber(redemption.jid), status === 'done'
    ? `✅ Reward kamu sudah diproses.\n\nID: *${redemption.id}*\nReward: *${redemption.rewardName}*`
    : `↩️ Redeem kamu dibatalkan dan poin sudah dikembalikan.\n\nID: *${redemption.id}*\nReward: *${redemption.rewardName}*`
  ).catch(() => {});
  return true;
}

async function requireOwner(ctx) {
  if (ctx.isOwner) return true;
  await ctx.reply('Command ini hanya untuk owner bot.');
  return false;
}

function getTestimonialMedia(event) {
  const media = event?.media;
  if (!media?.id) return null;
  if (!['image', 'video'].includes(media.kind)) return null;
  return media;
}

function getTargetJid(ctx) {
  if (ctx.mentioned?.length) return ctx.mentioned[0];
  if (ctx.quotedSender) return ctx.quotedSender;

  const firstCandidate = ctx.args.find((arg) => /(@?\d{8,20}|\d{8,20}@s\.whatsapp\.net)/.test(arg));
  if (!firstCandidate) return '';
  return toJid(firstCandidate);
}

function argsToNumber(args = [], fallbackIndex = null) {
  const parseToken = (arg, index) => {
    const token = String(arg || '').trim();
    if (!token) return 0;
    if (token.includes('@') || token.includes('@s.whatsapp.net')) return 0;

    const digits = token.replace(/[^0-9]/g, '');
    if (!digits) return 0;

    // Token angka panjang di awal biasanya nomor WhatsApp, bukan nominal poin.
    if (index === 0 && args.length > 1 && digits.length >= 8) return 0;

    const num = Number(digits);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : 0;
  };

  if (fallbackIndex !== null && args[fallbackIndex] !== undefined) {
    return parseToken(args[fallbackIndex], fallbackIndex);
  }

  for (let i = 0; i < args.length; i++) {
    const num = parseToken(args[i], i);
    if (num) return num;
  }
  return 0;
}
