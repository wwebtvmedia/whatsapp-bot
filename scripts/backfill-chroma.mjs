#!/usr/bin/env node
// One-off backfill: re-index every stored Mongo message into Chroma (fine
// level + per-day digests). Needed after losing vector data — until v1.2.2
// the chroma volume was mounted at the legacy /chroma path while the image
// persists to /data, so vectors died with the container on every recreate.
// Safe to re-run: everything is an upsert keyed by message id / day key.
//
// Run inside the bot container (it has the env and the network):
//   podman exec whatsapp-bot_whatsapp-bot_1 node scripts/backfill-chroma.mjs
import 'dotenv/config';
import {
  initDatabase, closeDatabase, getRecentMessages, upsertChromaMessage,
  upsertChromaDay, upsertDailyDigest, getDailyDigest, dayKey
} from '../storage/database.js';
import { embedText } from '../memorySearch.js';

const limit = parseInt(process.env.BACKFILL_LIMIT || '2000', 10);
await initDatabase(process.env.MONGO_URL, process.env.CHROMA_URL);

const messages = await getRecentMessages(limit);
console.log(`🔁 Backfill: ${messages.length} message(s) à ré-indexer`);

let indexed = 0, skipped = 0;
const dayGroups = new Map(); // `${sender}|${day}` -> { sender, day, subjects:Set }

for (const m of messages) {
  try {
    const ts = m.timestamp instanceof Date
      ? m.timestamp
      : new Date(typeof m.timestamp === 'number' ? m.timestamp * 1000 : m.timestamp);
    if (isNaN(ts)) { skipped++; continue; }
    const day = dayKey(ts);
    const raw = m.messageContent && m.messageContent !== 'No text' ? m.messageContent : `[media] ${m.messageType || 'message'}`;
    const embedding = await embedText(raw);
    if (!embedding) { skipped++; continue; }

    await upsertChromaMessage(m.messageId, m.messageContent, embedding, {
      sender: m.sender, subject: m.subject, info_type: m.infoType, day, ref: m._id.toString()
    });

    // Rebuild the per-day digest exactly like ingestMessage does
    const subject = m.subject || 'general';
    const digest = await upsertDailyDigest({
      key: `${m.sender}|${day}`, sender: m.sender, day, subject,
      text: `${m.messageType === 'text' ? '' : `[${m.messageType}] `}${m.messageContent}`
    });
    const group = dayGroups.get(`${m.sender}|${day}`) || { sender: m.sender, day, subjects: new Set(), count: 0 };
    group.subjects.add(subject);
    group.count = digest?.count || group.count + 1;
    dayGroups.set(`${m.sender}|${day}`, group);

    indexed++;
  } catch (err) {
    console.error(`✗ ${m.messageId}: ${err.message}`);
    skipped++;
  }
}
console.log(`✅ ${indexed} message(s) vectorisé(s), ${skipped} ignoré(s)`);

// Coarse level: one embedding per sender+day, from the digest texts
let digests = 0;
for (const [key, group] of dayGroups) {
  try {
    const digest = await getDailyDigest(key);
    const digestText = (digest?.texts || []).slice(-40).join('\n');
    if (!digestText) continue;
    const embedding = await embedText(digestText);
    if (!embedding) continue;
    await upsertChromaDay(`day:${group.sender}:${group.day}`, digestText, embedding, {
      sender: group.sender, day: group.day, subjects: [...group.subjects]
    });
    digests++;
  } catch (err) {
    console.error(`✗ digest ${key}: ${err.message}`);
  }
}
console.log(`✅ ${digests} digest(s) jour ré-intégré(s)`);

await closeDatabase();
