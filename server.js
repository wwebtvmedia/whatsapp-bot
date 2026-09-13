import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import mime from 'mime-types';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { ObjectId } from 'mongodb';

import { initDatabase, saveMessage, getRecentMessages, getLatestMedia, updateRepliedStatus, getUnrepliedMessages, getDailyDigests, upsertChromaMessage, upsertChromaDay, upsertDailyDigest, upsertGraphEdge, getGraph, dayKey, setMediaExtracted, getContactSettings, setContactAutoReply, getContactsWithActivity, saveProposedReply, getRecentProposedReplies, claimProposedReply, markProposedReplySent, markProposedReplyFailed, saveLog, getRecentLogs } from './storage/database.js';
import { startWhatsApp, getSocket, sendMedia, extractMessageText, extractMessageType, getExtensionByType, tryDownloadMedia, isMediaType } from './connection/whatsapp.js';
import { generateAutoReply } from './answerGenerator.js';
import { classifyMessage } from './classifier.js';
import { searchMemory, embedText, indexDocumentChunks } from './memorySearch.js';
import { startMailListener, sendMail } from './MailConnection.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const mongoUrl = process.env.MONGO_URL;
const chromaUrl = process.env.CHROMA_URL;
const downloadsPath = process.env.DOWNLOADS_PATH;
const authFolder = process.env.WHATSAPP_AUTH_PATH;
const serverPort = process.env.SERVER_PORT;
const embeddingUrl = process.env.EMBEDDING_URL;
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

// WhatsApp setup
await startWhatsApp(authFolder, async ({ messages, type }) => {
  if (type !== 'notify') return;

  for (const msg of messages) {
    const jid = msg.key.remoteJid;
    const isGroup = jid.endsWith('@g.us');
    if (!msg.message || isGroup || jid.endsWith('@bot') || msg.key.fromMe) continue;

    const messageId = msg.key.id;
    const timestamp = msg.messageTimestamp;

    const messageType = extractMessageType(msg.message);
    const messageContent = extractMessageText(msg.message);

    console.log(`📩 Received message from ${jid}: ${messageContent}`);
    saveLog('message.received', { sender: jid, detail: messageContent.slice(0, 120) });

    const senderFolder = path.join(downloadsPath, jid.replace('@s.whatsapp.net', ''));
    if (!fs.existsSync(senderFolder)) fs.mkdirSync(senderFolder, { recursive: true });

    const isMedia = isMediaType(messageType);
    const extension = getExtensionByType(messageType, msg.message[messageType]);
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
    // document indexing below.
    void generateReplyFor({ sender: jid, savedId, incoming: messageContent })
      .catch(err => console.error('❌ Reply pipeline failed:', err.message));

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
        if (result.indexed > 0) console.log(`📄 Document indexed: ${result.indexed} chunk(s) [${result.kind}]`);
        else console.log(`📄 No text extracted from ${path.basename(mediaPath)} [${result.kind}]`);
      } catch (err) {
        console.error('❌ Document indexing failed:', err.message);
      }
    }
  }
});

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

// Express API setup
const app = express();
const upload = multer();
app.use(express.json());
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

// Full question → answer: retrieval + LLM, same pipeline as the WhatsApp auto-reply
app.post('/api/ask', authMiddleware, async (req, res) => {
  const { text, sender } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing "text" field' });

  try {
    const { context, refs, used } = await searchMemory(text, { sender: sender || null });
    const answer = await generateAutoReply(text, context);
    res.json({ question: text, answer, refs, used });
  } catch (err) {
    res.status(500).json({ error: 'Failed to answer', details: err.message });
  }
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

app.listen(serverPort, () => {
  console.log(`🚀 MCP server running at http://localhost:${serverPort}/api/health`);
});
