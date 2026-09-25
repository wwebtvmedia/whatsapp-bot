// osp/peer.test.mjs — run with: node --test osp/
//
// Covers the responder-side retrieval grooming: cover-based rerank (the BID
// metric reused for serving order) and the INSUFFICIENT_EVIDENCE refusal that
// turns an honest abstention into RFO instead of a firewall-rejected RESOLVE.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { embed } from './core.mjs';
import { rerankByCover, isInsufficientEvidence, dropUncovered, focusDocument, mergeChunks } from './peer.mjs';

test('focusDocument anchors on a manifest, drops other-document filler', () => {
  const manifest = '[Document STRAT.Pdf]\nTitre du document: TOUTES LES STRATÉGIES';
  const robots = '[Document ROBOTS.Pdf]\nTitre du document: PLANÈTE ROBOTS N°99';
  const docA = 'sommaire : la com à l\'école de l\'IA';
  const docB = 'abonnement renouvelé planeterobots.com contact';
  const docOf = new Map([[manifest, 'A.Pdf'], [docA, 'A.Pdf'], [robots, 'B.Pdf'], [docB, 'B.Pdf']]);
  // manifest first: a document-level query gets manifests ONLY — same-document
  // ad chunks still made the model abstain on a third of draws. Every other
  // manifest stays: a "list the documents" query needs them all.
  assert.deepEqual(focusDocument([manifest, docB, docA, robots], docOf), [manifest, robots]);
  // a foreign chunk outranking the manifest still anchors on the manifest
  assert.deepEqual(focusDocument([docB, manifest, robots], docOf), [manifest, robots]);
  // content query, no manifest in sight: the best hit's doc is the anchor
  assert.deepEqual(focusDocument([docB, docA], docOf), [docB]);
  // unidentifiable hits (chat memory): untouched
  const mixed = ['chat line', 'another chat line'];
  assert.deepEqual(focusDocument(mixed, new Map()), mixed);
});

test('rerankByCover puts the query-covering chunk first', () => {
  const query = 'planeterobots magazine subscription offer';
  const chunks = [
    'Warhol portraits exhibition reviewed by the museum curator',      // noise
    'OFFRE D\'ABONNEMENT 2026 planeterobots.com subscription offer',  // relevant
    'Negotiations over dinner, the curator and his companion',        // noise
  ];
  const ranked = rerankByCover(query, chunks);
  assert.equal(ranked[0], chunks[1]);
});

test('dropUncovered keeps chunks near the best coverage, drops the filler tail', () => {
  const query = 'titre du nouveau magazine';
  const chunks = [
    '[Document x]\nTitre du document: TOUTES LES STRATÉGIES — titre',  // best cover
    'programme nouveau spectacle titre affiche',                       // near-best, stays
    'values.media élue agence média de l\'année, grand prix',          // filler
  ];
  const kept = dropUncovered(query, chunks);
  assert.equal(kept.length, 2);
  assert.equal(kept[0], chunks[0]);
  assert.equal(kept[1], chunks[1]);
  // a set of equally-covering hits passes whole
  const equal = ['titre nouveau magazine', 'magazine nouveau titre'];
  assert.deepEqual(dropUncovered(query, equal), equal);
  // pure-semantic sets (nothing covers) pass untouched
  const noCover = ['completely unrelated words', 'other different terms'];
  assert.deepEqual(dropUncovered(query, noCover), noCover);
});

test('rerankByCover keeps the original order on zero coverage', () => {
  const chunks = ['alpha beta', 'gamma delta'];
  assert.deepEqual(rerankByCover('nothing matches here', chunks), chunks);
});

test('isInsufficientEvidence matches the sentinel, not real answers', () => {
  for (const a of ['INSUFFICIENT_EVIDENCE', ' insufficient evidence ', '«INSUFFICIENT-EVIDENCE.»',
    'Insufficient Evidence', '***INSUFFICIENT_EVIDENCE***']) {
    assert.ok(isInsufficientEvidence(a), `should match: ${a}`);
  }
  // Negative fixtures keep the French guillemets: the wrapper class must
  // strip punctuation, never swallow a real sentence around it.
  for (const a of ['The magazine is called « PLANET ROBOTS ».',
    'INSUFFICIENT_EVIDENCE is not the answer here',
    'The full title is INSUFFICIENT_EVIDENCE-like, actually no', '']) {
    assert.ok(!isInsufficientEvidence(a), `should NOT match: ${a}`);
  }
});

// ---------------------------------------------------------------------------
// Non-reg 2026-09-25 — the per-request feed merged by replacement, so a
// GET_CHUNK for a chunk cited one negotiation earlier answered "unknown
// chunk" (5.3.5). mergeChunks keeps the recent history, newest wins, bounded.
// Also: the retry generation is reported honestly in cost.generations.
// ---------------------------------------------------------------------------

