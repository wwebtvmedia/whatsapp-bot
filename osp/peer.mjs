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
  buildEnvelope, chunkHash, embed,
} from './core.mjs';

// ---------------------------------------------------------------------------
// Responder rungs — bot-local retrieval (chroma) + bot-local LLM (llama.cpp)
// ---------------------------------------------------------------------------

/** Pull this bot's own memory for a query: conversations + documents. */
async function retrieveFromBotMemory(query, topK = 3) {
  const { searchMemory, searchDocuments } = await import('../memorySearch.js');
  const texts = [];
  for (const search of [searchMemory, searchDocuments]) {
    try {
      const r = await search(query);
      for (const ref of r.refs || []) {
        const t = String(ref.text || '').trim();
        if (t) texts.push(t);
      }
    } catch (err) {
      // retrieval failure degrades to fewer chunks, never to a fabricated one
      console.warn('⚠️ OSP retrieval failed:', err.message);
    }
  }
  return dedupe(texts).slice(0, topK);
}

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

  async generate(query, chunks) {
    const envelope = buildEnvelope(query, chunks);
    const payload = {
      ...(this.model ? { model: this.model } : {}),
      messages: [{ role: 'user', content: envelope }],
      stream: false,
      temperature: 0.7,
      max_tokens: 150,
    };
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`LLM error (${res.status})`);
    const data = await res.json();
    const answer = data.choices?.[0]?.message?.content ?? data.message?.content;
    if (!answer) throw new Error('LLM returned no content');
    return { answer, provider: this.name, cost: { generations: 1 } };
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

/** OSP_PEERS = JSON map nodeId → http base (e.g. {"osp-abc123":"http://192.168.1.10:8090"}) */
function parseRemotes(spec) {
  if (!spec) return {};
  try { return JSON.parse(spec) || {}; }
  catch { console.warn('⚠️ OSP_PEERS is not valid JSON — ignored'); return {}; }
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
        const texts = await retrieveFromBotMemory(String(pkt.payload.query_text));
        p.rag.entries.splice(0, p.rag.entries.length,
          ...texts.map(t => ({ hash: chunkHash(t), text: t, vec: embed(t) })));
      }
    }
    try {
      const reply = p.responder.onPacket(pkt);
      if (!reply) return res.status(204).end();      // forged/replayed — silent
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
