#!/usr/bin/env node
// Generate an Ed25519 identity for OSP (REQ-S-01) — prints the env line for the
// sealing node and the key bundle its peers must PIN (TOFU, REQ-S-02).
//
//   node scripts/osp-keygen.mjs                      # fresh seed
//   node scripts/osp-keygen.mjs --seed <64 hex>      # bundle for an existing seed
//
// The seed never leaves the machine that runs this: only the bundle's public
// key travels, and peers accept it once (first sight) or via explicit re-pin.
import { randomBytes } from 'node:crypto';
import { Ed25519Signer } from '../osp/core.mjs';

const arg = process.argv.indexOf('--seed');
const seedText = arg > -1 ? process.argv[arg + 1] : randomBytes(32).toString('hex');
const seed = Buffer.from(seedText || '', 'hex');

let signer;
try { signer = new Ed25519Signer(seed); } catch {
  console.error('bad --seed: expected 32 bytes as 64 hex characters');
  process.exit(1);
}

console.log('# 1. secret — set on the node that SEALS with this key:');
console.log(`OSP_ED25519_SEED=${seed.toString('hex')}`);
console.log('# 2. public — peers must PIN this bundle (once, TOFU) before');
console.log('#    accepting packets sealed by it. Already pinned? repin explicitly:');
console.log(`#    curl -X POST $PEER/osp/pins/repin -H "x-api-token: $TOKEN" \\`);
console.log(`#         -H 'content-type: application/json' -d '<bundle with node_id>'`);
console.log(JSON.stringify(signer.bundle(), null, 2));
