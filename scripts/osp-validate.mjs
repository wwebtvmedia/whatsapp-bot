#!/usr/bin/env node
// End-to-end OSP validation WITHOUT the tablet: a full origin-side negotiation
// (PROPOSE → BID → ALIGN → RESOLVE, then the groundedness firewall and the
// reputation update) over plain HTTP against a deployed bot — the exact wire
// path the ospbridge app runs.
//
// Signing (REQ-S-01/02): the peer's endpoint.json is fetched first; when it
// advertises an Ed25519 key_bundle it is PINNED (TOFU, optionally persisted via
// OSP_PINS_FILE) so the bot's EdDSA replies verify. Sealing stays dev-HMAC
// unless OSP_ED25519_SEED is set — and then the bot must pin THIS origin's
// bundle first (post it to /osp/pins/repin), or every packet drops silently.
//
// Run from anywhere node + this repo are available:
//   PEER_URL=http://192.168.1.249:3000 PEER_TOKEN=<bot API_TOKEN> \
//     node scripts/osp-validate.mjs "titre du nouveau magazine"
// Expected: mode=RESOLVED, groundedness ≥ 0.8, answer quoted from the corpus.
// Exit code 0 only on RESOLVED, so it can gate a deploy.
import { Node, HybridSigner, DevSigner, RagStore, HttpHub } from '../osp/core.mjs';
import { PinStore } from '../osp/peer.mjs';

const url = (process.env.PEER_URL || 'http://localhost:3000').replace(/\/$/, '');
const token = process.env.PEER_TOKEN;
const peer = process.env.PEER_ID || 'whatsapp-bot';
if (!token) { console.error('PEER_TOKEN required (the bot API_TOKEN)'); process.exit(1); }

// -- discovery + TOFU pin of the peer's signing key (REQ-S-02) ---------------
const pins = new PinStore({ file: process.env.OSP_PINS_FILE || null }).load();
let signerLabel = 'DEV-SIGNER (default secret)';
try {
  const record = await (await fetch(`${url}/osp/endpoint.json`)).json();
  if (record.key_bundle?.alg === 'EdDSA') {
    const verdict = pins.pin(peer, record.key_bundle);
    if (verdict === 'rejected') {
      console.error(`❌ ${peer} advertises a DIFFERENT key than pinned (kid ${record.key_bundle.kid}) — ` +
        'rotate deliberately via POST /osp/pins/repin, or investigate.');
      process.exit(2);
    }
    signerLabel = `peer pinned: ${record.key_bundle.kid} (${verdict})`;
  }
  if (record.signer) signerLabel += ` | peer signer: ${record.signer}`;
} catch { /* discovery unavailable — proceed dev-grade */ }

const origin = new Node(process.env.ORIGIN_ID || 'origin-validate', new RagStore(), null,
  { signer: new HybridSigner({
      hmacSecret: process.env.OSP_SIGNING_SECRET || 'osp-dev-secret',
      edSeed: process.env.OSP_ED25519_SEED || null,
      keyLookup: pins.keyLookup,
    }) });
const hub = new HttpHub(id => (id === peer ? { url, token } : null));
hub.join(origin);
console.log(`▶ ${origin.id} → ${url} [${signerLabel}]`);

const query = process.argv[2] || 'titre du nouveau magazine';
const out = await origin.query(query, Number(process.env.TIER) || 0, { candidates: [peer] });
console.log(JSON.stringify({
  mode: out.mode,
  groundedness: out.groundedness,
  answer: out.answer,
  detail: out.detail,
}, null, 2));
process.exit(out.mode === 'RESOLVED' ? 0 : 1);
