import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import mime from 'mime-types';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

import { initDatabase, saveMessage, getRecentMessages, getLatestMedia, updateRepliedStatus, getUnrepliedMessages, insertIntoChroma } from './storage/database.js';
import { startWhatsApp, sendMedia, extractMessageText, extractMessageType, getExtensionByType, tryDownloadMedia } from './connection/whatsapp.js';
import { generateAutoReply } from './answerGenerator.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const mongoUrl = process.env.MONGO_URL;
const chromaUrl = process.env.CHROMA_URL;
const downloadsPath = process.env.DOWNLOADS_PATH;
const authFolder = process.env.WHATSAPP_AUTH_PATH;
const serverPort = process.env.SERVER_PORT;
const embeddingUrl = process.env.EMBEDDING_URL;
const apiToken = process.env.API_TOKEN || 'my-strong-secret-token';

[downloadsPath, authFolder].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Mongo & Chroma setup
const { messageCollection, chromaCollection } = await initDatabase(mongoUrl, chromaUrl);

// WhatsApp setup
let sock = await startWhatsApp(authFolder, async ({ messages, type }) => {
  if (type !== 'notify') return;

  for (const msg of messages) {
    const jid = msg.key.remoteJid;
    const isGroup = jid.endsWith('@g.us');
    if (!msg.message || isGroup || jid.endsWith('@bot')) continue;

    const messageId = msg.key.id;
    const timestamp = msg.messageTimestamp;

    const messageType = extractMessageType(msg.message);
    const messageContent = extractMessageText(msg.message);

    console.log(`📩 Received message from ${jid}: ${messageContent}`);

    const senderFolder = path.join(downloadsPath, jid.replace('@s.whatsapp.net', ''));
    if (!fs.existsSync(senderFolder)) fs.mkdirSync(senderFolder, { recursive: true });

    const extension = getExtensionByType(messageType, msg.message[messageType]);
    const fileName = `${messageId}.${extension}`;
    const filePath = path.join(senderFolder, fileName);

    let embedding = null;
    try {
      const response = await fetch(embeddingUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: [messageContent] })
      });
      if (response.ok) {
        const data = await response.json();
        embedding = data.embeddings?.[0];
      }
    } catch (err) {
      console.error('❌ Embedding failed:', err.message);
    }

    await saveMessage({ 
      jid, 
      messageContent, 
      timestamp, 
      messageId, 
      messageType, 
      media: { filePath, fileName },
      embedding
    });

    if (embedding) {
      await insertIntoChroma(messageId, messageContent, embedding, { from: jid });
    }

    await tryDownloadMedia(msg, downloadsPath, sock.logger, sock.updateMediaMessage);
  }
});

// Express API setup
const app = express();
const upload = multer();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Auth Middleware
const authMiddleware = (req, res, next) => {
  const token = req.headers['x-api-token'];
  if (token !== apiToken) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

app.get('/api/health', (_, res) => {
  sock?.user
    ? res.json({ status: 'ok', user: sock.user })
    : res.status(500).json({ status: 'disconnected' });
});

app.post('/api/send-message', authMiddleware, async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'Missing fields' });
  try {
    await sock.sendMessage(to, { text: message });
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
    await sendMedia(sock, number, file.buffer, file.mimetype, file.originalname);
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

  const mimeType = mime.lookup(mediaDoc.media.fileName) || 'application/octet-stream';
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${mediaDoc.media.fileName}"`);
  fs.createReadStream(mediaDoc.media.filePath).pipe(res);
});

app.post('/api/query-memory', authMiddleware, async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing "text" field' });

  try {
    const results = await chromaCollection.query({ queryTexts: [text], nResults: 5 });
    res.json({ query: text, matches: results.documents?.[0] || [] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to query memory', details: err.message });
  }
});

app.post('/api/trigger-reply', authMiddleware, async (req, res) => {
  const { fromList } = req.body;
  if (!Array.isArray(fromList) || fromList.length === 0) return res.status(400).json({ error: '`fromList` must be a non-empty array of user JIDs' });

  let totalReplied = 0;

  for (const from of fromList) {
    const messages = await getUnrepliedMessages(from);
    for (const msg of messages) {
      const replyText = await generateAutoReply(msg.messageContent, chromaCollection);
      await sock.sendMessage(msg.sender, { text: replyText });
      await updateRepliedStatus(msg._id);
      totalReplied++;
    }
  }

  res.json({ status: 'replied_to_multiple_users', totalReplied });
});

app.listen(serverPort, () => {
  console.log(`🚀 MCP server running at http://localhost:${serverPort}/api/health`);
});
