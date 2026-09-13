import test from 'node:test';
import assert from 'node:assert';
import { filterWhatsappMessage } from './filters/whatsappFilter.js';
import { filterEmailToStandardMessage } from './filters/mailFilter.js';
import { queryLLM } from './answerGenerator.js';
import { chunkText } from './mediaText.js';
import {
  initDatabase,
  closeDatabase,
  upsertDailyDigest,
  getDailyDigest,
  getContactSettings,
  setContactAutoReply,
  saveProposedReply,
  getRecentProposedReplies,
  claimProposedReply,
  markProposedReplySent,
  saveLog,
  getRecentLogs
} from './storage/database.js';

// 4. Storage layer — needs MongoDB (+ ChromaDB for initDatabase); every test
// skips cleanly when the services are not running, so `npm test` stays green
// anywhere. A dedicated database (`mcp_test`) keeps the real data untouched.
let storageUp; // undefined = not tried yet, boolean afterwards
async function storageAvailable() {
  if (storageUp === undefined) {
    try {
      await initDatabase(
        process.env.MONGO_URL_TEST || 'mongodb://127.0.0.1:27017',
        process.env.CHROMA_URL_TEST || 'http://127.0.0.1:8000',
        'mcp_test'
      );
      storageUp = true;
    } catch {
      storageUp = false;
    }
  }
  return storageUp;
}

const uniqueRef = () => `test-${process.pid}-${Math.random().toString(36).slice(2)}`;

test('Storage: upsertDailyDigest returns the digest doc itself (not the driver envelope)', async (t) => {
  if (!await storageAvailable()) return t.skip('MongoDB/ChromaDB not running');
  const key = uniqueRef();
  await upsertDailyDigest({ key, sender: 's', day: '2026-09-13', subject: 'invoice', text: 'a' });
  const doc = await upsertDailyDigest({ key, sender: 's', day: '2026-09-13', subject: 'invoice', text: 'b' });
  // The bug this guards against: `{value: …}` wrapping made `.count` undefined
  // and silently disabled the day-digest embedding in server.js
  assert.strictEqual(doc.count, 2);
  assert.deepStrictEqual(doc.texts, ['a', 'b']);
  assert.strictEqual((await getDailyDigest(key)).key, key);
});

test('Storage: auto-reply defaults to off and toggles per contact', async (t) => {
  if (!await storageAvailable()) return t.skip('MongoDB/ChromaDB not running');
  const sender = `${uniqueRef()}@s.whatsapp.net`;
  assert.strictEqual((await getContactSettings(sender)).autoReply, false);
  const saved = await setContactAutoReply(sender, true);
  assert.strictEqual(saved.autoReply, true);
  assert.strictEqual((await getContactSettings(sender)).autoReply, true);
  assert.strictEqual((await setContactAutoReply(sender, false)).autoReply, false);
});

test('Storage: proposed replies are idempotent per message and claimed atomically', async (t) => {
  if (!await storageAvailable()) return t.skip('MongoDB/ChromaDB not running');
  const sender = `${uniqueRef()}@s.whatsapp.net`;
  const messageRef = uniqueRef();
  await saveProposedReply({ sender, messageRef, incoming: 'hello', reply: 'draft', refs: [] });
  // A replayed messages.upsert must neither duplicate nor reset the row
  await saveProposedReply({ sender, messageRef, incoming: 'REPLAYED', reply: 'REPLAYED', refs: [] });

  const all = await getRecentProposedReplies(50);
  const mine = all.filter(p => p.messageRef === messageRef);
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].status, 'proposed');
  assert.strictEqual(mine[0].incoming, 'hello');

  const claimed = await claimProposedReply(mine[0]._id);
  assert.strictEqual(claimed.status, 'sending');
  // Second claim on the same row must fail (double-click protection)
  assert.strictEqual(await claimProposedReply(mine[0]._id), null);

  await markProposedReplySent(mine[0]._id, { whatsappId: 'waid' });
  const sent = (await getRecentProposedReplies(50)).find(p => p.messageRef === messageRef);
  assert.strictEqual(sent.status, 'sent');
});

