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

import fs from 'node:fs';
import path from 'node:path';
import {
  Packet, Action, Mode, Node, HybridSigner, D3Provider, RagStore, HttpHub,
  buildEnvelope, chunkHash, embed, queryCover, tokenize, canonicalJson, SILENT_DROP, isJws,
} from './core.mjs';

const isJwsLike = isJws;

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

// The translated query rides the packet instance (pkt.envelopeQuery → the
// generate() ctx): the sealed generation grounds on the translated wording
// (same intent, corpus language) without a module global two concurrent
// packets could race on.

/** RagStore cap for the per-request feed: enough to keep every cited chunk of
 * the recent negotiations GET_CHUNK-servable, small enough to stay a
 * per-proposal scan. */
export const OSP_RAG_MAX = 256;

/** Merge freshly retrieved chunks into the store, newest wins, bounded —
 * entries already in the fresh set are dropped then re-added at the end so
 * they keep their refreshed vec. Mutates entries, returns it. */
export function mergeChunks(entries, texts, max = OSP_RAG_MAX) {
  const fresh = texts.map(t => ({ hash: chunkHash(t), text: t, vec: embed(t) }));
  const freshHashes = new Set(fresh.map(c => c.hash));
  const room = Math.max(0, max - fresh.length);
  const kept = room > 0
    ? entries.filter(e => !freshHashes.has(e.hash)).slice(-room)
    : [];
  entries.splice(0, entries.length, ...kept, ...fresh);
  return entries;
}

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
 * first manifest among the ranked hits; its presence marks a document-level
 * query, and then ONLY manifests are served — same-document ad chunks made
 * gemma abstain on a third of draws even with the title in chunk #1. Without
 * a manifest anchor, the best hit's document mates stay (content queries). */
export function focusDocument(ranked, docOf) {
  const anchor = ranked.find(t => t.startsWith('[Document ')) || ranked[0];
  if (anchor.startsWith('[Document ')) {
    return ranked.filter(t => t.startsWith('[Document '));
  }
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

  async generate(query, chunks, ctx = {}) {
    const envelope = buildEnvelope(ctx.envelopeQuery || query, chunks);
    let calls = 0;
    const ask = async timeoutMs => { calls += 1; return this.chat(envelope, { timeoutMs }); };
    let answer = await ask(150_000);
    // sampling variance: gemma abstains on some draws even with the answer
    // literally in the first chunk — one identical retry recovers most of
    // those (150s + 120s stays inside the origin's 300s patience)
    if (isInsufficientEvidence(answer)) {
      answer = await ask(120_000).catch(err => {
        console.warn('⚠️ OSP retry generation failed:', err.message);
        return null;
      });
    }
    if (!answer) throw new Error('LLM returned no content');
    if (isInsufficientEvidence(answer)) throw new Error('no answer in evidence');
    // honest cost: the retry IS a generation, the budget reconciles for it
    return { answer, provider: this.name, cost: { generations: calls } };
  }
}

/** Full responder retrieval + grounded generation — exactly what an inbound
 * RESOLVE runs (minus the packet sealing and the RagStore bookkeeping). Used
 * by replay tooling so a test cannot drift from production: the envelope
 * carries the translated query just like the /packet handler arms it. */
export async function answerQuery(query, topK = 4) {
  const { texts, query: effectiveQuery } = await retrieveFromBotMemory(query, topK);
  const chunks = texts.map(t => ({ hash: chunkHash(t), text: t }));
  const out = await new BotLlmProvider().generate(query, chunks,
    { envelopeQuery: effectiveQuery !== query ? effectiveQuery : null });
  return { ...out, effectiveQuery, texts };
}

// ---------------------------------------------------------------------------
// Peer singleton — node wiring + express router
// ---------------------------------------------------------------------------

let peer = null;

/**
 * TOFU pin store (REQ-S-02): the first key bundle observed for a node_id is
 * pinned; a different bundle is rejected until an explicit re-pin. Pins
 * persist to a JSON file so restarts do not reset trust. `keyLookup` is the
 * HybridSigner's resolver — kid → {signing, nodeId}, with the packet's sender
 * bound to the pinned node at verification time.
 */
