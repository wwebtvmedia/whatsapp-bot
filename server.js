import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import mime from 'mime-types';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { ObjectId } from 'mongodb';

import { initDatabase, saveMessage, getRecentMessages, getLatestMedia, updateRepliedStatus, getUnrepliedMessages, getDailyDigests, upsertChromaMessage, upsertChromaDay, upsertDailyDigest, upsertGraphEdge, getGraph, dayKey, setMediaExtracted, getContactSettings, setContactAutoReply, getContactsWithActivity, saveProposedReply, getRecentProposedReplies, claimProposedReply, markProposedReplySent, markProposedReplyFailed, saveLog, getRecentLogs, getIndexedDocuments, getChannels, addChannel, removeChannel, markChannelBackfilled, messageIdExists } from './storage/database.js';
import { startWhatsApp, getSocket, sendMedia, extractMessageText, extractMessageType, getExtensionByType, tryDownloadMedia, isMediaType } from './connection/whatsapp.js';
import { normalizeMessageContent, isJidNewsletter } from '@whiskeysockets/baileys';
import { generateAutoReply } from './answerGenerator.js';
import { classifyMessage } from './classifier.js';
import { searchMemory, searchDocuments, embedText, indexDocumentChunks } from './memorySearch.js';
import { writeExtractedTextFile } from './mediaText.js';
import { startMailListener, sendMail } from './MailConnection.js';
import { fetchNewsletterHistory, resolveChannelJid } from './connection/whatsapp.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const mongoUrl = process.env.MONGO_URL;
const chromaUrl = process.env.CHROMA_URL;
const downloadsPath = process.env.DOWNLOADS_PATH;
const authFolder = process.env.WHATSAPP_AUTH_PATH;
const serverPort = process.env.SERVER_PORT;
// Auto-reply is now per contact (contact_settings collection), toggled from the
// web panel — the old AUTO_REPLY env var no longer does anything.
if (process.env.AUTO_REPLY) console.warn('⚠️ AUTO_REPLY is ignored — auto-reply is now per contact, enabled from the web panel');
const mailEnabled = process.env.MAIL_ENABLED === 'true';
// Document indexing (PDF/docx/text extraction, optional OCR) — on by default
const mediaIndexingEnabled = process.env.MEDIA_INDEXING !== 'false';
const apiToken = process.env.API_TOKEN;
if (!apiToken) console.warn('⚠️ API_TOKEN is not set — protected endpoints will reject every request');

[downloadsPath, authFolder].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Mongo & Chroma setup
await initDatabase(mongoUrl, chromaUrl);

// Shared ingestion pipeline: classify → Mongo → graph → embeddings → Chroma.
// Used for both WhatsApp messages and emails (unified message schema).
async function ingestMessage({ sender, messageContent, timestamp, messageId, messageType, media = null }) {
  const text = messageContent !== 'No text' ? messageContent : '';
  const { subject, infoType, entities } = classifyMessage(text);
  const day = dayKey(timestamp instanceof Date ? timestamp : new Date(Number(timestamp) * 1000));

  const savedId = await saveMessage({
    sender,
    messageContent,
    timestamp,
    messageId,
    messageType,
    subject,
    infoType,
    entities,
    media
  });

  const ref = savedId.toString();

  // Graph edges, built purely from metadata (no LLM calls)
  await upsertGraphEdge({ from: sender, edge: 'sent', to: subject, ref });
  const mentioned = [
    ...(entities?.phones || []),
    ...(entities?.emails || []),
    ...(entities?.urls || [])
  ];
  for (const target of new Set(mentioned)) {
    await upsertGraphEdge({ from: sender, edge: 'mentions', to: target, ref });
  }

  // Two-level vector index: the message itself + its per-day digest
  let embedding = null;
  try {
    embedding = await embedText(text || `[media] ${messageType}`);
  } catch (err) {
    console.error('❌ Embedding failed:', err.message);
  }

  if (embedding) {
    await upsertChromaMessage(messageId, messageContent, embedding, {
      sender, subject, info_type: infoType, day, ref
    });

    // Coarse level: refresh the day-digest embedding periodically
    const digest = await upsertDailyDigest({
      key: `${sender}|${day}`,
      sender,
      day,
      subject,
      text: `${messageType === 'text' ? '' : `[${messageType}] `}${messageContent}`
    });
    const embedEvery = Math.max(1, parseInt(process.env.DIGEST_EMBED_EVERY || '5', 10));
    if (digest && digest.count % embedEvery === 1) {
      try {
        const digestText = (digest.texts || []).slice(-40).join('\n');
        const digestEmbedding = await embedText(digestText);
        await upsertChromaDay(`day:${sender}:${day}`, digestText, digestEmbedding, {
          sender, day, subjects: digest.subjects || [subject]
        });
      } catch (err) {
        console.error('❌ Digest embedding failed:', err.message);
      }
    }
  }

  return { savedId, day, subject };
}

