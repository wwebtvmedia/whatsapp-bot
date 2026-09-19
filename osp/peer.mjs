// osp/peer.mjs — OSP peer router for whatsapp-bot.
//
// Turns this bot into a first-class OSP node behind two endpoints:
//   POST /osp/packet   inbound sealed packets (the ospbridge app peers here)
//   POST /osp/query    this bot as ORIGIN, negotiating with remote peers
//   GET  /osp/endpoint.json  discovery record (same contract as the bridge)
//
// The responder is a full N2 node: retrieval comes from this bot's own memory
// (chroma via memorySearch), generation from its own LLM (LLM_URL, llama.cpp),
// always inside the closed envelope (buildEnvelope) — the model never sees the
// raw query without its evidence. Retrieval is async (chroma) while the
// protocol's onPropose is sync, so chunks are fed into the node's RagStore
// right before each inbound packet: the store is a per-request fresh view.

import {
  Packet, Action, Mode, Node, DevSigner, D3Provider, RagStore, HttpHub,
  buildEnvelope, chunkHash, embed, queryCover, tokenize,
} from './core.mjs';

// ---------------------------------------------------------------------------
// Responder rungs — bot-local retrieval (chroma) + bot-local LLM (llama.cpp)
// ---------------------------------------------------------------------------

// core's STOPWORDS is English-only (byte-parity with the reference impls), so
// French function words ride into queryCover: "du", "est", "que"… gave ad
// chunks 0.5-0.75 cover against a French question. Serving coverage is
// therefore measured per meaningful token only — this node-local list, core
// stays untouched for interop.
const LOCAL_STOPWORDS = new Set(('le la les des un une du de au aux et est sont que qui quoi quel dans ' +
  'pour avec sur par ce cet cette il elle nous vous je tu on en son sa ses leur their the a an of to ' +
  'in on at is are was were what which who this that it its').split(' '));

/** Chunks far below the best query coverage are filler: ads sharing a couple
 * of common words with the query made the grounded model abstain even with
 * the answer literally in the first chunk. Coverage is measured per
 * meaningful query token; chunks at ≥75% of the best stay (equally-covering
 * sets pass whole, pure-semantic sets pass untouched), and the rerank's own
 * #1 is never dropped. */
export function dropUncovered(query, texts) {
  if (texts.length <= 1) return texts;
  const tokens = tokenize(query).filter(t => !LOCAL_STOPWORDS.has(t) && t.length > 2);
  if (!tokens.length) return texts;
  const vecs = texts.map(t => embed(t));
  const covers = vecs.map(v => tokens.filter(t => queryCover(embed(t), v) > 0).length / tokens.length);
  const best = Math.max(...covers);
  if (best <= 0) return texts;
  return texts.filter((t, i) => i === 0 || covers[i] >= 0.75 * best);
}

// Set by the /packet handler when retrieval translated the query: the sealed
// generation grounds on the translated wording (same intent, corpus language).
// Cleared right after use — packets are served one at a time in practice.
let envelopeQueryOverride = null;

/** Small ollama call for query translation — never routes through the sealed
 * generate() (this is preprocessing, not an answer). */
