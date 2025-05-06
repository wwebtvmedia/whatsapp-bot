// agentic-mcp.js (Main controller + WhatsApp handler)
import * as baileys from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { MongoClient } from 'mongodb';
import { ChromaClient } from 'chromadb';
import express from 'express';
import fetch from 'node-fetch';

dotenv.config();

const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = baileys;
const mongoUrl = process.env.MONGO_URL || 'mongodb://localhost:27017';
const mongoClient = new MongoClient(mongoUrl);
await mongoClient.connect();
const db = mongoClient.db('mcpdb');
const messageCollection = db.collection('messages');

const chroma = new ChromaClient({ path: 'http://localhost:8000' });
const chromaCollection = await chroma.getOrCreateCollection({ name: 'message_memory' });

const authFolder = process.env.WHATSAPP_AUTH_PATH || './auth';

async function queryWithOllama(context, query, model = "qwen2:7b", url = "http://localhost:11434/api/chat") {
  const prompt = `You are a helpful assistant. Use the following context to answer the question.

Context: ${context}

Question: ${query}`;

  const payload = {
    model,
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: prompt }
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
    return "⚠️ Failed to get a response from the local assistant.";
  }

  const data = await response.json();
  return data.message?.content || "⚠️ No reply generated.";
}

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    browser: ['Ubuntu', 'Chrome', '22.04']
  });

  sock.ev.on('connection.update', ({ connection, qr }) => {
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === 'open') console.log('✅ WhatsApp connected');
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return;
    for (const msg of m.messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const content = extractMessageText(msg.message);
      const payload = {
        platform: 'whatsapp',
        from: msg.key.remoteJid,
        content: content,
        timestamp: new Date()
      };

      await messageCollection.insertOne(payload);

      // Embed and store in ChromaDB
      await chromaCollection.add({
        ids: [msg.key.id],
        documents: [content],
        metadatas: [{ from: payload.from, timestamp: payload.timestamp }]
      });

      const response = await generateAutoReply(content);
      await sock.sendMessage(payload.from, { text: response });
    }
  });
}

function extractMessageText(message) {
  if (message.conversation) return message.conversation;
  if (message.extendedTextMessage) return message.extendedTextMessage.text;
  return '[unknown message type]';
}

async function generateAutoReply(inputText) {
  // Retrieve similar memories from ChromaDB
  const results = await chromaCollection.query({
    queryTexts: [inputText],
    nResults: 3
  });

  const memorySnippets = results.documents?.[0] || [];
  const memoryContext = memorySnippets.join('\n');

  // Use local LLM for response
  const response = await queryWithOllama(memoryContext, inputText);
  return response;
}

startSock();

// Express API for querying ChromaDB
const app = express();
app.use(express.json());

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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Agentic MCP API listening at http://localhost:${port}`);
});