// One reply pipeline for everything: per-contact gate → memory → LLM → send or
// propose. A contact with auto-reply off (the default) gets their reply stored
// as a proposal for the panel instead of being messaged. Never throws.
async function generateReplyFor({ sender, savedId, incoming, force = false }) {
  if (!incoming || incoming === 'No text') return null;
  try {
    const settings = await getContactSettings(sender);
    const { context, refs } = await searchMemory(incoming, { sender });
    const replyText = await generateAutoReply(incoming, context);

    // generateAutoReply swallows LLM failures into a ⚠️ sentinel — nothing worth
    // proposing or sending in that case
    if (replyText.startsWith('⚠️')) {
      await saveLog('reply.failed', { level: 'error', sender, detail: replyText });
      return null;
    }

    if (!settings.autoReply && !force) {
      await saveProposedReply({ sender, messageRef: savedId.toString(), incoming, reply: replyText, refs });
      await saveLog('reply.proposed', { sender, detail: replyText.slice(0, 120) });
      return { proposed: true };
    }

    const sock = getSocket();
    if (!sock?.user) {
      await saveLog('reply.skipped_offline', { level: 'warn', sender });
      return null;
    }
    const sent = await sock.sendMessage(sender, { text: replyText });
    await updateRepliedStatus(savedId);
    await saveProposedReply({ sender, messageRef: savedId.toString(), incoming, reply: replyText, refs, status: 'sent', whatsappId: sent?.key?.id });
    await saveLog('autoreply.sent', { sender, detail: replyText.slice(0, 120) });
    return { sent: true };
  } catch (err) {
    console.error('❌ Reply pipeline failed:', err.message);
    await saveLog('reply.error', { level: 'error', sender, detail: err.message });
    return null;
  }
}

// Core per-message ingestion: save → reply pipeline → media download →
// document indexing. Shared by normal chats, WhatsApp channels (newsletters)
// and the self-chat, which all produce WAMessage-shaped objects.
async function ingestWhatsAppMessage(msg, { runReplyPipeline = true } = {}) {
  const jid = msg.key.remoteJid;
  const messageId = msg.key.id;
  const timestamp = msg.messageTimestamp;

  const content = normalizeMessageContent(msg.message) || {};
  const messageType = extractMessageType(content);
  const messageContent = extractMessageText(content);

  console.log(`📩 Received message from ${jid}: ${messageContent}`);
  saveLog('message.received', { sender: jid, detail: messageContent.slice(0, 120) });

  const senderFolder = path.join(downloadsPath, jid.replace('@s.whatsapp.net', ''));
  if (!fs.existsSync(senderFolder)) fs.mkdirSync(senderFolder, { recursive: true });

  const isMedia = isMediaType(messageType);
  const extension = getExtensionByType(messageType, content[messageType]);
  const fileName = `${messageId}.${extension}`;
  const filePath = path.join(senderFolder, fileName);

  const { savedId, day, subject } = await ingestMessage({
    sender: jid,
    messageContent,
    timestamp,
    messageId,
    messageType,
    media: isMedia ? { filePath, fileName } : null
  });

  // Auto-reply (if the contact opted in) or a proposal for the panel. Not
  // awaited on purpose: the LLM latency must not delay media download and
  // document indexing below. Channels and the self-chat never get replies.
  if (runReplyPipeline) {
    void generateReplyFor({ sender: jid, savedId, incoming: messageContent })
      .catch(err => console.error('❌ Reply pipeline failed:', err.message));
  }

  const activeSock = getSocket();
  const mediaPath = await tryDownloadMedia(msg, downloadsPath, activeSock.logger, activeSock.updateMediaMessage);

  // Index the document's content so questions about it are answerable
  if (mediaPath && mediaIndexingEnabled) {
    try {
      const result = await indexDocumentChunks({
        messageId, sender: jid, day, ref: savedId.toString(), subject,
        filePath: mediaPath,
        fileName: path.basename(mediaPath)
      });
      await setMediaExtracted(savedId, { text: result.text, chunks: result.indexed });
      const txtPath = writeExtractedTextFile(mediaPath, result.text, result.kind);
      if (txtPath) console.log(`📝 Extracted text saved: ${path.basename(txtPath)}`);
      if (result.indexed > 0) console.log(`📄 Document indexed: ${result.indexed} chunk(s) [${result.kind}]`);
      else console.log(`📄 No text extracted from ${path.basename(mediaPath)} [${result.kind}]`);
    } catch (err) {
      console.error('❌ Document indexing failed:', err.message);
    }
  }
}

