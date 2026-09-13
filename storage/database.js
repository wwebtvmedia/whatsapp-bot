// storage/database.js
import { MongoClient, ObjectId } from 'mongodb';
import { ChromaClient } from 'chromadb';

let messageCollection;
let digestCollection;   // conversation digests (hierarchical coarse level)
let graphCollection;    // lightweight edge store powering /api/graph
let chromaMessages;     // fine-grained level: every message
let chromaDays;         // coarse level: one embedding per sender+day

export function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

export async function initDatabase(mongoUrl, chromaUrl, dbName = 'mcp', collectionName = 'messages', chromaRawName = 'messages', chromaDaysName = 'conversation_days') {
  try {
    // MongoDB setup
    const mongoClient = new MongoClient(mongoUrl);
    await mongoClient.connect();
    const db = mongoClient.db(dbName);
    messageCollection = db.collection(collectionName);
    digestCollection = db.collection('daily_digests');
    graphCollection = db.collection('graph_edges');
    await digestCollection.createIndex({ key: 1 }, { unique: true });
    await graphCollection.createIndex({ from: 1, edge: 1, to: 1 }, { unique: true });
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
  return doc;
}

export async function getDailyDigest(key) {
  return digestCollection.findOne({ key });
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

export async function getUnrepliedMessages(sender, limit = 10) {
  try {
    if (!messageCollection) throw new Error("MongoDB not initialized");
    return await messageCollection.find({ sender, replied: false }).limit(limit).toArray();
  } catch (err) {
    console.error('❌ Failed to get unreplied messages:', err);
    return [];
  }
}
