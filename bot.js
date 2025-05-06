// server.js
import * as baileys from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';
import express from 'express';
import dotenv from 'dotenv';
import mime from 'mime-types';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { ChromaClient } from 'chromadb';
import fetch from 'node-fetch';

dotenv.config();

const {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  DisconnectReason
} = baileys;

// Load environment variables
const mongoUrl = process.env.MONGO_URL;
const chromaUrl = process.env.CHROMA_URL;
const downloadsPath = process.env.DOWNLOADS_PATH;
const authFolder = process.env.WHATSAPP_AUTH_PATH;
const serverPort = process.env.SERVER_PORT;
const embeddingUrl = process.env.EMBEDDING_URL
// Get __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function connectWithRetry(uri, options = {}, retries = 10, delayMs = 5000) {
  for (let i = 0; i < retries; i++) {
    try {
      const client = new MongoClient(uri, options);
      await client.connect();
      console.log('✅ Connected to MongoDB');
      return client;
    } catch (err) {
      console.warn(`❌ MongoDB connection failed (attempt ${i + 1}): ${err.message}`);
      if (i === retries - 1) throw err;
      await new Promise(res => setTimeout(res, delayMs));
    }
  }
}

// Init MongoDB
const dbName = 'mcp';
const collectionName = 'messages';

const mongoClient = await connectWithRetry(mongoUrl)
console.log('✅ MongoDB connected');
const db = mongoClient.db(dbName);
const messageCollection = db.collection(collectionName);

console.log('MongoDB and ChromaDB connected successfully');
console.log('Downloads path:', path.resolve(__dirname, downloadsPath));
console.log('Auth path:', path.resolve(__dirname, authFolder));
console.log('Server running on port:', serverPort);


// Init Chroma
const chroma = new ChromaClient({ path: chromaUrl });
const chromaCollection = await chroma.getOrCreateCollection({ name: 'message_memory' });


[downloadsPath, authFolder].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function isValidChromaPayload(payload) {
  if (!payload) return false;

  const { ids, documents, metadatas, embeddings } = payload;

  const allArrays =
    Array.isArray(ids) &&
    Array.isArray(documents) &&
    (!metadatas || Array.isArray(metadatas)) &&
    (!embeddings || Array.isArray(embeddings));

  const sameLength =
    ids.length === documents.length &&
    (!metadatas || metadatas.length === ids.length) &&
    (!embeddings || embeddings.length === ids.length);

  const allStrings =
    documents.every(doc => typeof doc === 'string' && doc.trim().length > 0) &&
    ids.every(id => typeof id === 'string' && id.trim().length > 0);

  return allArrays && sameLength && allStrings;
}


// WhatsApp socket
let sock = null;

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    browser: ['Ubuntu', 'Chrome', '22.04'],
  });

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('❌ Connection closed', shouldReconnect ? 'Reconnecting...' : '');
      if (shouldReconnect) startSock();
    } else if (connection === 'open') {
      console.log('✅ WhatsApp connected');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {

      // 🚫 Skip Meta AI or unknown bot messages
      if (!msg.message || msg.key.remoteJid.endsWith('@bot')) {
        console.warn('⚠️ Skipping unknown/bot message from', jid);
        continue;
      }

      if (!msg.message) continue;
      try {  
        const jid = msg.key.remoteJid;
        const isGroup = jid.endsWith('@g.us');
        if (isGroup) continue; // Skip group messages if not needed

        const messageType = extractMessageType(msg.message);
        const messageContent = extractMessageText(msg.message);
        const timestamp = msg.messageTimestamp;
        const messageId = msg.key.id;

        console.log('📩 Received message:', { from: jid, messageContent, messageType });

        const senderFolder = path.join(downloadsPath, jid.replace('@s.whatsapp.net', ''));
        if (!fs.existsSync(senderFolder)) fs.mkdirSync(senderFolder, { recursive: true });

        const extension = getExtensionByType(messageType, msg.message[messageType]);
        const fileName = `${messageId}.${extension}`;
        const filePath = path.join(senderFolder, fileName);

        await messageCollection.insertOne({
          sender: jid,
          messageContent,
          timestamp: new Date(Number(timestamp) * 1000),
          messageId,
          messageType,
          media: { filePath, fileName },
          replied: false,
        });
        
        const response = await fetch(embeddingUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: [messageContent] })
        });
        
        const { embeddings } = await response.json();
        const embedding = embeddings[0];

        const payload = {
          ids: [messageId],
          documents: [messageContent],
          metadatas: [{ from: jid }],
          embeddings: [embedding]
        };
        
        if (isValidChromaPayload(payload)) {
          await chromaCollection.add(payload);
        } else {
          console.warn('⚠️ Invalid ChromaDB payload, skipping:', payload);
        }
        
        await tryDownloadMedia(msg);

      } catch (err) {
        console.error('❌ Error processing message:', err);
      }
    }
  });
}

function extractMessageText(message) {
  return message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.documentMessage?.caption ||
    message.videoMessage?.caption ||
    'No text';
}

function extractMessageType(message) {
  const mediaTypes = ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage'];
  return Object.keys(message).find(type => mediaTypes.includes(type)) || 'text';
}

