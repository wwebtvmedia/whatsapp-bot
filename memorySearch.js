// memorySearch.js
// Hierarchical + hybrid retrieval with a zero-cost cognitive router.
//
// Pipeline (cheap-first, see GraphRAG optimization strategies):
//   1. Route:      heuristics classify the query (subject/type/entities) — no LLM
//   2. Coarse:     vector search over per-day conversation digests
//   3. Fine:       vector search over messages, filtered by the candidate days
//   4. Hybrid:     lexical (Mongo regex) fallback when vector search is thin
//   5. Compress:   dedupe + cap the context window before it reaches the LLM

import dotenv from 'dotenv';
import fetch from 'node-fetch';
import {
  queryChromaDays,
  queryChromaMessages,
  hybridKeywordSearch,
  hybridDocumentSearch,
  upsertChromaDocChunks,
  dayKey
} from './storage/database.js';
import { routeQuery } from './classifier.js';
import { extractTextFromFile, chunkText } from './mediaText.js';

dotenv.config();

const embeddingUrl = process.env.EMBEDDING_URL || 'http://localhost:8001/embed';
const maxContextMessages = parseInt(process.env.CONTEXT_MAX_MESSAGES || '6', 10);
const COARSE_RESULTS = 3;
const ocrEnabled = process.env.MEDIA_OCR_ENABLED !== 'false';
const ocrLang = process.env.MEDIA_OCR_LANG || 'eng+fra';
const maxDocChunks = parseInt(process.env.MEDIA_MAX_CHUNKS || '60', 10);

export async function embedText(text, type = 'passage') {
  const response = await fetch(embeddingUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: [text], type })
  });
  if (!response.ok) throw new Error(`Embedding service error (${response.status})`);
  const data = await response.json();
  return data.embeddings?.[0];
}

export async function embedTexts(texts, type = 'passage') {
  const response = await fetch(embeddingUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: texts, type })
  });
  if (!response.ok) throw new Error(`Embedding service error (${response.status})`);
  const data = await response.json();
  return data.embeddings || [];
}

// Level 1 (coarse): find the conversation days most related to the query
async function findCandidateDays(queryEmbedding, sender) {
  try {
    const days = await queryChromaDays(queryEmbedding, COARSE_RESULTS, sender ? { sender } : undefined);
    return [...new Set((days.metadatas?.[0] || []).map(m => m?.day).filter(Boolean))];
  } catch (err) {
    console.error('❌ Coarse day search failed:', err.message);
    return [];
  }
}

// Level 2 (fine): messages, ideally scoped to the candidate days
async function findMessages(queryEmbedding, candidateDays, sender) {
  try {
    if (candidateDays.length > 0) {
      const filtered = await queryChromaMessages(
        queryEmbedding, maxContextMessages, { day: { $in: candidateDays } }
      );
      if (filtered.documents?.[0]?.length) return filtered;
    }
    return await queryChromaMessages(
      queryEmbedding, maxContextMessages, sender ? { sender } : undefined
    );
  } catch (err) {
    console.error('❌ Fine message search failed:', err.message);
    return { documents: [[]], metadatas: [[]], distances: [[]] };
  }
}

// Shared retrieval plumbing for both scopes (memory / documents): merge the
// vector hits with the lexical fallback, then compress the context window
// before it reaches the LLM.
function mergeHybrid(vectorHits, lexicalDocs, lexicalToHit) {
  const merged = new Map();
  (vectorHits.documents?.[0] || []).forEach((text, i) => {
    if (!text) return;
    merged.set(text, {
      text,
      meta: vectorHits.metadatas?.[0]?.[i] || {},
      source: 'vector'
    });
  });
  for (const doc of lexicalDocs) {
    const hit = lexicalToHit(doc);
    if (!hit?.text || merged.has(hit.text)) continue;
    merged.set(hit.text, { ...hit, source: 'lexical' });
  }
  return [...merged.values()];
}

// OCR noise is filtered at extraction time (cleanOcrText, per line) so the
// index and the LLM context stay clean downstream.
function compressHits(hits) {
  const kept = hits.slice(0, maxContextMessages);
  const context = kept
    .map(h => {
      const m = h.meta || {};
      const tag = [m.day, m.subject, m.info_type].filter(Boolean).join(' | ');
      return tag ? `[${tag}] ${h.text}` : h.text;
    })
    .join('\n')
    .slice(0, 4000);
  return { kept, context };
}