export class PinStore {
  constructor({ file = process.env.OSP_PINS_FILE || null, fetchImpl = globalThis.fetch } = {}) {
    this.file = file;
    this.fetch = fetchImpl;
    this.pins = new Map();                   // nodeId → {alg, kid, signing, pinned_at}
    this.bootstrapTried = new Set();         // kids we already tried to discover
  }
  load() {
    if (!this.file) return this;
    try {
      for (const [id, bundle] of Object.entries(JSON.parse(fs.readFileSync(this.file, 'utf8'))))
        this.pins.set(id, bundle);
    } catch { /* first boot or unreadable — start empty */ }
    return this;
  }
  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.pins), null, 2));
    } catch (err) { console.warn('⚠️ OSP pin store not persisted:', err.message); }
  }
  keyLookup = kid => {
    for (const [nodeId, b] of this.pins) if (b.kid === kid) return { signing: b.signing, nodeId };
    return null;
  };
  /** TOFU: 'pinned' | 'unchanged' | 'rejected'. Re-pin is explicit only. */
  pin(nodeId, bundle, { repin = false } = {}) {
    if (!bundle?.kid || !bundle?.signing || bundle.alg !== 'EdDSA') return 'rejected';
    const existing = this.pins.get(nodeId);
    if (existing && repin) {
      this.pins.set(nodeId, { ...bundle, pinned_at: new Date().toISOString() });
      this.save();
      return 'pinned';
    }
    if (existing) return existing.kid === bundle.kid && existing.signing === bundle.signing
      ? 'unchanged' : 'rejected';
    this.pins.set(nodeId, { ...bundle, pinned_at: new Date().toISOString() });
    this.save();
    return 'pinned';
  }
  /**
   * First-sight key discovery: a packet sealed by an unknown kid is given ONE
   * chance to pin itself from the sender's advertised discovery record, and
   * only when that sender is a configured peer (we know where to ask) and the
   * record's node_id matches the packet's sender (no impostor self-pinning).
   */
  async bootstrap(pkt, remotes) {
    if (!isJwsLike(pkt.sig)) return false;
    let kid;
    try { kid = JSON.parse(Buffer.from(pkt.sig.split('.')[0], 'base64url').toString('utf8')).kid; }
    catch { return false; }
    if (!kid || this.keyLookup(kid) || this.bootstrapTried.has(kid)) return false;
    this.bootstrapTried.add(kid);
    const remote = remotes[pkt.sender];
    const url = typeof remote === 'string' ? remote : remote?.url;
    if (!url) return false;
    const headers = {};
    const token = typeof remote === 'string' ? null : remote.token;
    if (token) {
      // both spellings so either server-side check accepts the same secret —
      // the tablet bridge's endpoint.json is link-token gated like its other
      // routes, and TOFU discovery must survive that gate
      headers['x-api-token'] = token;
      headers['authorization'] = `Bearer ${token}`;
    }
    try {
      const base = url.replace(/\/osp\/packet$/, '').replace(/\/$/, '');
      const res = await this.fetch(`${base}/osp/endpoint.json`,
        { headers, signal: AbortSignal.timeout(5000) });
      const record = await res.json();
      const bundle = record.key_bundle;
      if (record.node_id !== pkt.sender) return false;      // impostor record
      return this.pin(pkt.sender, bundle) === 'pinned';
    } catch { return false; }
  }
}

