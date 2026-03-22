// storage/database.js
import { MongoClient, ObjectId } from 'mongodb';
import { ChromaClient } from 'chromadb';

let messageCollection;
let chromaCollection;

export async function initDatabase(mongoUrl, chromaUrl, dbName = 'mcp', collectionName = 'messages', chromaCollectionName = 'messages') {
  try {
    // MongoDB setup
    const mongoClient = new MongoClient(mongoUrl);
    await mongoClient.connect();
    const db = mongoClient.db(dbName);
    messageCollection = db.collection(collectionName);
    console.log('✅ Connected to MongoDB');

    // ChromaDB setup
    const chroma = new ChromaClient({ path: chromaUrl });
    chromaCollection = await chroma.getOrCreateCollection({ name: chromaCollectionName });
    console.log('✅ Connected to ChromaDB');

    return { messageCollection, chromaCollection };
  } catch (err) {
    console.error('❌ Failed to initialize databases:', err);
    throw err;
  }
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
      'media.filePath': { $exists: true },
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

export async function insertIntoChroma(id, text, embedding, metadata = {}) {
  try {
    if (!chromaCollection) throw new Error("ChromaDB not initialized");

    await chromaCollection.add({
      ids: [id],
      embeddings: [embedding],
      documents: [text],
      metadatas: [typeof metadata === 'string' ? { sender: metadata } : metadata]
    });

    console.log(`🧠 Stored embedding for message ID ${id}`);
  } catch (err) {
    console.error(`❌ Failed to insert into ChromaDB (ID: ${id}):`, err);
  }
}
