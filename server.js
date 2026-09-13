import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import mime from 'mime-types';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

import { initDatabase, saveMessage, getRecentMessages, getLatestMedia, updateRepliedStatus, getUnrepliedMessages, upsertChromaMessage, upsertChromaDay, upsertDailyDigest, upsertGraphEdge, getGraph, dayKey } from './storage/database.js';
import { startWhatsApp, getSocket, sendMedia, extractMessageText, extractMessageType, getExtensionByType, tryDownloadMedia, isMediaType } from './connection/whatsapp.js';
import { generateAutoReply } from './answerGenerator.js';
import { classifyMessage } from './classifier.js';
import { searchMemory, embedText } from './memorySearch.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const mongoUrl = process.env.MONGO_URL;
const chromaUrl = process.env.CHROMA_URL;
const downloadsPath = process.env.DOWNLOADS_PATH;
const authFolder = process.env.WHATSAPP_AUTH_PATH;
const serverPort = process.env.SERVER_PORT;
const embeddingUrl = process.env.EMBEDDING_URL;
const autoReplyEnabled = process.env.AUTO_REPLY === 'true';
const apiToken = process.env.API_TOKEN;
if (!apiToken) console.warn('⚠️ API_TOKEN is not set — protected endpoints will reject every request');

[downloadsPath, authFolder].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Mongo & Chroma setup
await initDatabase(mongoUrl, chromaUrl);

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

    const senderFolder = path.join(downloadsPath, jid.replace('@s.whatsapp.net', ''));
    if (!fs.existsSync(senderFolder)) fs.mkdirSync(senderFolder, { recursive: true });

    const isMedia = isMediaType(messageType);
    const extension = getExtensionByType(messageType, msg.message[messageType]);
    const fileName = `${messageId}.${extension}`;
    const filePath = path.join(senderFolder, fileName);

    // Classify first (zero-cost): subject, info type and entities for the graph
    const { subject, infoType, entities } = classifyMessage(messageContent !== 'No text' ? messageContent : '');
    const day = dayKey(new Date(Number(timestamp) * 1000));

    const savedId = await saveMessage({
      jid,
      messageContent,
      timestamp,
      messageId,
      messageType,
      subject,
      infoType,
      entities,
      media: isMedia ? { filePath, fileName } : null
    });

    const ref = savedId.toString();

    // Graph edges, built purely from metadata (no LLM calls)
    await upsertGraphEdge({ from: jid, edge: 'sent', to: subject, ref });
    const mentioned = [
      ...(entities?.phones || []),
      ...(entities?.emails || []),
      ...(entities?.urls || [])
    ];
    for (const target of new Set(mentioned)) {
      await upsertGraphEdge({ from: jid, edge: 'mentions', to: target, ref });
    }

    // Two-level vector index: the message itself + its per-day digest
    let embedding = null;
    try {
      embedding = await embedText(messageContent !== 'No text' ? messageContent : `[media] ${messageType}`);
    } catch (err) {
      console.error('❌ Embedding failed:', err.message);
    }

    if (embedding) {
      await upsertChromaMessage(messageId, messageContent, embedding, {
        sender: jid, subject, info_type: infoType, day, ref
      });

      // Coarse level: refresh the day-digest embedding periodically
      const digest = await upsertDailyDigest({
        key: `${jid}|${day}`,
        sender: jid,
        day,
        subject,
        text: `${messageType === 'text' ? '' : `[${messageType}] `}${messageContent}`
      });
      const embedEvery = Math.max(1, parseInt(process.env.DIGEST_EMBED_EVERY || '5', 10));
      if (digest && digest.count % embedEvery === 1) {
        try {
          const digestText = (digest.texts || []).slice(-40).join('\n');
          const digestEmbedding = await embedText(digestText);
          await upsertChromaDay(`day:${jid}:${day}`, digestText, digestEmbedding, {
            sender: jid, day, subjects: digest.subjects || [subject]
          });
        } catch (err) {
          console.error('❌ Digest embedding failed:', err.message);
        }
      }
    }

    // Auto reply if enabled
    if (autoReplyEnabled && messageContent && messageContent !== 'No text') {
        try {
            const { context } = await searchMemory(messageContent, { sender: jid });
            const replyText = await generateAutoReply(messageContent, context);
            await getSocket().sendMessage(jid, { text: replyText });
            await updateRepliedStatus(savedId);
            console.log(`🤖 Auto-replied to ${jid}`);
        } catch (err) {
            console.error('❌ Auto-reply failed:', err.message);
        }
    }

    const activeSock = getSocket();
    await tryDownloadMedia(msg, downloadsPath, activeSock.logger, activeSock.updateMediaMessage);
  }
});

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

app.get('/api/get-messages', authMiddleware, async (_, res) => {
  const messages = await getRecentMessages();
  res.json(messages);
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

app.get('/api/graph', authMiddleware, async (req, res) => {
  try {
    const maxEdges = parseInt(req.query.maxEdges || '300', 10);
    res.json(await getGraph(Number.isFinite(maxEdges) ? Math.min(Math.max(maxEdges, 1), 1000) : 300));
  } catch (err) {
    res.status(500).json({ error: 'Failed to build graph', details: err.message });
  }
});

app.post('/api/trigger-reply', authMiddleware, async (req, res) => {
  const { fromList } = req.body;
  if (!Array.isArray(fromList) || fromList.length === 0) return res.status(400).json({ error: '`fromList` must be a non-empty array of user JIDs' });

  const sock = getSocket();
  if (!sock?.user) return res.status(503).json({ error: 'WhatsApp socket not connected' });

  let totalReplied = 0;

  try {
    for (const from of fromList) {
      const messages = await getUnrepliedMessages(from);
      for (const msg of messages) {
        const replyText = await generateAutoReply(msg.messageContent);
        await sock.sendMessage(msg.sender, { text: replyText });
        await updateRepliedStatus(msg._id);
        totalReplied++;
      }
    }
  } catch (err) {
    return res.status(500).json({ error: 'trigger-reply failed', details: err.message, totalReplied });
  }

  res.json({ status: 'replied_to_multiple_users', totalReplied });
});

app.listen(serverPort, () => {
  console.log(`🚀 MCP server running at http://localhost:${serverPort}/api/health`);
});