async function translateText(text, targetLang) {
  const name = targetLang === 'fr' ? 'français' : 'English';
  const payload = {
    ...(process.env.LLM_MODEL ? { model: process.env.LLM_MODEL } : {}),
    messages: [{ role: 'user', content: `Translate to ${name}. Reply with the translation only, no quotes:\n\n${text}` }],
    stream: false,
    temperature: 0,
    think: false,
    options: { num_predict: 60 },
  };
  const res = await fetch(process.env.LLM_URL || 'http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`LLM error (${res.status})`);
  const data = await res.json();
  const out = String(data.choices?.[0]?.message?.content ?? data.message?.content ?? '').trim();
  if (!out) throw new Error('empty translation');
  return out;
}

/** Doc-level focus: chunks from a document other than the anchor's are
 * conflicting identity evidence — with two new magazines indexed, "titre du
 * magazine" made the model pick the wrong title or abstain. The anchor is the
 * first manifest among the ranked hits (its presence marks a document-level
 * query; foreign-document chunks outranking it at the rerank is exactly the
 * drift this guards against), else the best hit. Same-document chunks stay,
 * any other manifest stays (a competing doc may legitimately be the answer). */
export function focusDocument(ranked, docOf) {
  const anchor = ranked.find(t => t.startsWith('[Document ')) || ranked[0];
  const bestDoc = docOf.get(anchor);
  if (!bestDoc) return ranked;
  return ranked.filter(t => docOf.get(t) === bestDoc || t.startsWith('[Document '));
}

/** Pull this bot's own memory for a query: documents first, then chats.
 *
 * Order matters: with a top-K cut after the dedupe, conversation matches
 * would crowd out the indexed document chunks the query is actually about
 * (the model then honestly answers INSUFFICIENT_EVIDENCE with no evidence).
 * Exported for replay tooling: this is exactly what an inbound packet gets. */
export async function retrieveFromBotMemory(query, topK = 4) {
  const { searchMemory, searchDocuments } = await import('../memorySearch.js');
  const { detectLanguage } = await import('../mediaText.js');

  const docLangs = new Set();
  const retrieve = async (q) => {
    const hits = [];
    for (const search of [searchDocuments, searchMemory]) {
      try {
        const r = await search(q);
        // searchDocuments reports the languages of the served chunks
        for (const l of r.languages || []) docLangs.add(l);
        // matches carries the chunk texts, refs the per-hit metadata (doc)
        (r.matches || []).forEach((m, i) => {
          const t = String(m || '').trim();
          if (t) hits.push({ t, doc: r.refs?.[i]?.doc || null });
        });
      } catch (err) {
        // retrieval failure degrades to fewer chunks, never to a fabricated one
        console.warn('⚠️ OSP retrieval failed:', err.message);
      }
    }
    // CPU inference budget: the envelope prefill dominates generation time, so
    // each chunk travels capped. 1200 keeps an indexed chunk whole (the
    // extractor emits ~900-char chunks — the old 600 cap silently dropped a
    // third of every chunk). The cited hash stays this node's own view of the
    // chunk (GET_CHUNK serves the same text) — protocol-honest.
    const capped = hits.map(e => ({ ...e, t: e.t.length > 1200 ? e.t.slice(0, 1200) : e.t }));
    const seen = new Set();
    const uniq = capped.filter(e => (!seen.has(e.t) && seen.add(e.t)));
    const ranked = rerankByCover(q, uniq.map(e => e.t)).slice(0, topK);
    const docOf = new Map(uniq.map(e => [e.t, e.doc]));
    return dropUncovered(q, focusDocument(ranked, docOf));
  };

  let chunks = await retrieve(query);
  let effectiveQuery = query;

  // Embeddings and the lexical rerank are both language-bound: a query asked
  // in another language than the corpus retrieves badly. Re-retrieve with the
  // query translated into the documents' language — and let the generation be
  // grounded on the translated wording too (an English question over French
  // evidence otherwise makes gemma echo the question instead of answering).
  const qLang = detectLanguage(query, { minWords: 3 });
  const docLang = [...docLangs][0];
  if (qLang && docLang && qLang !== docLang) {
    const translated = await translateText(query, docLang).catch(err => {
      console.warn('⚠️ OSP query translation failed:', err.message);
      return null;
    });
    if (translated && translated.toLowerCase() !== query.toLowerCase()) {
      console.log(`🌐 OSP query translated (${qLang}→${docLang}): "${translated}"`);
      effectiveQuery = translated;
      chunks = await retrieve(translated);
    }
  }
  return { texts: chunks, query: effectiveQuery };
}

/**
 * Reorder chunks by the protocol's own competence metric before cutting to
 * top-K: chroma's vector order drifts when the query language differs from
 * the corpus (an English question over French PDFs pulled a whole OCR-noise
 * document to the front), and whatever ranks first is what the LLM gets to
 * ground on. queryCover is already the BID currency — reuse it for serving.
 */
export function rerankByCover(query, texts) {
  const qv = embed(query);
  return texts
    .map(t => ({ t, cover: queryCover(qv, embed(t)) }))
    .sort((a, b) => b.cover - a.cover)      // stable sort: ties keep chroma order
    .map(e => e.t);
}

/**
 * The grounding instruction makes the model answer exactly INSUFFICIENT_
 * EVIDENCE when no chunk holds the answer. Letting that sentinel travel as a
 * RESOLVE fails the origin's firewall (groundedness 0 → REJECTED) and docks
 * the responder's reputation −0.20 for an honest abstention. Refuse instead:
 * throwing here lands as RFO NO_QUORUM ('winner could not generate').
 */
const WRAPPER = '[\\s"\'«»“”*_`.!?-]*';
const INSUFFICIENT_SENTINEL = new RegExp(`^${WRAPPER}(insufficient[_ -]?evidence)${WRAPPER}$`, 'i');
export const isInsufficientEvidence = a => INSUFFICIENT_SENTINEL.test(String(a ?? ''));

function dedupe(texts) {
  const seen = new Set();
  return texts.filter(t => (seen.has(t) ? false : (seen.add(t), true)));
}

/** N2 rung: the bot's own LLM, generation sealed in the OSP envelope. */
export class BotLlmProvider extends D3Provider {
  constructor() {
    super('bot-llm');
    this.url = process.env.LLM_URL || 'http://localhost:11434/api/chat';
    this.model = process.env.LLM_MODEL || '';
  }

  // One sealed ollama call. think:false + options.num_predict: the ollama API
  // ignores `max_tokens`, and reasoning models (gemma4) then spend the whole
  // budget thinking — `content` came back EMPTY with done_reason:"length".
  // Disabling the thinking channel returns a grounded answer in seconds. Low
  // temperature: grounded extraction rambles about "corrupted data" at 0.7.
  async chat(envelope, { timeoutMs = 150_000 } = {}) {
    const payload = {
      ...(this.model ? { model: this.model } : {}),
      messages: [{ role: 'user', content: envelope }],
      stream: false,
      temperature: 0.2,
      max_tokens: 90,
      think: false,
      options: { num_predict: 150 },
    };
    // hard deadline: a hung LLM must not pin the /osp/packet thread forever
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`LLM error (${res.status})`);
    const data = await res.json();
    const answer = data.choices?.[0]?.message?.content ?? data.message?.content;
    if (!answer) throw new Error('LLM returned no content');
    return answer;
  }

  async generate(query, chunks) {
    const envelope = buildEnvelope(envelopeQueryOverride || query, chunks);
    envelopeQueryOverride = null;
    let answer = await this.chat(envelope);
    // sampling variance: gemma abstains on some draws even with the answer
    // literally in the first chunk — one identical retry recovers most of
    // those (150s + 120s stays inside the origin's 300s patience)
    if (isInsufficientEvidence(answer)) {
      answer = await this.chat(envelope, { timeoutMs: 120_000 }).catch(err => {
        console.warn('⚠️ OSP retry generation failed:', err.message);
        return null;
      });
    }
    if (!answer) throw new Error('LLM returned no content');
    if (isInsufficientEvidence(answer)) throw new Error('no answer in evidence');
    return { answer, provider: this.name, cost: { generations: 1 } };
  }
}

