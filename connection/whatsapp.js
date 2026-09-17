// 📁 connection/whatsapp.js
import * as baileys from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import path from 'path';
import fs from 'fs';
import { useMultiFileAuthState, fetchLatestBaileysVersion, makeWASocket, downloadMediaMessage, DisconnectReason, normalizeMessageContent, proto } from '@whiskeysockets/baileys';
import { saveLog } from '../storage/database.js';

let sock = null;

// Always fetch the live socket through this helper: startWhatsApp() replaces the
// module-level socket on reconnect, so any kept reference would go stale.
export function getSocket() {
  return sock;
}

export async function startWhatsApp(authFolder, onMessage, onConnect) {
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
      // Fired on every (re)connect — used to re-subscribe to WhatsApp channels,
      // whose update subscriptions expire server-side
      if (onConnect) {
        onConnect(sock).catch(err => console.error('❌ onConnect handler failed:', err.message));
      }
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

// --- WhatsApp channels (newsletters) ---

// newsletterFetchMessages returns the raw iq node; turn the message children
// into WAMessage-like objects the normal pipeline can ingest (same plaintext
// decoding as Baileys' live newsletter notification handler).
export function parseNewsletterFetchResult(result, jid) {
  const updates = (result?.content || []).find(n => n.tag === 'message_updates');
  const out = [];
  for (const node of updates?.content || []) {
    if (node.tag !== 'message') continue;
    const plaintext = (node.content || []).find(c => c.tag === 'plaintext');
    if (!plaintext?.content) continue;
    try {
      const buf = typeof plaintext.content === 'string'
        ? Buffer.from(plaintext.content, 'binary')
        : Buffer.from(plaintext.content);
      out.push({
        key: { remoteJid: jid, id: node.attrs.message_id || node.attrs.server_id, fromMe: false },
        message: proto.Message.decode(buf),
        messageTimestamp: +(node.attrs.t || node.attrs.server_time || 0)
      });
    } catch {
      // skip malformed entries — the live notification path logs its own errors
    }
  }
  return out;
}

export async function fetchRecentNewsletterMessages(sock, jid, count = 10) {
  const result = await sock.newsletterFetchMessages(jid, count, undefined, undefined);
  return parseNewsletterFetchResult(result, jid);
}

// Walk a channel's whole message history with the server_id cursor, newest
// page first. Stops when a page brings nothing new (exhausted, or the cursor
// direction is unexpected) — dedupe by server_id keeps it safe either way.
export async function fetchNewsletterHistory(sock, jid, { maxMessages = 500, pageSize = 50 } = {}) {
  const seen = new Set();
  const out = [];
  let after;
  while (out.length < maxMessages) {
    const result = await sock.newsletterFetchMessages(jid, pageSize, undefined, after);
    const updates = (result?.content || []).find(n => n.tag === 'message_updates');
    const nodes = (updates?.content || []).filter(n => n.tag === 'message');
    if (!nodes.length) break;
    const before = out.length;
    for (const node of nodes) {
      const id = node.attrs.message_id || node.attrs.server_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const plaintext = (node.content || []).find(c => c.tag === 'plaintext');
      if (!plaintext?.content) continue;
      try {
        const buf = typeof plaintext.content === 'string'
          ? Buffer.from(plaintext.content, 'binary')
          : Buffer.from(plaintext.content);
        out.push({
          key: { remoteJid: jid, id, fromMe: false },
          message: proto.Message.decode(buf),
          messageTimestamp: +(node.attrs.t || node.attrs.server_time || 0)
        });
      } catch {
        // skip malformed entries
      }
    }
    if (out.length === before) break; // page fully duplicate/empty → done
    if (nodes.length < pageSize) break; // last page reached
    const cursor = parseInt(nodes[nodes.length - 1]?.attrs?.server_id, 10);
    if (!Number.isFinite(cursor) || cursor === after) break;
    after = cursor;
  }
  return out;
}

// Accepts an @newsletter jid or an invite link (https://whatsapp.com/channel/<code>)
export async function resolveChannelJid(sock, entry) {
  if (entry.endsWith('@newsletter')) return entry;
  const match = entry.match(/whatsapp\.com\/channel\/([\w-]+)/);
  if (!match) throw new Error(`Not a channel link or jid: ${entry}`);
  const meta = await sock.newsletterMetadata('invite', match[1]);
  if (!meta?.id) throw new Error(`Could not resolve channel link: ${entry}`);
  return meta.id;
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