function getExtensionByType(type, mediaMsg = {}) {
  switch (type) {
    case 'imageMessage': return 'jpg';
    case 'videoMessage': return 'mp4';
    case 'audioMessage': return 'mp3';
    case 'stickerMessage': return 'webp';
    case 'documentMessage': return mediaMsg?.fileName?.split('.').pop() || 'pdf';
    default: return 'bin';
  }
}

async function tryDownloadMedia(msg) {
  const type = extractMessageType(msg.message);
  const media = msg.message[type];
  if (!['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage'].includes(type)) return;

  const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
    logger: sock.logger,
    reuploadRequest: sock.updateMediaMessage
  });

  const senderFolder = path.join(downloadsPath, msg.key.remoteJid.replace('@s.whatsapp.net', ''));
  const extension = getExtensionByType(type, media);
  const filePath = path.join(senderFolder, `${msg.key.id}.${extension}`);

  fs.writeFileSync(filePath, buffer);
  console.log(`💾 Media saved to ${filePath}`);
}

async function sendMedia(number, mediaBuffer, mimetype, filename = 'file') {
  const jid = number.includes('@s.whatsapp.net') ? number : `${number}@s.whatsapp.net`;
  return sock.sendMessage(jid, {
    document: mediaBuffer,
    mimetype,
    fileName: filename,
  });
}

async function queryWithOllama(context, query, model = "qwen2:7b", url = "http://localhost:11434/api/chat") {
  const payload = {
    model,
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: `Context: ${context}\nQuestion: ${query}` }
    ],
    stream: false,
    temperature: 0.7,
    max_tokens: 150
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    console.error("❌ Ollama response error:", await response.text());
    return "⚠️ Failed to get a response.";
  }

  const data = await response.json();
  return data.message?.content || "⚠️ No reply generated.";
}

async function generateAutoReply(inputText) {
  const results = await chromaCollection.query({
    queryTexts: [inputText],
    nResults: 3
  });

  const memoryContext = (results.documents?.[0] || []).join('\n');
  return await queryWithOllama(memoryContext, inputText);
}

startSock();

// Express API setup
const app = express();
const upload = multer();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_, res) => {
  sock?.user
    ? res.json({ status: 'ok', user: sock.user })
    : res.status(500).json({ status: 'disconnected' });
});

app.post('/api/send-message', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'Missing fields' });
  try {
    await sock.sendMessage(to, { text: message });
    res.json({ status: 'sent' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/send-media', upload.single('file'), async (req, res) => {
  const { number } = req.body;
  const file = req.file;
  if (!number || !file) return res.status(400).json({ error: 'Missing file or number' });
  try {
    await sendMedia(number, file.buffer, file.mimetype, file.originalname);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/get-messages', async (_, res) => {
  const messages = await messageCollection.find().sort({ timestamp: -1 }).limit(20).toArray();
  res.json(messages);
});

app.get('/api/get-media', async (req, res) => {
  const after = req.query.after ? new Date(req.query.after) : null;
  if (after && isNaN(after)) return res.status(400).json({ error: 'Invalid `after` param' });

  const mediaDoc = await messageCollection.find({
    'media.filePath': { $exists: true },
    ...(after ? { timestamp: { $gt: after } } : {})
  }).sort({ timestamp: -1 }).limit(1).next();

  if (!mediaDoc) return res.status(404).json({ error: 'No media found' });

  const mimeType = mime.lookup(mediaDoc.media.fileName) || 'application/octet-stream';
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${mediaDoc.media.fileName}"`);
  fs.createReadStream(mediaDoc.media.filePath).pipe(res);
});

app.post('/api/query-memory', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing "text" field' });

  try {
    const results = await chromaCollection.query({
      queryTexts: [text],
      nResults: 5
    });

    const memorySnippets = results.documents?.[0] || [];
    res.json({ query: text, matches: memorySnippets });
  } catch (err) {
    console.error('❌ ChromaDB query failed:', err);
    res.status(500).json({ error: 'Failed to query memory', details: err.message });
  }
});

app.post('/api/trigger-reply', async (req, res) => {
  try {
    const { fromList } = req.body;
    if (!Array.isArray(fromList) || fromList.length === 0) {
      return res.status(400).json({ error: '`fromList` must be a non-empty array of user JIDs' });
    }

    let totalReplied = 0;

    for (const from of fromList) {
      const messages = await messageCollection.find({ replied: false, sender: from }).limit(10).toArray();

      for (const msg of messages) {
        const contextDocs = await chromaCollection.query({
          queryTexts: [msg.messageContent],
          nResults: 3
        });

        const context = (contextDocs.documents?.[0] || []).join('\n');
        const replyText = await queryWithOllama(context, msg.messageContent);

        await sock.sendMessage(msg.sender, { text: replyText });
        await messageCollection.updateOne({ _id: msg._id }, { $set: { replied: true } });
        totalReplied++;
      }
    }

    res.json({ status: 'replied_to_multiple_users', totalReplied });
  } catch (err) {
    console.error('❌ Error in trigger-reply:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(serverPort, () => {
  console.log(`🚀 MCP server running at http://localhost:${serverPort}/api/health`);
});
