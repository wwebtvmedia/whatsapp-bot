// 📁 connection/whatsapp.js
import * as baileys from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import path from 'path';
import fs from 'fs';
import { useMultiFileAuthState, fetchLatestBaileysVersion, makeWASocket, downloadMediaMessage, DisconnectReason } from '@whiskeysockets/baileys';

let sock = null;

export async function startWhatsApp(authFolder, onMessage) {
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    browser: ['Ubuntu', 'Chrome', '22.04']
  });

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startWhatsApp(authFolder, onMessage);
    }
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('messages.upsert', onMessage);

  return sock;
}

export async function sendMedia(sock, number, mediaBuffer, mimetype, filename = 'file') {
  const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
  return sock.sendMessage(jid, {
    document: mediaBuffer,
    mimetype,
    fileName: filename,
  });
}

export async function tryDownloadMedia(msg, downloadsPath, logger, reuploadRequest) {
  const type = extractMessageType(msg.message);
  const media = msg.message[type];
  if (!['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage'].includes(type)) return;

  const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest });
  const senderFolder = path.join(downloadsPath, msg.key.remoteJid.replace('@s.whatsapp.net', ''));
  const extension = getExtensionByType(type, media);
  const filePath = path.join(senderFolder, `${msg.key.id}.${extension}`);

  fs.writeFileSync(filePath, buffer);
}

export function extractMessageText(message) {
  return message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.documentMessage?.caption ||
    message.videoMessage?.caption ||
    'No text';
}

export function extractMessageType(message) {
  const mediaTypes = ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage'];
  return Object.keys(message).find(type => mediaTypes.includes(type)) || 'text';
}

export function getExtensionByType(type, mediaMsg = {}) {
  switch (type) {
    case 'imageMessage': return 'jpg';
    case 'videoMessage': return 'mp4';
    case 'audioMessage': return 'mp3';
    case 'stickerMessage': return 'webp';
    case 'documentMessage': return mediaMsg?.fileName?.split('.').pop() || 'pdf';
    default: return 'bin';
  }
}
