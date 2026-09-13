#!/usr/bin/env bash
# 🚀 WhatsApp AI Bot — easy installer
#
# Detects the container engine available on this platform, creates .env on
# first run (with a generated API token), prepares the data folders, then
# builds and starts the whole stack.
set -euo pipefail

cd "$(dirname "$0")"

echo "🤖 WhatsApp AI Bot — installation"

# ---------------------------------------------------------------------------
# 1. Detect container engine + compose (Podman first, Docker as fallback)
# ---------------------------------------------------------------------------
if command -v podman-compose >/dev/null 2>&1; then
  COMPOSE="podman-compose"
elif command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
  COMPOSE="podman compose"
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "❌ No container engine found."
  echo "   Install Podman first: https://podman.io/docs/installation"
  exit 1
fi
echo "✔️  Using: $COMPOSE"

# ---------------------------------------------------------------------------
# 2. Create .env from the template on first run
# ---------------------------------------------------------------------------
if [ ! -f .env ]; then
  cp .env.example .env
  if command -v openssl >/dev/null 2>&1; then
    TOKEN=$(openssl rand -hex 24)
  else
    TOKEN=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  fi
  sed -i "s|^API_TOKEN=.*|API_TOKEN=${TOKEN}|" .env
  echo "✔️  .env created (API_TOKEN generated automatically)"
else
  echo "✔️  .env already exists — keeping your configuration"
fi

# ---------------------------------------------------------------------------
# 3. Ensure runtime directories exist (rootless engines don't create mounts)
# ---------------------------------------------------------------------------
mkdir -p models downloads auth backups data/db data/chroma embedding-service/cache

# ---------------------------------------------------------------------------
# 4. LLM backend: prefer the remote Ollama server, fall back to a local GGUF
# ---------------------------------------------------------------------------
OLLAMA_REMOTE="${OLLAMA_REMOTE:-http://192.168.1.194:11434}"
REMOTE_MODEL="${REMOTE_MODEL:-bestmodel:latest}"
# Fast medium 7B-class model (Q4_K_M quant, ~4.7 GB), good on CPU-only hosts
GGUF_URL="https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf"

set_llm_env() {
  sed -i "s|^LLM_URL=.*|LLM_URL=$1|" .env
  sed -i "s|^LLM_TYPE=.*|LLM_TYPE=$2|" .env
  sed -i "s|^LLM_MODEL=.*|LLM_MODEL=$3|" .env
}

USE_LOCAL_LLM=1
REMOTE_TAGS=$(curl -s --max-time 5 "$OLLAMA_REMOTE/api/tags" || true)

if echo "$REMOTE_TAGS" | grep -q "\"name\":\"$REMOTE_MODEL\""; then
  echo "✔️  Remote Ollama found at $OLLAMA_REMOTE — using '$REMOTE_MODEL'"
  set_llm_env "$OLLAMA_REMOTE/api/chat" ollama "$REMOTE_MODEL"
  USE_LOCAL_LLM=0
elif [ -n "$REMOTE_TAGS" ]; then
  echo "⚠️  Ollama reachable at $OLLAMA_REMOTE but '$REMOTE_MODEL' is missing."
  echo "    Models available on the remote:"
  echo "$REMOTE_TAGS" | tr ',' '\n' | grep '"name"' | cut -d'"' -f4 | grep -v '^name$' | sed 's/^/      - /'
  echo "    Falling back to a local model."
fi

if [ "$USE_LOCAL_LLM" = "1" ]; then
  if [ -f models/model.gguf ]; then
    echo "✔️  Local model found: models/model.gguf"
  else
    echo "⬇️  Downloading Qwen2.5-7B-Instruct (Q4_K_M, ~4.7 GB)..."
    curl -L -C - --fail --progress-bar -o models/model.gguf "$GGUF_URL"
  fi
  set_llm_env "http://llamacpp:8080/v1/chat/completions" openai model
fi

# ---------------------------------------------------------------------------
# 5. Build and start the stack (llamacpp only when running a local model)
# ---------------------------------------------------------------------------
echo "🏗️  Building and starting services (first build downloads ~1 GB)..."
if [ "$USE_LOCAL_LLM" = "1" ]; then
  $COMPOSE up -d --build --profile local-llm
else
  $COMPOSE up -d --build
fi

cat <<EOF

✅ Installation complete!

Next steps:
  1. Scan the WhatsApp QR code with your phone:
       $COMPOSE logs -f whatsapp-bot
  2. Open the control panel:
       http://localhost:3000
     (the API token is in .env → API_TOKEN)
  3. Stop everything later with:
       $COMPOSE down
EOF
