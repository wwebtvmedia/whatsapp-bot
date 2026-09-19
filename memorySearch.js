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
import { extractTextFromFile, chunkText, splitPdfByToc, allocateChunkBudget, docMasthead, buildDocManifest } from './mediaText.js';

dotenv.config();

const embeddingUrl = process.env.EMBEDDING_URL || 'http://localhost:8001/embed';
const maxContextMessages = parseInt(process.env.CONTEXT_MAX_MESSAGES || '6', 10);
const COARSE_RESULTS = 3;
const ocrEnabled = process.env.MEDIA_OCR_ENABLED !== 'false';
const ocrLang = process.env.MEDIA_OCR_LANG || 'eng+fra';
// 60 chunks = 54k chars max indexed; a scanned magazine at 300 dpi yields
// ~380k chars, so the default scales up (tunable per deployment)
const maxDocChunks = parseInt(process.env.MEDIA_MAX_CHUNKS || '200', 10);

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
    // The manifest chunk carries the document's identity card (filename,
    // masthead, sommaire): serve it ahead of the ranked article chunks so
    // questions about the document itself never depend on the vector ranking.
    const manifestWhere = doc
      ? { $and: [{ info_type: 'document' }, { manifest: true }, { doc }] }
      : { $and: [{ info_type: 'document' }, { manifest: true }] };
    const manifestHits = await queryChromaMessages(queryEmbedding, 2, manifestWhere);
    const prepend = (front, base) => ({
      documents: [[...(front.documents?.[0] || []), ...(base.documents?.[0] || [])]],
      metadatas: [[...(front.metadatas?.[0] || []), ...(base.metadatas?.[0] || [])]],
      distances: [[...(front.distances?.[0] || []), ...(base.distances?.[0] || [])]]
    });
    if (manifestHits.documents?.[0]?.length) vectorHits = prepend(manifestHits, vectorHits);
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
 * Magazine-style PDFs are split by their own table of contents when one is
 * found: chunks stay inside one article and carry the article title, which
 * both sharpens retrieval and lets answers cite the article (and page).
 * @param {{messageId: string, sender: string, day: string, ref: string, subject: string,
 *          filePath: string, fileName: string}} doc
 * @returns {Promise<{indexed: number, kind: string, text: string, articles?: number}>}
 */
export async function indexDocumentChunks({ messageId, sender, day, ref, subject, filePath, fileName }) {
  const { text, kind } = await extractTextFromFile(filePath, { ocrEnabled, ocrLang });
  if (!text) return { indexed: 0, kind, text: '' };

  // Chunk per TOC article when the document has one; each article gets a
  // length-proportional share of the global chunk budget, min 1 chunk.
  const articles = await splitPdfByToc(filePath);
  const hasToc = Array.isArray(articles) && articles.length >= 2;
  let chunks;
  let articleTitles = null;
  if (hasToc) {
    const budget = allocateChunkBudget(articles, maxDocChunks);
    chunks = [];
    articleTitles = [];
    let chunkIndex = 0;
    articles.forEach((article, a) => {
      const parts = chunkText(article.text, { maxChunks: budget[a] });
      articleTitles.push(...parts.map(() => article.title));
      chunkIndex += parts.length;
      chunks.push(...parts);
    });
    console.log(`📑 TOC split: ${articles.length} article(s), budget ${budget.join('/')}`);
  } else {
    chunks = chunkText(text, { maxChunks: maxDocChunks });
  }
  if (!chunks.length) return { indexed: 0, kind, text: '' };

  // Identity-card chunk, appended last: filename, masthead, sommaire, head of
  // the text. searchDocuments serves it deterministically (see below).
  chunks.push(buildDocManifest(fileName, articleTitles, text, docMasthead(text)));
  if (articleTitles) articleTitles.push('Sommaire du document');

  const embeddings = await embedTexts(chunks);
  await upsertChromaDocChunks(chunks.map((chunk, i) => ({
    id: `${messageId}:chunk:${i}`,
    text: chunk,
    embedding: embeddings[i],
    metadata: {
      sender, day, ref, subject, doc: fileName, info_type: 'document', chunk_index: i,
      ...(articleTitles ? { article: articleTitles[i].slice(0, 120) } : {}),
      ...(i === chunks.length - 1 ? { manifest: true } : {})
    }
  })));

  return { indexed: chunks.length, kind, text, articles: hasToc ? articles.length : undefined };
}