function toResult(kept, context, used) {
  return {
    context,
    matches: kept.map(h => h.text),
    refs: kept.map(h => ({ ref: h.meta?.ref, sender: h.meta?.sender, day: h.meta?.day, source: h.source, doc: h.meta?.doc })),
    used
  };
}

/**
 * Full retrieval pipeline.
 * @param {string} query
 * @param {{sender?: string}} [opts]
 * @returns {Promise<{context: string, refs: object[], used: object}>}
 */
export async function searchMemory(query, { sender = null } = {}) {
  const route = routeQuery(query);
  const queryEmbedding = await embedText(query, 'query');

  const candidateDays = await findCandidateDays(queryEmbedding, sender);
  const vectorHits = await findMessages(queryEmbedding, candidateDays, sender);

  // Hybrid fallback: lexical search when vector retrieval found nothing usable
  let lexicalHits = [];
  if (!vectorHits.documents?.[0]?.length) {
    lexicalHits = await hybridKeywordSearch(query);
  }

  const hits = mergeHybrid(vectorHits, lexicalHits, doc => ({
    text: doc.messageContent,
    meta: {
      sender: doc.sender,
      subject: doc.subject,
      info_type: doc.infoType,
      day: dayKey(doc.timestamp instanceof Date ? doc.timestamp : new Date(doc.timestamp)),
      ref: doc._id?.toString()
    }
  }));

  const { kept, context } = compressHits(hits);
  return toResult(kept, context, {
    route,
    candidateDays,
    vector: kept.filter(h => h.source === 'vector').length,
    lexical: kept.filter(h => h.source === 'lexical').length
  });
}

/**
 * Retrieval restricted to the RAG of received documents: vector search over
 * the indexed chunks only (optionally a single file), lexical fallback over
 * the extracted text kept in Mongo.
 * @param {string} query
 * @param {{doc?: string|null}} [opts]  doc = media.fileName to focus on one file
 * @returns {Promise<{context: string, refs: object[], used: object}>}
 */
export async function searchDocuments(query, { doc = null } = {}) {
  const queryEmbedding = await embedText(query, 'query');

  const where = doc ? { $and: [{ info_type: 'document' }, { doc }] } : { info_type: 'document' };
  let vectorHits = { documents: [[]], metadatas: [[]], distances: [[]] };
  try {
    vectorHits = await queryChromaMessages(queryEmbedding, maxContextMessages, where);
  } catch (err) {
    console.error('❌ Document chunk search failed:', err.message);
  }

  let lexicalHits = [];
  if (!vectorHits.documents?.[0]?.length) {
    lexicalHits = await hybridDocumentSearch(query, doc);
  }

  const hits = mergeHybrid(vectorHits, lexicalHits, d => ({
    text: d.media?.extractedText,
    meta: {
      sender: d.sender,
      doc: d.media?.fileName,
      info_type: 'document',
      day: dayKey(d.timestamp instanceof Date ? d.timestamp : new Date(d.timestamp)),
      ref: d._id?.toString()
    }
  }));

  const { kept, context } = compressHits(hits);
  return toResult(kept, context, {
    scope: 'documents',
    doc,
    vector: kept.filter(h => h.source === 'vector').length,
    lexical: kept.filter(h => h.source === 'lexical').length
  });
}

/**
 * Extract the text of a received document, chunk it and index every chunk so
 * questions about the document's content are answerable through searchMemory.
 * @param {{messageId: string, sender: string, day: string, ref: string, subject: string,
 *          filePath: string, fileName: string}} doc
 * @returns {Promise<{indexed: number, kind: string, text: string}>}
 */
export async function indexDocumentChunks({ messageId, sender, day, ref, subject, filePath, fileName }) {
  const { text, kind } = await extractTextFromFile(filePath, { ocrEnabled, ocrLang });
  if (!text) return { indexed: 0, kind, text: '' };

  const chunks = chunkText(text, { maxChunks: maxDocChunks });
  if (!chunks.length) return { indexed: 0, kind, text: '' };

  const embeddings = await embedTexts(chunks);
  await upsertChromaDocChunks(chunks.map((chunk, i) => ({
    id: `${messageId}:chunk:${i}`,
    text: chunk,
    embedding: embeddings[i],
    metadata: { sender, day, ref, subject, doc: fileName, info_type: 'document', chunk_index: i }
  })));

  return { indexed: chunks.length, kind, text };
}
