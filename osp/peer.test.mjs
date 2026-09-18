// osp/peer.test.mjs — run with: node --test osp/
//
// Covers the responder-side retrieval grooming: cover-based rerank (the BID
// metric reused for serving order) and the INSUFFICIENT_EVIDENCE refusal that
// turns an honest abstention into RFO instead of a firewall-rejected RESOLVE.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { embed } from './core.mjs';
import { rerankByCover, isInsufficientEvidence } from './peer.mjs';

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

test('rerankByCover keeps the original order on zero coverage', () => {
  const chunks = ['alpha beta', 'gamma delta'];
  assert.deepEqual(rerankByCover('nothing matches here', chunks), chunks);
});

test('isInsufficientEvidence matches the sentinel, not real answers', () => {
  for (const a of ['INSUFFICIENT_EVIDENCE', ' insufficient evidence ', '«INSUFFICIENT-EVIDENCE.»',
    'Insufficient Evidence', '***INSUFFICIENT_EVIDENCE***']) {
    assert.ok(isInsufficientEvidence(a), `should match: ${a}`);
  }
  for (const a of ['Le magazine s\'appelle « PLANÈTE ROBOTS ».',
    'INSUFFICIENT_EVIDENCE is not the answer here',
    'The full title is INSUFFICIENT_EVIDENCE-like, actually no', '']) {
    assert.ok(!isInsufficientEvidence(a), `should NOT match: ${a}`);
  }
});