/** Full responder retrieval + grounded generation — exactly what an inbound
 * RESOLVE runs (minus the packet sealing and the RagStore bookkeeping). Used
 * by replay tooling so a test cannot drift from production: the envelope
 * carries the translated query just like the /packet handler arms it. */
export async function answerQuery(query, topK = 4) {
  const { texts, query: effectiveQuery } = await retrieveFromBotMemory(query, topK);
  envelopeQueryOverride = effectiveQuery !== query ? effectiveQuery : null;
  try {
    const chunks = texts.map(t => ({ hash: chunkHash(t), text: t }));
    const out = await new BotLlmProvider().generate(query, chunks);
    return { ...out, effectiveQuery, texts };
  } finally {
    envelopeQueryOverride = null;
  }
}

// ---------------------------------------------------------------------------
// Peer singleton — node wiring + express router
// ---------------------------------------------------------------------------

let peer = null;

export function getOspPeer() {
  if (peer) return peer;
  const signer = new DevSigner();
  const rag = new RagStore();
  const responder = new Node(process.env.OSP_NODE_ID || 'whatsapp-bot', rag,
    new BotLlmProvider(), { signer });
  // thin origin: this bot never generates on its own behalf (N1 rung)
  const origin = new Node(`${responder.id}-origin`, new RagStore(), null, { signer });
  const hub = new HttpHub(nodeId => peer?.remotes?.[nodeId] || null);
  hub.join(origin);
  responder.hub = hub;                       // inbound transport bookkeeping only
  peer = {
    responder, origin, hub, signer, rag,
    remotes: parseRemotes(process.env.OSP_PEERS),
    lastOutcome: null,
  };
  return peer;
}