// The "message yourself" chat arrives with fromMe=true and the own JID as
// remoteJid — indexing it lets the owner feed documents to the bot directly.
function isOwnJid(jid) {
  const own = getSocket()?.user?.id?.split(':')[0];
  return Boolean(own && jid?.startsWith(`${own}@`));
}

// Channels: follow + subscribe to live updates (the subscription expires
// server-side, so this re-runs on every reconnect), then backfill so anything
// published while offline — or the whole existing archive — still gets
// indexed. Heavy ingestion runs sequentially and logs its progress.
async function backfillChannel(sock, channel, { maxMessages = 500 } = {}) {
  const messages = await fetchNewsletterHistory(sock, channel.jid, { maxMessages });
  let indexed = 0;
  for (const msg of messages) {
    if (!msg.message || await messageIdExists(msg.key.id)) continue;
    console.log(`📺 Backfilling channel ${channel.jid}: ${msg.key.id} (${indexed + 1}/${messages.length})`);
    await ingestWhatsAppMessage(msg, { runReplyPipeline: false });
    indexed++;
    if (indexed % 10 === 0) {
      saveLog('channel.backfill', { sender: channel.jid, detail: `${indexed}/${messages.length} message(s) indexed` });
    }
  }
  await markChannelBackfilled(channel.jid);
  if (indexed) saveLog('channel.backfill', { sender: channel.jid, detail: `${indexed} message(s) indexed (done)` });
  return { fetched: messages.length, indexed };
}

async function setupChannels(sock) {
  try {
    for (const channel of await getChannels()) {
      try {
        await sock.newsletterFollow(channel.jid).catch(() => {}); // already-following is fine
        await sock.subscribeNewsletterUpdates(channel.jid);
        await backfillChannel(sock, channel);
        console.log(`📺 Channel subscribed: ${channel.jid}`);
      } catch (err) {
        console.error(`❌ Channel setup failed for ${channel.jid}:`, err.message);
        saveLog('channel.error', { level: 'error', sender: channel.jid, detail: err.message });
      }
    }
  } catch (err) {
    console.error('❌ Channel setup failed:', err.message);
  }
}

// WhatsApp setup
await startWhatsApp(authFolder, async ({ messages, type }) => {
  for (const msg of messages) {
    const jid = msg.key.remoteJid;

    // Channel posts are delivered as 'append' upserts (plaintext, no session)
    if (isJidNewsletter(jid)) {
      if (msg.message) await ingestWhatsAppMessage(msg, { runReplyPipeline: false });
      continue;
    }
    if (type !== 'notify') continue;

    const isGroup = jid.endsWith('@g.us');
    // Status broadcasts are contacts' status updates, not conversation
    if (!msg.message || isGroup || jid.startsWith('status@') || jid.endsWith('@bot')) {
      // A personal message with no content is an undecryptable stub (broken
      // signal session — e.g. the sender reinstalled WhatsApp): logging it is
      // the only way to tell "delivery failed" from "we dropped it".
      if (!msg.message && !isGroup && !msg.key.fromMe && !jid.startsWith('status@') && !jid.endsWith('@bot')) {
        const detail = `stub ${msg.messageStubType ?? '?'}${msg.messageStubParameters?.length ? ` — ${msg.messageStubParameters.join(', ')}` : ''}`;
        console.log(`🔒 Undecryptable message from ${jid} (${detail})`);
        saveLog('message.undecryptable', { level: 'warn', sender: jid, detail });
      }
      continue;
    }

    // fromMe echoes cover everything the phone itself sends in any chat —
    // except the self-chat, which is the owner feeding documents to the bot
    if (msg.key.fromMe) {
      if (isOwnJid(jid)) await ingestWhatsAppMessage(msg, { runReplyPipeline: false });
      continue;
    }

    await ingestWhatsAppMessage(msg);
  }
}, setupChannels);

