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
# 4. LLM model check (needed for auto-replies, everything else works without)
# ---------------------------------------------------------------------------
if [ ! -f models/model.gguf ]; then
  echo "⚠️  models/model.gguf not found — the LLM service will stay down."
  echo "    Download a GGUF model (e.g. Qwen2 or Llama-3), rename it to"
  echo "    model.gguf and put it in models/. The bot starts fine without it;"
  echo "    auto-replies will fail until the model is in place."
fi

# ---------------------------------------------------------------------------
# 5. Build and start the stack
# ---------------------------------------------------------------------------
echo "🏗️  Building and starting services (first build downloads ~1 GB)..."
$COMPOSE up -d --build

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