/** OSP_PEERS = JSON map nodeId → url or {url, token} (link secret, optional). */
function parseRemotes(spec) {
  if (!spec) return {};
  try {
    const raw = JSON.parse(spec) || {};
    return Object.fromEntries(Object.entries(raw).map(([id, v]) =>
      [id, typeof v === 'string' ? { url: v } : v]));
  } catch { console.warn('⚠️ OSP_PEERS is not valid JSON — ignored'); return {}; }
}

/**
 * Express router (async builder — express is imported lazily so the osp core
 * stays zero-dependency). `auth` is the bot's existing x-api-token middleware
 * so the OSP endpoints inherit the same fail-closed posture as /api/*.
 */
export async function buildOspRouter(auth) {
  const { default: express } = await import('express');
  const router = express.Router();
  const p = getOspPeer();

  // -- discovery (same contract as the Kotlin bridge's /osp/endpoint.json) ----
  router.get('/endpoint.json', (req, res) => {
    res.json({
      node_id: p.responder.id,
      node_class: p.responder.klass,
      osp_packet_url: `${baseUrl(req)}/osp/packet`,
      packet_version: '0.6',
      signer: 'DEV-SIGNER',
    });
  });

  // -- inbound: a remote peer (bridge app, other bot) hands us a sealed packet
  router.post('/packet', auth, express.json(), async (req, res) => {
    let pkt;
    try { pkt = Packet.fromWire(req.body); } catch { return res.status(400).json({ error: 'bad packet' }); }
    // per-request retrieval feed: chroma → RagStore before the sync pipeline
    if (pkt.action === Action.PROPOSE || pkt.action === Action.RESOLVE) {
      const qv = embed(String(pkt.payload?.query_text ?? ''));
      if (qv.some(b => b !== 0)) {
        const { texts, query: effectiveQuery } = await retrieveFromBotMemory(String(pkt.payload.query_text));
        p.rag.entries.splice(0, p.rag.entries.length,
          ...texts.map(t => ({ hash: chunkHash(t), text: t, vec: embed(t) })));
        const top = p.rag.retrieve(qv)[0]?.score ?? 0;
        console.log(`🧩 OSP propose from ${pkt.originId}: "${String(pkt.payload.query_text).slice(0, 60)}" → ${texts.length} chunks, top_cover=${top}`);
        envelopeQueryOverride = effectiveQuery !== String(pkt.payload.query_text) ? effectiveQuery : null;
      }
    }
    try {
      // onResolve is async (LLM generation) — await keeps the wire contract:
      // one sealed reply packet per request
      const reply = await p.responder.onPacket(pkt);
      envelopeQueryOverride = null;
      if (!reply) return res.status(204).end();      // forged/replayed — silent
      const head = String(reply.payload?.answer ?? '').slice(0, 120).replace(/\s+/g, ' ');
      console.log(`↩️ OSP reply to ${pkt.originId}: ${reply.action} ${reply.payload?.reason ?? reply.payload?.bid ?? ''}${head ? ` | "${head}"` : ''} prov=${(reply.payload?.provenance ?? []).length}`);
      res.json(reply.toWire());
    } catch (err) {
      console.error('❌ OSP packet handling failed:', err.message);
      res.status(500).json({ error: 'packet handling failed' });
    }
  });

  // -- outbound: this bot as ORIGIN, full negotiation against OSP_PEERS -------
  router.post('/query', auth, express.json(), async (req, res) => {
    const { query, tier = 1 } = req.body || {};
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'query (string) required' });
    }
    try {
      const candidates = Object.keys(p.remotes);
      const out = await p.origin.query(query, Number(tier) || 1,
        candidates.length ? { candidates } : {});
      p.lastOutcome = out;
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // -- status -----------------------------------------------------------------
  router.get('/status', (_req, res) => {
    res.json({
      node_id: p.responder.id,
      node_class: p.responder.klass,
      origin_id: p.origin.id,
      peers: Object.keys(p.remotes),
      chunks: p.rag.entries.length,
      budget_left: p.responder.budget.left,
      last_outcome: p.lastOutcome,
      packet_version: '0.6',
    });
  });

  return router;
}

function baseUrl(req) {
  return process.env.OSP_PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
}
