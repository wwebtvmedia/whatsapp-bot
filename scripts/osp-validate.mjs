#!/usr/bin/env node
// End-to-end OSP validation WITHOUT the tablet: a full origin-side negotiation
// (PROPOSE → BID → ALIGN → RESOLVE, then the groundedness firewall and the
// reputation update) over plain HTTP against a deployed bot — the exact wire
// path the ospbridge app runs. DevSigner's shared dev secret is what lets any
// node sign packets the bot accepts; production must move to Ed25519 (REQ-S-01).
//
// Run from anywhere node + this repo are available:
//   PEER_URL=http://192.168.1.249:3000 PEER_TOKEN=<bot API_TOKEN> \
//     node scripts/osp-validate.mjs "titre du nouveau magazine"
// Expected: mode=RESOLVED, groundedness ≥ 0.8, answer quoted from the corpus.
// Exit code 0 only on RESOLVED, so it can gate a deploy.
import { Node, RagStore, HttpHub, DevSigner } from '../osp/core.mjs';

const url = process.env.PEER_URL || 'http://localhost:3000';
const token = process.env.PEER_TOKEN;
const peer = process.env.PEER_ID || 'whatsapp-bot';
if (!token) { console.error('PEER_TOKEN required (the bot API_TOKEN)'); process.exit(1); }

const query = process.argv[2] || 'titre du nouveau magazine';
const origin = new Node(process.env.ORIGIN_ID || 'origin-validate', new RagStore(), null,
  { signer: new DevSigner() });
const hub = new HttpHub(id => (id === peer ? { url, token } : null));
hub.join(origin);

const out = await origin.query(query, Number(process.env.TIER) || 0, { candidates: [peer] });
console.log(JSON.stringify({
  mode: out.mode,
  groundedness: out.groundedness,
  answer: out.answer,
  detail: out.detail,
}, null, 2));
process.exit(out.mode === 'RESOLVED' ? 0 : 1);
