// storage/database.js
import { MongoClient, ObjectId } from 'mongodb';
import { ChromaClient } from 'chromadb';

let messageCollection;
let digestCollection;   // conversation digests (hierarchical coarse level)
let graphCollection;    // lightweight edge store powering /api/graph
let contactSettingsCollection; // per-contact auto-reply toggle (panel-driven)
let proposedReplyCollection;   // LLM replies kept for review instead of being sent
let logCollection;      // bot activity log, readable from the panel
let chromaMessages;     // fine-grained level: every message
let chromaDays;         // coarse level: one embedding per sender+day
let mongoClient;        // kept so tests (or a shutdown hook) can disconnect

export function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

export async function initDatabase(mongoUrl, chromaUrl, dbName = 'mcp', collectionName = 'messages', chromaRawName = 'messages', chromaDaysName = 'conversation_days') {
  try {
    // MongoDB setup
    mongoClient = new MongoClient(mongoUrl);
    await mongoClient.connect();
    const db = mongoClient.db(dbName);
    messageCollection = db.collection(collectionName);
    digestCollection = db.collection('daily_digests');
    graphCollection = db.collection('graph_edges');
    await digestCollection.createIndex({ key: 1 }, { unique: true });
    await graphCollection.createIndex({ from: 1, edge: 1, to: 1 }, { unique: true });
    // Serves the contacts aggregation and getUnrepliedMessages
    await messageCollection.createIndex({ sender: 1, timestamp: -1 });

    contactSettingsCollection = db.collection('contact_settings');
    await contactSettingsCollection.createIndex({ sender: 1 }, { unique: true });

    proposedReplyCollection = db.collection('proposed_replies');
    // One proposal per incoming message; unique index + $setOnInsert keeps
    // Baileys' replayed upserts from duplicating or regressing a sent row
    await proposedReplyCollection.createIndex({ messageRef: 1 }, { unique: true });
    await proposedReplyCollection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

    logCollection = db.collection('bot_logs');
    // TTL index also serves the createdAt-descending reads
    await logCollection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });
    console.log('✅ Connected to MongoDB');

    // ChromaDB setup — two levels for hierarchical retrieval
    const chroma = new ChromaClient({ path: chromaUrl });
    chromaMessages = await chroma.getOrCreateCollection({ name: chromaRawName });
    chromaDays = await chroma.getOrCreateCollection({ name: chromaDaysName });
    console.log('✅ Connected to ChromaDB');

    return { messageCollection, chromaMessages, chromaDays };
  } catch (err) {
    console.error('❌ Failed to initialize databases:', err);
    throw err;
  }
}

// Close the Mongo connection so short-lived processes (the test runner) can
// exit instead of waiting on open sockets. The server never calls this.
export async function closeDatabase() {
  if (mongoClient) {
    await mongoClient.close();
    mongoClient = null;
    messageCollection = digestCollection = graphCollection = null;
    contactSettingsCollection = proposedReplyCollection = logCollection = null;
  }
}

// Driver <5 wraps findOneAndUpdate results in {value, lastErrorObject, ok};
// newer drivers return the document directly. Normalize to doc-or-null.
function unwrapFindOneAndUpdate(result) {
  if (result && typeof result === 'object' && 'value' in result) return result.value;
  return result ?? null;
}

// Chroma metadata must be flat scalars — arrays are joined, values truncated
function flatMetadata(meta = {}) {
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) out[k] = v.join(', ').slice(0, 200);
    else out[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  }
  return out;
}

export async function saveMessage(doc) {
  if (!messageCollection) throw new Error("Database not initialized");

  try {
    // Whitelist fields to avoid circular references or unsupported data types
    const {
      sender,
      jid, // alias for sender
      messageContent,
      timestamp,
      messageId,
      messageType,
      subject = 'general',
      infoType = 'info',
      entities = null,
      replied = false,
      autoReply = false,
      embedding = null,
      media = null
    } = doc;

    // Only include serializable and relevant media info
    const sanitizedMedia = media
      ? {
          filePath: media.filePath,
          fileName: media.fileName,
        }
      : null;

    const cleanDoc = {
      sender: jid || sender,
      messageContent,
      timestamp: timestamp instanceof Date ? timestamp : new Date(Number(timestamp) * 1000),
      messageId,
      messageType,
      subject,
      infoType,
      entities,
      replied,
      autoReply,
      embedding,
      media: sanitizedMedia,
    };

    const result = await messageCollection.insertOne(cleanDoc);
    console.log(`📦 Message saved: ${result.insertedId}`);
    return result.insertedId;

  } catch (err) {
    console.error('❌ Failed to save message to MongoDB:', {
      error: err.message,
      stack: err.stack,
      input: { ...(doc?.messageId ? { messageId: doc.messageId } : {}) }
    });
    throw new Error('saveMessage failed: ' + err.message);
  }
}