// Mail ingestion (opt-in: MAIL_ENABLED=true) — emails land in the same memory
if (mailEnabled) {
  if (!process.env.MAIL_USER || !process.env.MAIL_IMAP_HOST) {
    console.warn('⚠️ MAIL_ENABLED=true but MAIL_USER / MAIL_IMAP_HOST are missing — mail ingestion skipped');
  } else {
    startMailListener(async (mail) => {
      try {
        await ingestMessage({
          sender: mail.sender,
          messageContent: mail.messageContent,
          timestamp: mail.timestamp,
          messageId: mail.messageId,
          messageType: mail.messageType
        });
      } catch (err) {
        console.error('❌ Email ingestion failed:', err.message);
      }
    });
  }
}

// App version from package.json — surfaced via GET /api/version
const { version: appVersion } = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')
);

// Express API setup
const app = express();
const upload = multer();
app.use(express.json({
  // keep the raw body for the OSP endpoints: signature verification must
  // re-canonicalise the packet with each number literal's original form
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.static(path.join(__dirname, 'public')));

// Auth Middleware — fails closed: an unset API_TOKEN must never disable auth
const authMiddleware = (req, res, next) => {
  const token = req.headers['x-api-token'];
  if (!apiToken || token !== apiToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

app.get('/api/health', (_, res) => {
  const sock = getSocket();
  sock?.user
    ? res.json({ status: 'ok', user: sock.user })
    : res.status(500).json({ status: 'disconnected' });
});

// Runtime info, unauthenticated like /api/health: identifies which version a
// deployed instance runs from a plain curl (panel badge, ops checks)
app.get('/api/version', (_, res) => {
  res.json({
    version: appVersion,
    node: process.version,
    uptimeSeconds: Math.round(process.uptime()),
    whatsapp: getSocket()?.user ? 'connected' : 'disconnected'
  });
});

app.post('/api/send-message', authMiddleware, async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'Missing fields' });
  try {
    await getSocket().sendMessage(to, { text: message });
    res.json({ status: 'sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/send-media', authMiddleware, upload.single('file'), async (req, res) => {
  const { number } = req.body;
  const file = req.file;
  if (!number || !file) return res.status(400).json({ error: 'Missing file or number' });
  try {
    await sendMedia(getSocket(), number, file.buffer, file.mimetype, file.originalname);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/send-email', authMiddleware, async (req, res) => {
  const { to, subject, text, html } = req.body;
  if (!to || (!text && !html)) return res.status(400).json({ error: 'Missing "to" and "text"/"html" fields' });
  try {
    const info = await sendMail({ to, subject, text, html });
    res.json({ status: 'sent', messageId: info.messageId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send email', details: err.message });
  }
});

app.get('/api/get-messages', authMiddleware, async (req, res) => {
  const parsed = parseInt(req.query.limit || '20', 10);
  const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 20;
  const messages = await getRecentMessages(limit);
  res.json(messages);
});

app.get('/api/digests', authMiddleware, async (req, res) => {
  const parsed = parseInt(req.query.limit || '50', 10);
  const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50;
  res.json(await getDailyDigests(limit));
});

app.get('/api/get-media', authMiddleware, async (req, res) => {
  const after = req.query.after ? new Date(req.query.after) : null;
  if (after && isNaN(after)) return res.status(400).json({ error: 'Invalid `after` param' });

  const mediaDoc = await getLatestMedia(after);
  if (!mediaDoc) return res.status(404).json({ error: 'No media found' });

  if (!fs.existsSync(mediaDoc.media.filePath)) {
    return res.status(404).json({ error: 'Media file missing on disk' });
  }

  const mimeType = mime.lookup(mediaDoc.media.fileName) || 'application/octet-stream';
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(mediaDoc.media.fileName)}"`);
  fs.createReadStream(mediaDoc.media.filePath).pipe(res);
});

app.post('/api/query-memory', authMiddleware, async (req, res) => {
  const { text, sender } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing "text" field' });

  try {
    const result = await searchMemory(text, { sender: sender || null });
    res.json({ query: text, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Failed to query memory', details: err.message });
  }
});

// Full question → answer: retrieval + LLM, same pipeline as the WhatsApp auto-reply.
// scope:"documents" restricts retrieval to the indexed document chunks (the
// panel's RAG view); `doc` (media.fileName) narrows it further to one file.
app.post('/api/ask', authMiddleware, async (req, res) => {
  const { text, sender, scope, doc } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing "text" field' });

  try {
    const { context, refs, used } = scope === 'documents'
      ? await searchDocuments(text, { doc: doc || null })
      : await searchMemory(text, { sender: sender || null });
    const answer = await generateAutoReply(text, context);
    // context is included so retrieval quality (and OCR noise) is inspectable
    res.json({ question: text, answer, refs, used, context });
  } catch (err) {
    res.status(500).json({ error: 'Failed to answer', details: err.message });
  }
});

// Documents parsed and indexed into the RAG, newest first
app.get('/api/documents', authMiddleware, async (req, res) => {
  const parsed = parseInt(req.query.limit || '100', 10);
  const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 100;
  res.json(await getIndexedDocuments(limit));
});

// --- WhatsApp channels (newsletters): follow, list, unfollow ---

app.get('/api/channels', authMiddleware, async (_, res) => {
  res.json(await getChannels());
});

// Body: {"link": "https://whatsapp.com/channel/<code>"} or {"jid": "...@newsletter"}
// Follows the channel, subscribes to live updates and backfills existing posts
// (body "backfill": max messages to walk, default 500 — covers the archive).
app.post('/api/channels', authMiddleware, async (req, res) => {
  const { link, jid, name } = req.body;
  const entry = link || jid;
  if (!entry) return res.status(400).json({ error: 'Missing "link" or "jid" field' });
  const maxBackfill = Math.max(0, parseInt(req.body.backfill, 10) || 500);
  const sock = getSocket();
  if (!sock?.user) return res.status(503).json({ error: 'WhatsApp not connected' });

  try {
    const resolved = await resolveChannelJid(sock, entry);
    await sock.newsletterFollow(resolved).catch(() => {}); // already-following is fine
    await sock.subscribeNewsletterUpdates(resolved);
    const channel = await addChannel({ jid: resolved, name: name || '' });
    const backfill = await backfillChannel(sock, channel, { maxMessages: maxBackfill });
    console.log(`📺 Channel followed: ${resolved} (backfill: ${backfill.indexed} indexed / ${backfill.fetched} fetched)`);
    saveLog('channel.followed', { sender: resolved, detail: `${backfill.indexed} indexed` });
    res.json({ ...channel, backfill });
  } catch (err) {
    console.error('❌ Channel follow failed:', err.message);
    res.status(500).json({ error: 'Failed to follow channel', details: err.message });
  }
});

app.delete('/api/channels/:jid', authMiddleware, async (req, res) => {
  const removed = await removeChannel(decodeURIComponent(req.params.jid));
  if (!removed) return res.status(404).json({ error: 'Channel not found' });
  res.json({ removed: true });
});

app.get('/api/graph', authMiddleware, async (req, res) => {
  try {
    const maxEdges = parseInt(req.query.maxEdges || '300', 10);
    res.json(await getGraph(Number.isFinite(maxEdges) ? Math.min(Math.max(maxEdges, 1), 1000) : 300));
  } catch (err) {
    res.status(500).json({ error: 'Failed to build graph', details: err.message });
  }
});

app.post('/api/trigger-reply', authMiddleware, async (req, res) => {
  const { fromList, force } = req.body;
  if (!Array.isArray(fromList) || fromList.length === 0) return res.status(400).json({ error: '`fromList` must be a non-empty array of user JIDs' });

  const sock = getSocket();
  if (!sock?.user) return res.status(503).json({ error: 'WhatsApp socket not connected' });

  let totalReplied = 0;
  let totalProposed = 0;

  try {
    for (const from of fromList) {
      const messages = await getUnrepliedMessages(from);
      for (const msg of messages) {
        // Operator-initiated: respects the per-contact toggle unless force:true
        const result = await generateReplyFor({ sender: msg.sender, savedId: msg._id, incoming: msg.messageContent, force: force === true });
        if (result?.sent) totalReplied++;
        else if (result?.proposed) totalProposed++;
      }
    }
  } catch (err) {
    return res.status(500).json({ error: 'trigger-reply failed', details: err.message, totalReplied, totalProposed });
  }

  res.json({ status: 'replied_to_multiple_users', totalReplied, totalProposed });
});

// --- Per-contact auto-reply toggle, proposed replies, bot log ---

app.get('/api/contacts', authMiddleware, async (_, res) => {
  res.json(await getContactsWithActivity());
});

app.post('/api/contacts/auto-reply', authMiddleware, async (req, res) => {
  const { sender, enabled } = req.body;
  if (!sender || !String(sender).includes('@')) return res.status(400).json({ error: 'Missing or invalid "sender" (expected a JID)' });
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: '"enabled" must be a boolean' });
  try {
    res.json(await setContactAutoReply(sender, enabled));
  } catch (err) {
    res.status(500).json({ error: 'Failed to save contact setting', details: err.message });
  }
});

app.get('/api/proposed-replies', authMiddleware, async (req, res) => {
  const parsed = parseInt(req.query.limit || '25', 10);
  const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 25;
  res.json(await getRecentProposedReplies(limit));
});

// Send a proposed reply to its contact — the manual counterpart of auto-reply
app.post('/api/proposed-replies/:id/send', authMiddleware, async (req, res) => {
  let proposalId;
  try {
    proposalId = new ObjectId(req.params.id);
  } catch {
    return res.status(400).json({ error: 'Invalid proposal id' });
  }

  const sock = getSocket();
  if (!sock?.user) return res.status(503).json({ error: 'WhatsApp socket not connected' });

  // Atomic claim: a double-click or refresh race cannot send twice
  const proposal = await claimProposedReply(proposalId);
  if (!proposal) return res.status(409).json({ error: 'Proposal not found or already handled' });

  try {
    const sent = await Promise.race([
      sock.sendMessage(proposal.sender, { text: proposal.reply }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('send timed out')), 15000))
    ]);
    await markProposedReplySent(proposalId, { whatsappId: sent?.key?.id });
    await updateRepliedStatus(proposal.messageRef);
    await saveLog('reply.sent_manual', { sender: proposal.sender, detail: proposal.reply.slice(0, 120) });
    res.json({ status: 'sent', proposalId: req.params.id });
  } catch (err) {
    await markProposedReplyFailed(proposalId, err.message);
    await saveLog('reply.send_failed', { level: 'error', sender: proposal.sender, detail: err.message });
    res.status(502).json({ error: 'Failed to send proposal', details: err.message });
  }
});

app.get('/api/logs', authMiddleware, async (req, res) => {
  const parsed = parseInt(req.query.limit || '100', 10);
  const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 500) : 100;
  res.json(await getRecentLogs(limit));
});

// Omni-Swarm Protocol peer (opt-in): sealed-packet peering with the ospbridge
// app / other OSP nodes. Mounted under /osp only when OSP_ENABLE=1 so the
// stock bot surface is unchanged otherwise.
if (process.env.OSP_ENABLE === '1') {
  const { buildOspRouter } = await import('./osp/peer.mjs');
  app.use('/osp', await buildOspRouter(authMiddleware));
  console.log('🌐 OSP peer enabled under /osp (packets, query, endpoint.json)');
}

app.listen(serverPort, () => {
  console.log(`🚀 MCP server running at http://localhost:${serverPort}/api/health`);
});