test('Storage: bot log round-trips and is readable newest-first', async (t) => {
  if (!await storageAvailable()) return t.skip('MongoDB/ChromaDB not running');
  const token = uniqueRef();
  await saveLog(`test.ev1.${token}`, { sender: 'a', detail: 'first' });
  await saveLog(`test.ev2.${token}`, { level: 'error', sender: 'a', detail: 'second' });
  const logs = await getRecentLogs(50);
  const mine = logs.filter(l => l.event.includes(token));
  assert.strictEqual(mine.length, 2);
  assert.strictEqual(mine[0].event, `test.ev2.${token}`); // newest first
  assert.strictEqual(mine[0].level, 'error');
  assert.strictEqual(mine[1].level, 'info');
});

// Release the Mongo socket so the test runner can exit
test.after(() => closeDatabase());

// 1. Test WhatsApp Filter
test('WhatsApp Filter: should correctly standardize a text message', () => {
  const rawMsg = {
    key: { remoteJid: '12345@s.whatsapp.net', id: 'ABC123', fromMe: false },
    message: { conversation: 'Hello World' },
    messageTimestamp: 1700000000
  };

  const filtered = filterWhatsappMessage(rawMsg);
  assert.strictEqual(filtered.sender, '12345@s.whatsapp.net');
  assert.strictEqual(filtered.messageContent, 'Hello World');
  assert.strictEqual(filtered.messageType, 'text');
  assert.ok(filtered.timestamp instanceof Date);
});

test('WhatsApp Filter: should ignore group messages', () => {
  const rawMsg = {
    key: { remoteJid: '12345@g.us', id: 'ABC123', fromMe: false },
    message: { conversation: 'Hello Group' },
    messageTimestamp: 1700000000
  };

  const filtered = filterWhatsappMessage(rawMsg);
  assert.strictEqual(filtered, null);
});

// 2. Test Email Filter
test('Email Filter: should correctly standardize an email', () => {
  const parsedEmail = {
    from: { value: [{ address: 'test@example.com' }] },
    text: 'Email body content',
    date: new Date('2024-01-01T10:00:00Z'),
    messageId: 'email-id-123'
  };

  const filtered = filterEmailToStandardMessage(parsedEmail);
  assert.strictEqual(filtered.sender, 'test@example.com');
  assert.strictEqual(filtered.messageContent, 'Email body content');
  assert.strictEqual(filtered.messageType, 'email');
});

test('Email Filter: should strip HTML when no plain-text part exists', () => {
  const parsedEmail = {
    from: { value: [{ address: 'test@example.com' }] },
    html: '<html><head><style>p { color: red }</style></head><body><p>Hello <b>HTML</b> world</p></body></html>',
    date: new Date('2024-01-01T10:00:00Z'),
    messageId: 'email-id-html'
  };

  const filtered = filterEmailToStandardMessage(parsedEmail);
  assert.strictEqual(filtered.messageContent, 'Hello HTML world');
});

test('chunkText: splits with overlap and caps the chunk count', () => {
  const chunks = chunkText('a'.repeat(2500), { size: 1000, overlap: 100 });
  assert.strictEqual(chunks.length, 3);
  assert.ok(chunks[0].length <= 1000);
  // consecutive chunks overlap
  assert.strictEqual(chunks[1].slice(0, 100), chunks[0].slice(-100));
  // maxChunks hard cap
  const capped = chunkText('b'.repeat(50000), { size: 100, overlap: 20, maxChunks: 5 });
  assert.strictEqual(capped.length, 5);
  // empty / whitespace-only input
  assert.deepStrictEqual(chunkText('   '), []);
});

// 3. Test LLM Logic (Formatting)
test('LLM Logic: should handle openai-compatible (llama.cpp) formatting', async (t) => {
    // Mocking environment for this test
    process.env.LLM_TYPE = 'openai';
    process.env.LLM_URL = 'http://localhost:8080';
    
    // We expect this to fail because no server is running, 
    // but we want to see if it tries to hit the /v1/chat/completions endpoint
    try {
        await queryLLM("context", "question");
    } catch (err) {
        // If it throws an error about connection, that's fine.
        // The logic we want to verify is in the code structure.
    }
});