test('mergeChunks keeps earlier chunks servable, newest wins, bounded', () => {
  const entries = mergeChunks([], ['chunk one', 'chunk two']);
  assert.equal(entries.length, 2);
  const hashes = entries.map(e => e.hash);
  // a later feed keeps the old chunks and appends the new ones
  mergeChunks(entries, ['chunk two', 'chunk three']);
  assert.deepEqual(entries.map(e => e.text),
    ['chunk one', 'chunk two', 'chunk three']);
  // the cap trims the OLDEST first
  const small = mergeChunks([], ['a', 'b']);
  mergeChunks(small, ['b', 'c'], 3);
  assert.deepEqual(small.map(e => e.text), ['a', 'b', 'c']);
  mergeChunks(small, ['d'], 3);
  assert.deepEqual(small.map(e => e.text), ['b', 'c', 'd']);
  assert.ok(hashes.includes(entries[0].hash));
});

test('BotLlmProvider reports the retry in cost.generations (m4)', async () => {
  const { BotLlmProvider } = await import('./peer.mjs');
  const p = new BotLlmProvider();
  let calls = 0;
  p.chat = async () => (calls += 1, calls === 1 ? 'INSUFFICIENT_EVIDENCE' : 'The pump failed.');
  const out = await p.generate('why?', [{ hash: 'h', text: 'the pump failed' }]);
  assert.equal(out.cost.generations, 2, 'the retry is a generation, counted as one');
  // a first-draw answer stays one generation
  p.chat = async () => (calls += 1, 'Direct answer.');
  const one = await p.generate('why?', [{ hash: 'h', text: 'evidence' }]);
  assert.equal(one.cost.generations, 1);
});

// ---------------------------------------------------------------------------
// Non-reg 2026-09-25 — REQ-S-02 TOFU pin store: first sight pins, a changed
// bundle is rejected until an explicit re-pin, discovery is restricted to
// configured peers whose endpoint record proves its own identity.
// ---------------------------------------------------------------------------

const BUNDLE_A = { alg: 'EdDSA', kid: 'kaAAAAAAAAAA', signing: 'AAAA_publicKeyA' };
const BUNDLE_A2 = { alg: 'EdDSA', kid: 'kaAAAAAAAAAA', signing: 'AAAA_publicKeyA' };
const BUNDLE_B = { alg: 'EdDSA', kid: 'kbBBBBBBBBBB', signing: 'BBBB_publicKeyB' };

test('PinStore pins first sight, rejects drift, repins explicitly', async () => {
  const { PinStore } = await import('./peer.mjs');
  const s = new PinStore();
  assert.equal(s.pin('tablet', { alg: 'HMAC-SHA256' }), 'rejected', 'dev bundles are not pinnable');
  assert.equal(s.pin('tablet', { alg: 'EdDSA', kid: 'x', signing: undefined }), 'rejected');
  assert.equal(s.pin('tablet', BUNDLE_A), 'pinned');
  assert.equal(s.pin('tablet', BUNDLE_A2), 'unchanged', 'same bundle replays as unchanged');
  assert.equal(s.pin('tablet', BUNDLE_B), 'rejected', 'a NEW key for a pinned node is an attack');
  assert.equal(s.keyLookup('kbBBBBBBBBBB'), null, 'the rejected key never resolves');
  assert.equal(s.pin('tablet', BUNDLE_B, { repin: true }), 'pinned', 're-pin is explicit');
  assert.equal(s.keyLookup('kbBBBBBBBBBB')?.nodeId, 'tablet');
  assert.equal(s.keyLookup('unknown'), null);
});

test('PinStore persists pins across a load() round-trip', async () => {
  const { PinStore } = await import('./peer.mjs');
  const { tmpdir } = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const file = path.join(tmpdir(), `osp-pins-test-${process.pid}.json`);
  try {
    const writer = new PinStore({ file });
    assert.equal(writer.pin('tablet', BUNDLE_A), 'pinned');
    const reader = new PinStore({ file }).load();
    assert.deepEqual(reader.keyLookup('kaAAAAAAAAAA'),
      { signing: 'AAAA_publicKeyA', nodeId: 'tablet' });
  } finally { fs.rmSync(file, { force: true }); }
});

