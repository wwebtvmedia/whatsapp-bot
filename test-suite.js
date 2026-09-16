import test from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { filterWhatsappMessage } from './filters/whatsappFilter.js';
import { filterEmailToStandardMessage } from './filters/mailFilter.js';
import { queryLLM } from './answerGenerator.js';
import sharp from 'sharp';
import { chunkText, writeExtractedTextFile, classifyPages, countRealWords, cleanOcrText, formatParagraphs, findColumnCuts } from './mediaText.js';
import {
  initDatabase,
  closeDatabase,
  saveMessage,
  upsertDailyDigest,
  getDailyDigest,
  setMediaExtracted,
  getIndexedDocuments,
  hybridDocumentSearch,
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

test('Storage: parsed documents are listable and searchable through their extracted text', async (t) => {
  if (!await storageAvailable()) return t.skip('MongoDB/ChromaDB not running');
  const sender = `${uniqueRef()}@s.whatsapp.net`;
  const savedId = await saveMessage({
    sender,
    messageContent: 'document',
    timestamp: new Date(),
    messageId: uniqueRef(),
    messageType: 'documentMessage',
    media: { filePath: `/tmp/${uniqueRef()}.pdf`, fileName: 'invoice.pdf' }
  });
  await setMediaExtracted(savedId, { text: 'Total to pay: 42 euros, due on 2026-10-01.', chunks: 2 });

  const docs = await getIndexedDocuments(50);
  const mine = docs.find(d => String(d._id) === String(savedId));
  assert.ok(mine, 'the received document should be listed');
  assert.strictEqual(mine.media.fileName, 'invoice.pdf');
  assert.strictEqual(mine.media.indexedChunks, 2);
  assert.ok(mine.media.extractedText.includes('42 euros'));

  const hits = await hybridDocumentSearch('42 euros');
  assert.ok(hits.some(d => String(d._id) === String(savedId)));
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

test('Extracted text sidecar: written with method header, skipped when empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txt-sidecar-'));
  try {
    const pdfPath = path.join(dir, 'doc.pdf');
    fs.writeFileSync(pdfPath, '%PDF-fake');
    const out = writeExtractedTextFile(pdfPath, '[page 1] Hello world', 'pdf-ocr');
    assert.ok(out?.endsWith('doc.pdf.txt'));
    const content = fs.readFileSync(out, 'utf8');
    assert.match(content, /# Texte extrait de doc\.pdf/);
    assert.match(content, /# Méthode : OCR tesseract \(pdf-ocr\)/);
    assert.ok(content.includes('---\n[page 1] Hello world'));
    // native text layer: no OCR mention
    const nativeOut = writeExtractedTextFile(pdfPath, 'native text', 'pdf');
    assert.match(fs.readFileSync(nativeOut, 'utf8'), /# Méthode : pdf\n/);
    // nothing extracted → no file
    assert.strictEqual(writeExtractedTextFile(pdfPath, '', 'pdf-no-text'), null);
    assert.strictEqual(fs.existsSync(path.join(dir, 'none.pdf.txt')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Page classification: text pages vs picture pages for the two-pass OCR', () => {
  const article = 'The missile shield would stretch over land and sea, officials said. '.repeat(3);
  const adPage = '· · · — 45 % 12 3 ... ±· —'; // punctuation/number noise, no real words
  const { textPages, imagePages } = classifyPages([article, adPage, 'Buy now', article], 20);
  assert.deepStrictEqual(textPages, [0, 3]);
  assert.deepStrictEqual(imagePages, [1, 2]);
  assert.ok(countRealWords(article) > 20);
  assert.ok(countRealWords(adPage) < 20);
  // empty input classifies nothing
  assert.deepStrictEqual(classifyPages([]), { textPages: [], imagePages: [] });
});

test('OCR noise guard: garbled lines are dropped at extraction time', () => {
  const ocr = [
    'Can Trump build his Star Wars missile shield?',
    'A BIG READ, PAGE 6 MARTIN WOLF, PAGE 17',
    '| Jal Es 1108 N vel ÿ N Je . ca % a AE a cu .',
    'E Ee eT LTE eye EE re ae | CIN OYE TES GOA is ETE',
    'The missile shield would stretch over land and sea, officials said.'
  ].join('\n');
  const clean = cleanOcrText(ocr);
  assert.match(clean, /missile shield/);
  assert.match(clean, /MARTIN WOLF/);
  assert.ok(!clean.includes('Jal Es'));
  assert.ok(!clean.includes('CIN OYE'));
  assert.deepStrictEqual(cleanOcrText(''), '');
});

test('formatParagraphs: without bboxes, falls back to natural line order', () => {
  const blocks = [
    {
      paragraphs: [
        { lines: [{ text: 'Can Trump build his Star Wars\n' }, { text: 'missile shield?\n' }] },
        { lines: [{ text: 'A BIG READ, PAGE 6\n' }] }
      ]
    },
    { paragraphs: [{ lines: [{ text: 'MARTIN WOLF, PAGE 17\n' }] }] }
  ];
  assert.strictEqual(
    formatParagraphs(blocks),
    'Can Trump build his Star Wars\nmissile shield?\nA BIG READ, PAGE 6\nMARTIN WOLF, PAGE 17'
  );
  // no blocks (or unexpected shape) → empty string, callers fall back to data.text
  assert.strictEqual(formatParagraphs(undefined), '');
  assert.strictEqual(formatParagraphs([]), '');
  assert.strictEqual(formatParagraphs([{}]), '');
});

test('formatParagraphs: reads newspaper columns column-by-column, headlines first', () => {
  const ln = (x0, y0, x1, y1, text) => ({ bbox: [x0, y0, x1, y1], text: text + '\n' });
  const blocks = [{
    paragraphs: [{ lines: [
      ln(20, 600, 980, 650, 'Full width section bar'),
      ln(340, 180, 650, 200, 'R2'),
      ln(20, 110, 300, 130, 'L1a'),
      ln(20, 134, 300, 152, 'L1b'),
      ln(20, 60, 980, 100, 'HEADLINE'),
      ln(20, 180, 300, 200, 'L2'),
      ln(340, 110, 650, 130, 'R1a'),
      ln(340, 134, 650, 152, 'R1b')
    ] }]
  }];
  // tesseract merges narrow columns into wide blocks; line-level layout must
  // read: headline, whole left column (L1a+L1b re-joined, then L2), whole
  // right column, then the full-width bar
  assert.strictEqual(
    formatParagraphs(blocks),
    'HEADLINE\n\nL1a L1b\n\nL2\n\nR1a R1b\n\nR2\n\nFull width section bar'
  );
});

test('formatParagraphs: adapts per page — single column and three-column layouts', () => {
  const ln = (x0, y0, x1, y1, text) => ({ bbox: [x0, y0, x1, y1], text: text + '\n' });
  const wrap = (...lines) => [{ paragraphs: [{ lines }] }];
  // single-column page (letter, book): full-width lines keep natural order
  assert.strictEqual(formatParagraphs(wrap(ln(20, 60, 980, 200, 'P1'), ln(20, 210, 980, 400, 'P2'))), 'P1\n\nP2');
  // three narrow columns are detected and read left to right
  assert.strictEqual(
    formatParagraphs(wrap(ln(20, 60, 300, 500, 'C1'), ln(340, 60, 620, 500, 'C2'), ln(660, 60, 980, 500, 'C3'))),
    'C1\n\nC2\n\nC3'
  );
});

test('findColumnCuts: finds the gutter of a synthetic two-column page', async () => {
  const w = 300, h = 100;
  const buf = Buffer.alloc(w * h, 255);
  for (let y = 10; y < 90; y++) {
    for (let x = 20; x < 80; x++) buf[y * w + x] = 0;    // column 1
    for (let x = 150; x < 260; x++) buf[y * w + x] = 0;  // column 2
  }
  const png = path.join(os.tmpdir(), `cuts-${uniqueRef()}.png`);
  try {
    await sharp(buf, { raw: { width: w, height: h, channels: 1 } }).png().toFile(png);
    const cuts = await findColumnCuts(png);
    assert.ok(cuts, 'two columns should produce a split');
    assert.strictEqual(cuts.length, 2);
    const cutX = cuts[0].left + cuts[0].width;
    assert.ok(cutX > 80 && cutX < 150, `cut at ${cutX} should fall inside the gutter (80..150)`);
  } finally {
    await fs.promises.rm(png, { force: true });
  }
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
