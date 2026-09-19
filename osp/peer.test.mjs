// osp/peer.test.mjs — run with: node --test osp/
//
// Covers the responder-side retrieval grooming: cover-based rerank (the BID
// metric reused for serving order) and the INSUFFICIENT_EVIDENCE refusal that
// turns an honest abstention into RFO instead of a firewall-rejected RESOLVE.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { embed } from './core.mjs';
import { rerankByCover, isInsufficientEvidence, dropUncovered, focusDocument } from './peer.mjs';

test('focusDocument anchors on a manifest, drops other-document filler', () => {
  const manifest = '[Document STRAT.Pdf]\nTitre du document: TOUTES LES STRATÉGIES';
  const robots = '[Document ROBOTS.Pdf]\nTitre du document: PLANÈTE ROBOTS N°99';
  const docA = 'sommaire : la com à l\'école de l\'IA';
  const docB = 'abonnement renouvelé planeterobots.com contact';
  const docOf = new Map([[manifest, 'A.Pdf'], [docA, 'A.Pdf'], [robots, 'B.Pdf'], [docB, 'B.Pdf']]);
  // manifest first: its document stays whole, foreign filler goes
  assert.deepEqual(focusDocument([manifest, docB, docA, robots], docOf), [manifest, docA, robots]);
  // a foreign chunk outranking the manifest still anchors on the manifest
  assert.deepEqual(focusDocument([docB, manifest, robots], docOf), [docB, manifest, robots].filter(t => t !== docB));
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
