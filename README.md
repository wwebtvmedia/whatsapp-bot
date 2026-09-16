# WhatsApp AI Bot 🤖

A sophisticated WhatsApp bot built with Node.js, Baileys, MongoDB, and ChromaDB. It stores every received message in a hierarchical memory (message + per-day digests + contact/topic graph), indexes the **content of received documents**, and answers natural-language questions about all of it.

## 🚀 Features

- **WhatsApp Integration:** Powered by `@whiskeysockets/baileys`.
- **Media Management:** Automatically downloads and organizes media files (images, videos, etc.) by sender.
- **📄 Document Understanding:** Received PDFs, Word files and text documents are extracted, chunked and indexed into the vector memory; images are OCR'd (tesseract, on by default). Ask questions about their content in plain language.
- **Semantic Memory (GraphRAG):** Uses **ChromaDB** and a custom **Python Embedding Service** (multilingual E5 by default, configurable via `EMBEDDING_MODEL`) with hierarchical retrieval: coarse per-day digests → fine-grained messages/document chunks, plus a lexical fallback and a contact/topic **graph** (`/api/graph`).
- **AI-Powered Replies:** Generates automated or manual replies using **Ollama** or **Llama.cpp** via an OpenAI-compatible API.
- **Replies under control:** Auto-reply is **off for every contact by default** and toggled per contact from the web panel. With it off, the bot still drafts every reply and keeps it as a *proposed reply* — review and send it with one click. Every bot event lands in a persistent activity log shown in the panel.
- **📧 Email Ingestion (optional):** With `MAIL_ENABLED=true`, inbound emails land in the same memory as WhatsApp messages (IMAP listener with auto-reconnect), and `POST /api/send-email` sends mail via SMTP.
- **Database:** Uses **MongoDB** for persistent message and metadata storage.
- **REST API:** Control the bot, send messages/media/emails, and query memory via a built-in Express server.
- **Dockerized:** Fully containerized architecture for easy deployment.

## 🛠️ Architecture

- **Main Bot (Node.js):** Handles WhatsApp connection, document extraction, Express API, and orchestration.
- **Embedding Service (Python/FastAPI):** Generates vector embeddings for semantic search.
- **MongoDB:** Stores raw messages and application data.
- **ChromaDB:** Vector database for similarity search.
- **Llama.cpp (Optional):** Serve local LLMs for private, offline answer generation.

---

## 📋 Prerequisites