test('bootstrap pins from the sender endpoint.json only when identities match', async () => {
  const { PinStore } = await import('./peer.mjs');
  const { Packet, Action, Ed25519Signer, embed } = await import('./core.mjs');
  const signer = new Ed25519Signer(
    '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
  const jwsPkt = new Packet({
    action: Action.PROPOSE, originId: 'tablet', queryId: 'q', sender: 'tablet',
    payload: { query_vec: [...embed('q')], query_text: 'q' },
  }).seal(signer);
  const record = { node_id: 'tablet', key_bundle: signer.bundle() };

  // happy path: matching record, one remote configured → pinned
  const ok = new PinStore({ fetchImpl: async () => ({ json: async () => record }) });
  assert.equal(await ok.bootstrap(jwsPkt, { tablet: 'http://tablet:8080' }), true);
  assert.equal(ok.keyLookup(signer.kid)?.nodeId, 'tablet');

  // impostor: the record claims another node_id — no pin
  const impostor = new PinStore({ fetchImpl: async () => ({ json: async () => ({ ...record, node_id: 'bot' }) }) });
  assert.equal(await impostor.bootstrap(jwsPkt, { tablet: 'http://tablet:8080' }), false);
  assert.equal(impostor.keyLookup(signer.kid), null);

  // unknown sender: not a configured peer → nothing to ask, no pin
  const stranger = new PinStore({ fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.equal(await stranger.bootstrap(jwsPkt, {}), false);
  assert.equal(stranger.keyLookup(signer.kid), null);

  // HMAC packets never trigger discovery; a kid already tried is not retried
  const hmacPkt = new Packet({
    action: Action.PROPOSE, originId: 'tablet', queryId: 'q', sender: 'tablet',
    payload: { query_vec: [...embed('q')], query_text: 'q' },
  }).seal(new (await import('./core.mjs')).DevSigner());
  const once = new PinStore({ fetchImpl: async () => ({ json: async () => record }) });
  assert.equal(await once.bootstrap(hmacPkt, { tablet: 'http://tablet:8080' }), false);
  assert.equal(await once.bootstrap(jwsPkt, { tablet: 'http://tablet:8080' }), true);
  // record now serves a DIFFERENT bundle: the kid is already tried → no refetch
  let fetches = 0;
  const drift = new PinStore({ fetchImpl: async () => (fetches += 1, { json: async () => record }) });
  assert.equal(await drift.bootstrap(jwsPkt, { tablet: 'http://tablet:8080' }), true);
  const other = new Packet({
    action: Action.PROPOSE, originId: 'tablet', queryId: 'q2', sender: 'tablet',
    payload: { query_vec: [...embed('q')], query_text: 'q' },
  }).seal(signer);
  // same kid already pinned → keyLookup short-circuits before any fetch
  const before = fetches;
  assert.equal(await drift.bootstrap(other, { tablet: 'http://tablet:8080' }), false);
  assert.equal(fetches, before, 'an already-pinned kid costs no discovery fetch');
});

test('bootstrap forwards the peer link token to endpoint.json', async () => {
  const { PinStore } = await import('./peer.mjs');
  const { Packet, Action, Ed25519Signer, embed } = await import('./core.mjs');
  const signer = new Ed25519Signer(
    '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
  const jwsPkt = new Packet({
    action: Action.PROPOSE, originId: 'tablet', queryId: 'q', sender: 'tablet',
    payload: { query_vec: [...embed('q')], query_text: 'q' },
  }).seal(signer);
  const record = { node_id: 'tablet', key_bundle: signer.bundle() };

  // the tablet bridge gates endpoint.json behind its link token — discovery
  // must present it under both accepted spellings
  let seen;
  const authed = new PinStore({
    fetchImpl: async (url, init) => (seen = { url, headers: init?.headers },
      { json: async () => record }),
  });
  assert.equal(await authed.bootstrap(jwsPkt,
    { tablet: { url: 'http://tablet:8080', token: 'link-secret' } }), true);
  assert.equal(seen.url, 'http://tablet:8080/osp/endpoint.json');
  assert.equal(seen.headers['x-api-token'], 'link-secret');
  assert.equal(seen.headers.authorization, 'Bearer link-secret');

  // bare-string peers stay unauthenticated
  let bare;
  const anon = new PinStore({
    fetchImpl: async (url, init) => (bare = { headers: init?.headers },
      { json: async () => record }),
  });
  assert.equal(await anon.bootstrap(jwsPkt, { tablet: 'http://tablet:8080' }), true);
  assert.equal(bare.headers['x-api-token'], undefined);
  assert.equal(bare.headers.authorization, undefined);
});

test('HybridSigner + PinStore accept a pinned sender and drop an impostor', async () => {
  const { PinStore } = await import('./peer.mjs');
  const { Packet, Action, Ed25519Signer, HybridSigner, embed } = await import('./core.mjs');
  const seed = '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb';
  const signer = new Ed25519Signer(seed);
  const pins = new PinStore();
  pins.pin('tablet', signer.bundle());
  const hybrid = new HybridSigner({ keyLookup: pins.keyLookup });
  const good = new Packet({
    action: Action.PROPOSE, originId: 'tablet', queryId: 'q', sender: 'tablet',
    payload: { query_vec: [...embed('q')], query_text: 'q' },
  }).seal(signer);
  assert.equal(hybrid.verify(good.signedObject(), good.sig), true);
  // same key, different claimed sender → the pin binding rejects it
  const stolen = new Packet({
    action: Action.PROPOSE, originId: 'bot', queryId: 'q', sender: 'bot',
    payload: { query_vec: [...embed('q')], query_text: 'q' },
  }).seal(signer);
  assert.equal(hybrid.verify(stolen.signedObject(), stolen.sig), false,
    'a stolen (key, node_id) pair fails the sender binding');
});