export async function upsertChromaMessage(id, text, embedding, metadata = {}) {
  try {
    if (!chromaMessages) throw new Error("ChromaDB not initialized");
    await chromaMessages.upsert({
      ids: [id],
      embeddings: [embedding],
      documents: [text],
      metadatas: [flatMetadata(metadata)]
    });
  } catch (err) {
    console.error(`❌ Failed to upsert into ChromaDB (ID: ${id}):`, err.message);
  }
}

export async function upsertChromaDay(id, text, embedding, metadata = {}) {
  try {
    if (!chromaDays) throw new Error("ChromaDB not initialized");
    await chromaDays.upsert({
      ids: [id],
      embeddings: [embedding],
      documents: [text],
      metadatas: [flatMetadata(metadata)]
    });
  } catch (err) {
    console.error(`❌ Failed to upsert day digest into ChromaDB (ID: ${id}):`, err.message);
  }
}

// Batch upsert for document chunks ({id, text, embedding, metadata} items)
export async function upsertChromaDocChunks(items) {
  try {
    if (!chromaMessages) throw new Error("ChromaDB not initialized");
    if (!items.length) return;
    await chromaMessages.upsert({
      ids: items.map(i => i.id),
      embeddings: items.map(i => i.embedding),
      documents: items.map(i => i.text),
      metadatas: items.map(i => flatMetadata(i.metadata))
    });
  } catch (err) {
    console.error('❌ Failed to upsert document chunks into ChromaDB:', err.message);
  }
}

export async function queryChromaDays(queryEmbedding, nResults = 3, where = undefined) {
  if (!chromaDays) throw new Error("ChromaDB not initialized");
  const params = {
    queryEmbeddings: [queryEmbedding],
    nResults,
    include: ['documents', 'metadatas', 'distances']
  };
  if (where) params.where = where;
  return chromaDays.query(params);
}

export async function queryChromaMessages(queryEmbedding, nResults = 8, where = undefined) {
  if (!chromaMessages) throw new Error("ChromaDB not initialized");
  const params = {
    queryEmbeddings: [queryEmbedding],
    nResults,
    include: ['documents', 'metadatas', 'distances']
  };
  if (where) params.where = where;
  return chromaMessages.query(params);
}

// --- Daily digests: coarse hierarchical level (one doc per sender+day) ---

export async function upsertDailyDigest({ key, sender, day, subject, text }) {
  const doc = await digestCollection.findOneAndUpdate(
    { key },
    {
      $setOnInsert: { key, sender, day, createdAt: new Date() },
      $set: { updatedAt: new Date() },
      $inc: { count: 1 },
      $addToSet: { subjects: subject },
      $push: { texts: { $each: [text], $slice: -60 } }
    },
    { upsert: true, returnDocument: 'after' }
  );
  // Unwrapped, or server.js would read `undefined` off the driver envelope and
  // never refresh the day-digest embedding
  return unwrapFindOneAndUpdate(doc);
}

export async function getDailyDigest(key) {
  return digestCollection.findOne({ key });
}

// Recent per-contact daily summaries, newest activity first (for the panel)
export async function getDailyDigests(limit = 50) {
  try {
    if (!digestCollection) throw new Error("MongoDB not initialized");
    return await digestCollection.find().sort({ updatedAt: -1 }).limit(limit).toArray();
  } catch (err) {
    console.error('❌ Failed to get daily digests:', err);
    return [];
  }
}

// --- Graph edges: zero-cost graph material, built from metadata only ---

export async function upsertGraphEdge({ from, edge, to, ref }) {
  try {
    await graphCollection.updateOne(
      { from, edge, to },
      {
        $set: { updatedAt: new Date() },
        $inc: { weight: 1 },
        $addToSet: { refs: ref }
      },
      { upsert: true }
    );
  } catch (err) {
    console.error(`❌ Failed to upsert graph edge ${from} -[${edge}]-> ${to}:`, err.message);
  }
}

