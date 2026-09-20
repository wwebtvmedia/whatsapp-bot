#!/usr/bin/env node
// Responder-side replay: retrieval + grounded generation exactly as an inbound
// RESOLVE runs, minus packet sealing — prints the served chunks so retrieval
// tuning is observable (a full negotiation hides them behind the answer).
//
// Run INSIDE the bot container (env is injected by compose):
//   podman exec whatsapp-bot_whatsapp-bot_1 node scripts/osp-replay.mjs "titre du nouveau magazine"
// For a one-shot exec, pass the env explicitly (-e MONGO_URL=… -e CHROMA_URL=…
// -e EMBEDDING_URL=… -e LLM_URL=… -e LLM_MODEL=…): the .env is not in the image.
// NOTE: initDatabase must run before retrieval, hence the dynamic peer import.
import { initDatabase } from '../storage/database.js';
await initDatabase(process.env.MONGO_URL, process.env.CHROMA_URL);
const { answerQuery } = await import('../osp/peer.mjs');

const query = process.argv[2] || 'titre du nouveau magazine';
const { answer, effectiveQuery, texts } = await answerQuery(query);
console.log(`query: "${query}"${effectiveQuery !== query ? ` (effective: "${effectiveQuery}")` : ''}`);
console.log(`chunks served: ${texts.length}, lengths: ${texts.map(c => c.length).join(',')}`);
console.log('ANSWER:', JSON.stringify(answer).slice(0, 400));
process.exit(0);
