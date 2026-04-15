# WhatsApp AI Bot 🤖

A sophisticated WhatsApp bot built with Node.js, Baileys, MongoDB, and ChromaDB. It features automatic message storage, media downloading, semantic search (vector memory), and an AI-powered reply system.

## 🚀 Features

- **WhatsApp Integration:** Powered by `@whiskeysockets/baileys`.
- **Media Management:** Automatically downloads and organizes media files (images, videos, etc.) by sender.
- **Semantic Memory:** Uses **ChromaDB** and a custom **Python Embedding Service** (`all-MiniLM-L6-v2`) to store and query message context.
- **AI-Powered Replies:** Generates automated or manual replies using **Ollama** or **Llama.cpp** via an OpenAI-compatible API.
- **Database:** Uses **MongoDB** for persistent message and metadata storage.
- **REST API:** Control the bot, send messages/media, and query memory via a built-in Express server.
- **Dockerized:** Fully containerized architecture for easy deployment.

## 🛠️ Architecture

- **Main Bot (Node.js):** Handles WhatsApp connection, Express API, and orchestration.
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

1. Create a `.env` file in the root directory (use `.env.example` as a template).
2. Configure your environment variables:

```env
MONGO_URL=mongodb://mongo:27017/whatsapp-bot
CHROMA_URL=http://chromadb:8000
EMBEDDING_URL=http://embeddings:8001/embed

# LLM Configuration
LLM_URL=http://llamacpp:8080/v1/chat/completions
LLM_MODEL=model
LLM_TYPE=openai
AUTO_REPLY=true

WHATSAPP_AUTH_PATH=./auth
DOWNLOADS_PATH=./downloads
SERVER_PORT=3000
API_TOKEN=your-secret-token
```

### 🧠 LLM Setup (Llama.cpp)

1. Create a `models/` directory in the root.
2. Download a GGUF model (e.g., Qwen2 or Llama-3) and place it in `models/model.gguf`.
3. Set `LLM_TYPE=openai` and `LLM_URL=http://llamacpp:8080/v1/chat/completions` in your `.env`.

---

## 🏃 How to Run

### Using Podman (Recommended)

```bash
# Build and start all services
podman-compose up -d --build

# View logs to scan the WhatsApp QR Code
podman logs -f whatsapp-bot
```

### Local Development

1. **Start Databases** (Mongo, Chroma)
2. **Embedding Service:** `cd embedding-service && pip install -r requirements.txt && python main.py`
3. **Main Bot:** `npm install && npm start`

---

## 🔌 API Endpoints

All API requests (except `/api/health`) require the header `x-api-token: your-secret-token`.

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Check bot status and user info. |
| `POST` | `/api/send-message` | Send a text message. |
| `POST` | `/api/send-media` | Send a file (multipart/form-data). |
| `GET` | `/api/get-messages` | Retrieve recent messages from MongoDB. |
| `POST` | `/api/query-memory` | Semantic search through message history. |
| `POST` | `/api/trigger-reply` | Generate and send AI replies to specific JIDs. |

---

## 📜 License

MIT