// Return a pruned graph (top nodes/edges by weight) to keep payloads small
export async function getGraph(maxEdges = 300) {
  const edges = await graphCollection
    .find({})
    .sort({ weight: -1 })
    .limit(maxEdges)
    .toArray();

  const nodes = new Map();
  const nodeType = (id) => {
    if (id.includes('@')) return 'contact';
    if (/^\+?\d{6,}$/.test(id)) return 'phone';
    if (/^https?:\/\//.test(id)) return 'url';
    return 'topic';
  };
  for (const e of edges) {
    for (const id of [e.from, e.to]) {
      if (!nodes.has(id)) nodes.set(id, { id, type: nodeType(id) });
    }
  }
  return {
    nodes: [...nodes.values()],
    edges: edges.map(e => ({ from: e.from, to: e.to, edge: e.edge, weight: e.weight, refs: (e.refs || []).slice(-5) }))
  };
}

// --- Hybrid keyword fallback (lexical search in MongoDB) ---

export async function hybridKeywordSearch(query, limit = 6) {
  try {
    if (!messageCollection) throw new Error("MongoDB not initialized");
    const words = [...new Set(
      query.toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 4)
    )].slice(0, 5);

    if (words.length === 0) return [];
    const escaped = words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const regex = new RegExp(escaped.join('|'), 'i');
    return await messageCollection
      .find({ messageContent: { $regex: regex } })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
  } catch (err) {
    console.error('❌ Hybrid keyword search failed:', err);
    return [];
  }
}

export async function getRecentMessages(limitOrCollection = 20) {
  try {
    const limit = typeof limitOrCollection === 'number' ? limitOrCollection : 20;
    if (!messageCollection) throw new Error("MongoDB not initialized");
    return await messageCollection.find().sort({ timestamp: -1 }).limit(limit).toArray();
  } catch (err) {
    console.error('❌ Failed to get recent messages:', err);
    return [];
  }
}

export async function getLatestMedia(after = null) {
  try {
    if (!messageCollection) throw new Error("MongoDB not initialized");
    const query = {
      'media.filePath': { $exists: true, $ne: null },
      ...(after ? { timestamp: { $gt: new Date(after) } } : {})
    };
    return await messageCollection.find(query).sort({ timestamp: -1 }).limit(1).next();
  } catch (err) {
    console.error('❌ Failed to get latest media:', err);
    return null;
  }
}

export async function updateRepliedStatus(messageId) {
  try {
    if (!messageCollection) throw new Error("MongoDB not initialized");
    const id = typeof messageId === 'string' ? new ObjectId(messageId) : messageId;
    await messageCollection.updateOne({ _id: id }, { $set: { replied: true } });
  } catch (err) {
    console.error(`❌ Failed to update replied status for ${messageId}:`, err);
  }
}

// Record what was extracted from a media file, so the DB is browsable
// (also useful to spot scanned PDFs: extractedText empty + indexedChunks 0)
export async function setMediaExtracted(messageId, { text = '', chunks = 0 }) {
  try {
    if (!messageCollection) throw new Error("MongoDB not initialized");
    const id = typeof messageId === 'string' ? new ObjectId(messageId) : messageId;
    await messageCollection.updateOne(
      { _id: id },
      { $set: { 'media.extractedText': (text || '').slice(0, 4000), 'media.indexedChunks': chunks } }
    );
  } catch (err) {
    console.error(`❌ Failed to record extraction result for ${messageId}:`, err.message);
  }
}

export async function getUnrepliedMessages(sender, limit = 10) {
  try {
    if (!messageCollection) throw new Error("MongoDB not initialized");
    return await messageCollection.find({ sender, replied: false }).limit(limit).toArray();
  } catch (err) {
    console.error('❌ Failed to get unreplied messages:', err);
    return [];
  }
}

// --- Per-contact auto-reply settings (default: off, toggled from the panel) ---

export async function getContactSettings(sender) {
  try {
    if (!contactSettingsCollection) throw new Error("MongoDB not initialized");
    const doc = await contactSettingsCollection.findOne({ sender });
    // Default synthesized: a contact never toggled must not be auto-replied to
    return doc || { sender, autoReply: false };
  } catch (err) {
    console.error(`❌ Failed to get contact settings for ${sender}:`, err.message);
    return { sender, autoReply: false };
  }
}

export async function setContactAutoReply(sender, enabled) {
  if (!contactSettingsCollection) throw new Error("MongoDB not initialized");
  const result = await contactSettingsCollection.findOneAndUpdate(
    { sender },
    {
      $set: { autoReply: !!enabled, updatedAt: new Date() },
      $setOnInsert: { sender, createdAt: new Date() }
    },
    { upsert: true, returnDocument: 'after' }
  );
  return unwrapFindOneAndUpdate(result);
}