- [Podman](https://podman.io/) & [Podman Compose](https://github.com/containers/podman-compose)
- Node.js (v18+) - *Optional, for local development*
- Python 3.9+ - *Optional, for local development*

---

## ⚙️ Configuration

1. Create a `.env` file in the root directory (use `.env.example` as a template — it documents every variable, including the optional ones below).
2. Core variables:

```env
MONGO_URL=mongodb://mongo:27017/mcp
CHROMA_URL=http://chromadb:8000
EMBEDDING_URL=http://embeddings:8001/embed

# LLM Configuration
LLM_URL=http://llamacpp:8080/v1/chat/completions
LLM_MODEL=model
LLM_TYPE=openai

WHATSAPP_AUTH_PATH=./auth
DOWNLOADS_PATH=./downloads
SERVER_PORT=3000
API_TOKEN=YOUR_SECRET_TOKEN_HERE
```

> ℹ️ Messages are stored in the MongoDB database **`mcp`** (the name in `MONGO_URL` is informational; `initDatabase` uses its `mcp` default). Keep it in mind when browsing.

**Optional features** (all documented in `.env.example`):

| Variable | Default | Effect |
| :--- | :--- | :--- |
| `MEDIA_INDEXING` | `true` | Extract and index the text of received PDF/docx/text files. |
| `MEDIA_OCR_ENABLED` | `true` | OCR received images (tesseract, `eng+fra`; downloads language data on first use). |
| `MEDIA_MAX_CHUNKS` | `60` | Cap on indexed chunks per document (~50 pages). |
| `MAIL_ENABLED` | `false` | Ingest inbound emails (needs `MAIL_HOST`, `MAIL_USER`, `MAIL_PASS`, `MAIL_FROM`, `MAIL_IMAP_HOST`). |
| `DIGEST_EMBED_EVERY` / `CONTEXT_MAX_MESSAGES` | `5` / `6` | Memory tuning. |

### 🧠 LLM Setup (automatic)

`install.sh` picks the best available backend for you:

1. **Remote Ollama** — configured in `.env` (`OLLAMA_URL`, e.g. `http://192.168.1.x:11434`, model `OLLAMA_MODEL`, default `bestmodel:latest`). Used when the server is reachable; leave `OLLAMA_URL` empty to force the local fallback. One-shot overrides: `OLLAMA_REMOTE=... ./install.sh` or `REMOTE_MODEL=... ./install.sh`.
2. **Local llama.cpp** (fallback) — downloads a fast medium 7B model (Qwen2.5-7B-Instruct, Q4_K_M ~4.7 GB) to `models/model.gguf` and starts the bundled `llamacpp` service (`--profile local-llm`).

To run the local service manually: `podman-compose up -d --profile local-llm`.

---

## 🏃 How to Run

### One-command Install (Recommended)

```bash
./install.sh
```

Detects Podman or Docker automatically (installs Podman and `podman-compose` via `apt`/`dnf`/`pacman` if missing), creates `.env` on first run (with a generated `API_TOKEN`), prepares the data folders, then builds and starts the whole stack.

### Using Podman

```bash
# Build and start all services
podman-compose up -d --build

# View logs to scan the WhatsApp QR Code
podman-compose logs -f whatsapp-bot
```

### Local Development

1. **Start Databases** (Mongo, Chroma)
2. **Embedding Service:** `cd embedding-service && pip install -r requirements.txt && python main.py`
3. **Main Bot:** `npm install && npm start`

---

## 🖥️ Web Panel

Open `http://localhost:3000` and enter the `API_TOKEN` when prompted. The panel gives you:

- **Received information** — the full journal of everything the bot receives, grouped by day, with a live filter.
- **Proposed replies** — whenever a contact writes while auto-reply is **off** (the default), the bot still drafts an answer but does **not** send it. Drafts are listed here: review the incoming message and the drafted reply, then hit **Send** to deliver it, or leave it.
- **Auto-reply per contact** — one checkbox per contact. Unticked (default) = drafts only; ticked = the bot answers that contact automatically.
- **Ask the memory** — free-text questions answered from the stored memory, with the sources used.
- **Documents (RAG)** — every document the bot parsed and indexed (file name, sender, day, chunk count, extracted text). Ask questions about **all documents at once**, or pick one in the dropdown — retrieval then only searches the document chunks (`POST /api/ask` with `scope: "documents"`, optional `doc`).
- **Daily summaries** — per-contact, per-day digests maintained for retrieval.
- **Send message / media** — manual outgoing tools.
- **Bot log** — the persistent activity log: receptions, drafted/sent replies, WhatsApp connections, errors (auto-pruned after 7 days, also available at `GET /api/logs`).

A **Refresh** button and a 30 s auto-refresh cover every section.

---

## 🔌 API Endpoints

All API requests (except `/api/health`) require the header `x-api-token: YOUR_SECRET_TOKEN_HERE`.

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Check bot status and user info. |
| `POST` | `/api/send-message` | Send a text message. |
| `POST` | `/api/send-media` | Send a file (multipart/form-data). |
| `POST` | `/api/send-email` | Send an email (`MAIL_ENABLED` + SMTP config required). |
| `GET` | `/api/get-messages` | Retrieve recent messages from MongoDB. |
| `GET` | `/api/get-media` | Download the most recent media file (optional `?after=<ISO date>`). |
| `POST` | `/api/query-memory` | Semantic search through message history **and received documents** (PDF/docx/text are extracted and indexed; images via optional OCR — `MEDIA_OCR_ENABLED`). |
| `GET` | `/api/graph` | Contact/topic/mention graph built from message metadata (`?maxEdges=300`). |
| `GET` | `/api/digests` | Per-contact daily summaries (coarse memory level). |
| `POST` | `/api/ask` | Question → retrieval + LLM answer, **without sending anything** (same pipeline as replies). Optional `"scope": "documents"` restricts retrieval to the indexed document chunks and `"doc": "<file name>"` to a single document. |
| `GET` | `/api/documents` | Documents parsed and indexed into the RAG (file name, sender, day, chunks, extracted-text preview) — `?limit=100`. |
| `POST` | `/api/trigger-reply` | Generate and send AI replies to specific JIDs (respects the per-contact toggle; body `"force": true` overrides it). |
| `GET` | `/api/contacts` | Known contacts with their auto-reply flag and activity counters. |
| `POST` | `/api/contacts/auto-reply` | Toggle auto-reply per contact: `{"sender": "<jid>", "enabled": true|false}`. |
| `GET` | `/api/proposed-replies` | Replies drafted by the bot and awaiting review (`?limit=25`). |
| `POST` | `/api/proposed-replies/:id/send` | Send a proposed reply to its contact. |
| `GET` | `/api/logs` | Bot activity log (receptions, proposed/sent replies, connections, errors — `?limit=100`). |

---

## 📄 Asking Questions About Received Documents

Send any document (PDF, `.docx`, text file) or image to the bot. It is downloaded, its text is extracted (OCR for images), chunked and indexed. Then just ask:

- **On WhatsApp** (if auto-reply is enabled for that contact in the panel — off by default), in the same conversation:
  > *"quel est le montant de la facture ?"*
- **Through the API:**

```bash
TOKEN=$(grep '^API_TOKEN=' .env | cut -d= -f2)
curl -s -X POST -H "x-api-token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"quelle est la date d echeance de la facture ?"}' \
  http://localhost:3000/api/query-memory
```

The response includes `matches` (retrieved passages), `refs` (with the day and source) and `used` (retrieval diagnostics). Mentioning the document topic or period ("hier", "la facture") helps the hierarchical retrieval.

In the **web panel**, the *Documents (RAG)* section lists every parsed document and answers questions scoped to the documents only (all of them, or one picked in the dropdown):

```bash
curl -s -X POST -H "x-api-token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"quelle est la date d echeance ?","scope":"documents"}' \
  http://localhost:3000/api/ask
```

Limitations: scanned PDFs (image-only) are logged as `pdf-no-text`; audio/video are not transcribed; OCR needs internet access once to download language data.

---

## 🗂️ Browsing the Database

```bash
podman exec -it whatsapp-bot_mongo_1 mongosh
```

(Names may differ — check `podman ps`. With Docker Compose, use `docker compose exec mongo mongosh`.)

```js
use mcp                       // ← the database name
db.messages.find().sort({ timestamp: -1 }).limit(5)   // latest messages
db.messages.find({ "media.indexedChunks": { $gt: 0 } }) // indexed documents (media.extractedText = preview)
db.daily_digests.find()       // per-contact daily summaries
db.graph_edges.find().sort({ weight: -1 }).limit(10)
db.contact_settings.find()    // per-contact auto-reply toggles
db.proposed_replies.find()    // replies drafted but not sent (panel review)
db.bot_logs.find()            // bot activity log (auto-pruned after 7 days)
```

**MongoDB Compass** also works on `mongodb://localhost:27017` (the port is bound to `127.0.0.1` only).

---

## 📜 License

MIT