export function getOspPeer() {
  if (peer) return peer;
  // pins persist across restarts by default — trust reset by a reboot would
  // silently re-pin whoever speaks next (tests pass file: null explicitly)
  const pins = new PinStore({ file: process.env.OSP_PINS_FILE || 'data/osp-pins.json' }).load();
  const edSeed = process.env.OSP_ED25519_SEED || null;
  const secret = process.env.OSP_SIGNING_SECRET;
  // REQ-S-01 posture: Ed25519 when a seed is configured; the HMAC dev signer
  // is the labelled stand-in until every peer can verify Ed25519
  if (!edSeed && !secret) console.warn('⚠️ OSP_ED25519_SEED unset — sealing with the well-known dev secret (dev-grade only, REQ-S-01)');
  const signer = new HybridSigner({
    hmacSecret: secret || 'osp-dev-secret',
    edSeed,
    keyLookup: pins.keyLookup,
  });
  const rag = new RagStore();
  const responder = new Node(process.env.OSP_NODE_ID || 'whatsapp-bot', rag,
    new BotLlmProvider(), { signer });
  // thin origin: this bot never generates on its own behalf (N1 rung)
  const origin = new Node(`${responder.id}-origin`, new RagStore(), null, { signer });
  const hub = new HttpHub(nodeId => peer?.remotes?.[nodeId] || null);
  hub.join(origin);
  responder.hub = hub;                       // inbound transport bookkeeping only
  peer = {
    responder, origin, hub, signer, rag, pins,
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
    const record = {
      node_id: p.responder.id,
      node_class: p.responder.klass,
      osp_packet_url: `${baseUrl(req)}/osp/packet`,
      packet_version: '0.6',
      signer: p.signer.label,
    };
    // advertise the signing bundle only in Ed25519 mode — an HMAC dev record
    // must never be pinnable by a TOFU peer
    if (p.signer.ed) record.key_bundle = p.signer.bundle();
    res.json(record);
  });

  // -- trust store (REQ-S-02): inspect pins, replace one explicitly ----------
  router.get('/pins', auth, (_req, res) => {
    res.json({ pins: Object.fromEntries(p.pins.pins) });
  });
  router.post('/pins/repin', auth, express.json(), (req, res) => {
    const { node_id, bundle } = req.body || {};
    if (!node_id || typeof node_id !== 'string' || !bundle) {
      return res.status(400).json({ error: 'node_id (string) and bundle required' });
    }
    const result = p.pins.pin(node_id, bundle, { repin: true });
    console.log(`📌 OSP re-pin ${node_id}: ${result} (kid ${bundle.kid})`);
    res.json({ node_id, result, kid: bundle.kid ?? null });
  });

  // -- inbound: a remote peer (bridge app, other bot) hands us a sealed packet
  router.post('/packet', auth, express.json(), async (req, res) => {
    let pkt;
    try {
      // raw wire text when available — number literals keep their int/float
      // form, which re-canonicalisation needs to reproduce the sender's sig
      pkt = req.rawBody != null
        ? Packet.fromWireText(req.rawBody.toString('utf8'))
        : Packet.fromWire(req.body);
    } catch { return res.status(400).json({ error: 'bad packet' }); }
    // layer 0 first (sig, version, TTL, replay, loop, gas): a forged packet
    // must cost a signature check, not a chroma query and an LLM call
    try {
      let early = p.responder.validate(pkt);
      if (early === SILENT_DROP && isJwsLike(pkt.sig)) {
        // unknown signing key → one TOFU discovery attempt (REQ-S-02) against
        // the sender's advertised endpoint, then retry layer 0; anything else
        // (bad sig, replay) still drops silently
        if (await p.pins.bootstrap(pkt, p.remotes)) {
          console.log(`📌 OSP pinned new key for ${pkt.sender} via endpoint.json`);
          early = p.responder.validate(pkt);
        }
      }
      if (early === SILENT_DROP) return res.status(204).end();
      if (early) {
        console.log(`↩️ OSP layer-0 reject to ${pkt.originId}: ${early.action} ${early.payload.reason}`);
        return res.type('application/json').send(canonicalJson(early.toWire()));
      }
    } catch { return res.status(204).end(); }
    // per-request retrieval feed: chroma → RagStore, merged newest-wins and
    // bounded so chunks cited by earlier negotiations stay GET_CHUNK-servable
    // (5.3.5) instead of being wiped by each packet
    if (pkt.action === Action.PROPOSE || pkt.action === Action.RESOLVE) {
      const qv = embed(String(pkt.payload?.query_text ?? ''));
      if (qv.some(b => b !== 0)) {
        const { texts, query: effectiveQuery } = await retrieveFromBotMemory(String(pkt.payload.query_text));
        mergeChunks(p.rag.entries, texts, OSP_RAG_MAX);
        const top = p.rag.retrieve(qv)[0]?.score ?? 0;
        console.log(`🧩 OSP propose from ${pkt.originId}: "${String(pkt.payload.query_text).slice(0, 60)}" → ${texts.length} chunks, top_cover=${top}`);
        pkt.envelopeQuery = effectiveQuery !== String(pkt.payload.query_text) ? effectiveQuery : null;
      }
    }
    try {
      // onResolve is async (LLM generation) — await keeps the wire contract:
      // one sealed reply packet per request
      const reply = await p.responder.onPacket(pkt);
      if (!reply) return res.status(204).end();      // forged/replayed — silent
      const head = String(reply.payload?.answer ?? '').slice(0, 120).replace(/\s+/g, ' ');
      console.log(`↩️ OSP reply to ${pkt.originId}: ${reply.action} ${reply.payload?.reason ?? reply.payload?.bid ?? ''}${head ? ` | "${head}"` : ''} prov=${(reply.payload?.provenance ?? []).length}`);
      // canonical bytes — res.json would re-stringify float fields as integers
      res.type('application/json').send(canonicalJson(reply.toWire()));
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

  // -- status (authenticated: last_outcome echoes a full answer) --------------
  router.get('/status', auth, (_req, res) => {
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