// Contacts known from received messages, merged with their auto-reply setting
export async function getContactsWithActivity(limit = 200) {
  try {
    if (!messageCollection || !contactSettingsCollection) throw new Error("MongoDB not initialized");
    const activity = await messageCollection.aggregate([
      { $group: {
        _id: '$sender',
        lastAt: { $max: '$timestamp' },
        total: { $sum: 1 },
        unreplied: { $sum: { $cond: [{ $eq: ['$replied', false] }, 1, 0] } }
      } },
      { $sort: { lastAt: -1 } },
      { $limit: limit }
    ]).toArray();

    const settings = await contactSettingsCollection.find().toArray();
    const bySender = new Map(settings.map(s => [s.sender, s]));
    return activity.map(a => ({
      sender: a._id,
      lastAt: a.lastAt,
      total: a.total,
      unreplied: a.unreplied,
      autoReply: bySender.get(a._id)?.autoReply ?? false
    }));
  } catch (err) {
    console.error('❌ Failed to list contacts:', err);
    return [];
  }
}

// --- Proposed replies: generated but kept for review instead of being sent ---

export async function saveProposedReply({ sender, messageRef, incoming, reply, refs = [], method = 'auto', status = 'proposed', whatsappId = null }) {
  try {
    if (!proposedReplyCollection) throw new Error("MongoDB not initialized");
    // $setOnInsert only: a replayed message must never overwrite/reset a row
    const result = await proposedReplyCollection.updateOne(
      { messageRef },
      { $setOnInsert: {
        sender,
        messageRef,
        incoming: (incoming || '').slice(0, 500),
        reply,
        refs: refs.slice(0, 10),
        method,
        status,
        whatsappId,
        createdAt: new Date()
      } },
      { upsert: true }
    );
    return result.upsertedId ?? null;
  } catch (err) {
    console.error('❌ Failed to save proposed reply:', err.message);
    return null;
  }
}

export async function getRecentProposedReplies(limit = 25) {
  try {
    if (!proposedReplyCollection) throw new Error("MongoDB not initialized");
    // Self-heal sends that crashed or hung mid-flight
    await proposedReplyCollection.updateMany(
      { status: 'sending', claimedAt: { $lt: new Date(Date.now() - 60000) } },
      { $set: { status: 'failed', error: 'send timed out' } }
    );
    return await proposedReplyCollection.find().sort({ createdAt: -1 }).limit(limit).toArray();
  } catch (err) {
    console.error('❌ Failed to get proposed replies:', err);
    return [];
  }
}

// Atomic claim so a double-click (or a refresh race) cannot send twice
export async function claimProposedReply(id) {
  try {
    if (!proposedReplyCollection) throw new Error("MongoDB not initialized");
    const _id = typeof id === 'string' ? new ObjectId(id) : id;
    const result = await proposedReplyCollection.findOneAndUpdate(
      { _id, status: 'proposed' },
      { $set: { status: 'sending', claimedAt: new Date() } },
      { returnDocument: 'after' }
    );
    return unwrapFindOneAndUpdate(result);
  } catch (err) {
    console.error(`❌ Failed to claim proposed reply ${id}:`, err.message);
    return null;
  }
}

export async function markProposedReplySent(id, { whatsappId = null } = {}) {
  try {
    if (!proposedReplyCollection) throw new Error("MongoDB not initialized");
    const _id = typeof id === 'string' ? new ObjectId(id) : id;
    await proposedReplyCollection.updateOne(
      { _id },
      { $set: { status: 'sent', sentAt: new Date(), whatsappId } }
    );
  } catch (err) {
    console.error(`❌ Failed to mark proposed reply ${id} as sent:`, err.message);
  }
}

export async function markProposedReplyFailed(id, error) {
  try {
    if (!proposedReplyCollection) throw new Error("MongoDB not initialized");
    const _id = typeof id === 'string' ? new ObjectId(id) : id;
    await proposedReplyCollection.updateOne(
      { _id },
      { $set: { status: 'failed', error: String(error).slice(0, 300) } }
    );
  } catch (err) {
    console.error(`❌ Failed to mark proposed reply ${id} as failed:`, err.message);
  }
}

// --- Bot activity log: persistent, readable from the panel ---

export async function saveLog(event, details = {}) {
  try {
    if (!logCollection) return null; // callable before initDatabase completes
    const { level = 'info', ...rest } = details;
    const flat = {};
    for (const [k, v] of Object.entries(rest)) {
      if (v === null || v === undefined) continue;
      flat[k] = String(v).slice(0, 300);
    }
    return await logCollection.insertOne({ level, event, details: flat, createdAt: new Date() });
  } catch (err) {
    console.error('❌ Failed to write bot log:', err.message);
    return null;
  }
}

export async function getRecentLogs(limit = 100) {
  try {
    if (!logCollection) throw new Error("MongoDB not initialized");
    return await logCollection.find().sort({ createdAt: -1 }).limit(limit).toArray();
  } catch (err) {
    console.error('❌ Failed to get bot logs:', err);
    return [];
  }
}
