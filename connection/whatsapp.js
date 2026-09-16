// 📁 connection/whatsapp.js
import * as baileys from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import path from 'path';
import fs from 'fs';
import { useMultiFileAuthState, fetchLatestBaileysVersion, makeWASocket, downloadMediaMessage, DisconnectReason, normalizeMessageContent } from '@whiskeysockets/baileys';
import { saveLog } from '../storage/database.js';

let sock = null;

// Always fetch the live socket through this helper: startWhatsApp() replaces the
// module-level socket on reconnect, so any kept reference would go stale.
export function getSocket() {
  return sock;
}

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
    if (qr) {
      qrcode.generate(qr, { small: true });
      saveLog('wa.qr');
    }
    if (connection === 'open') {
      saveLog('wa.connected', { user: sock.user?.id });
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      saveLog('wa.disconnected', {
        level: shouldReconnect ? 'warn' : 'error',
        reconnecting: shouldReconnect,
        code: lastDisconnect?.error?.output?.statusCode
      });
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

// Downloads the media of a message; returns the written file path (or null on
// failure) so the caller can index the document's content.
export async function tryDownloadMedia(msg, downloadsPath, logger, reuploadRequest) {
  const content = normalizeMessageContent(msg.message) || {};
  const type = extractMessageType(content);
  const media = content[type];
  if (!isMediaType(type)) return null;

  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest });
    const senderFolder = path.join(downloadsPath, msg.key.remoteJid.replace('@s.whatsapp.net', ''));
    const extension = getExtensionByType(type, media);
    const filePath = path.join(senderFolder, `${msg.key.id}.${extension}`);

    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch (err) {
    console.error('❌ Media download failed:', err.message);
    return null;
  }
}

// WhatsApp wraps messages in containers (viewOnceMessage, ephemeralMessage,
// documentWithCaptionMessage, …): a PDF sent normally arrives as
// `{viewOnceMessage: {message: {documentMessage: …}}}`. Baileys'
// normalizeMessageContent unwraps those layers — without it the document is
// seen as a plain "text" message and its media is silently dropped.
export function extractMessageText(rawMessage) {
  const message = normalizeMessageContent(rawMessage) || {};
  return message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.documentMessage?.caption ||
    message.videoMessage?.caption ||
    'No text';
}

export function extractMessageType(rawMessage) {
  const message = normalizeMessageContent(rawMessage) || {};
  return Object.keys(message).find(isMediaType) || 'text';
}

export function isMediaType(type) {
  return ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage'].includes(type);
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
