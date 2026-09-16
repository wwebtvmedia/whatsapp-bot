#!/usr/bin/env bash
# 🚀 WhatsApp AI Bot — easy installer
#
# Detects the container engine available on this platform, creates .env on
# first run (with a generated API token), prepares the data folders, then
# builds and starts the whole stack.
set -euo pipefail

cd "$(dirname "$0")"

# ANSI colors — errors must be impossible to miss in a long build log
RED=$'\033[0;31m'
YEL=$'\033[0;33m'
NC=$'\033[0m'

echo "🤖 WhatsApp AI Bot — installation"

# ---------------------------------------------------------------------------
# 0. Mode: full init (default), clean restart or clean stop. Host data
#    (Mongo, Chroma, downloads, WhatsApp session, model) is always kept.
# ---------------------------------------------------------------------------
MODE="install"
usage() {
  echo "Usage: ./install.sh [--restart|--stop]"
  echo "  (default)   full init: cleanup, engine check, .env, LLM backend, build + start"
  echo "  --restart   cleanly stop, then start the stack again (no rebuild, data kept)"
  echo "  --stop      cleanly stop the stack (data kept)"
}
case "${1:-}" in
  ""|install) ;;
  --restart|restart) MODE="restart" ;;
  --stop|stop) MODE="stop" ;;
  -h|--help) usage; exit 0 ;;
  *) echo "${RED}❌ Unknown option: $1${NC}"; usage; exit 1 ;;
esac

# Name the phase being installed, so a failure points at the right block and
# the full underlying error can be read in the output above.
CURRENT_STEP="startup"
step() {
  CURRENT_STEP="$1"
  echo ""
  echo "▶️  $1"
}
on_error() {
  local code=$?
  echo ""
  echo "${RED}❌ Installation failed during: $CURRENT_STEP (exit code $code)${NC}"
  echo "${RED}   The full error is printed above; nothing is silenced.${NC}"
  echo "${RED}   To trace every command, re-run: bash -x ./install.sh${NC}"
  exit "$code"
}
trap on_error ERR

# ---------------------------------------------------------------------------
# 1. Detect (or install) container engine + compose (Podman first, Docker fallback)
# ---------------------------------------------------------------------------
step "Container engine + compose (podman/docker)"
SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

pkg_install() {
  if command -v apt-get >/dev/null 2>&1; then $SUDO apt-get update && $SUDO apt-get install -y "$@"
  elif command -v dnf >/dev/null 2>&1; then $SUDO dnf install -y "$@"
  elif command -v yum >/dev/null 2>&1; then $SUDO yum install -y "$@"
  elif command -v pacman >/dev/null 2>&1; then $SUDO pacman -S --noconfirm "$@"
  else
    return 1
  fi
}

ENGINE=""
if command -v podman >/dev/null 2>&1; then
  ENGINE="podman"
elif command -v docker >/dev/null 2>&1; then
  ENGINE="docker"
fi

if [ -z "$ENGINE" ]; then
  echo "📦 No container engine found — installing Podman..."
  if pkg_install podman; then
    ENGINE="podman"
  else
    echo "${RED}❌ Could not install Podman automatically (package-manager error above).${NC}"
    echo "   Install it manually: https://podman.io/docs/installation"
    exit 1
  fi
fi

COMPOSE=""
if [ "$ENGINE" = "podman" ]; then
  if command -v podman-compose >/dev/null 2>&1; then
    COMPOSE="podman-compose"
  elif podman compose version >/dev/null 2>&1; then
    COMPOSE="podman compose"
  elif pkg_install podman-compose && command -v podman-compose >/dev/null 2>&1; then
    COMPOSE="podman-compose"
  fi
else
  if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
  fi
fi

if [ -z "$COMPOSE" ]; then
  echo "${RED}❌ $ENGINE is installed, but the automatic podman-compose install failed (error above).${NC}"
  echo "   Install one manually: apt install podman-compose  (or: pipx install podman-compose)"
  exit 1
fi
echo "✔️  Using: $COMPOSE"

# ---------------------------------------------------------------------------
# 2. Clean leftovers from previous runs — BEFORE anything long-running.
#    A stack that didn't shut down cleanly keeps its container names
#    (whatsapp-bot_mongo_1, ...) and makes the final `up` fail with
#    "the container name ... is already in use" — at the very end of the
#    build. Cleaning first turns that late failure into a fast startup.
#    Host data (bind mounts) is never touched.
# ---------------------------------------------------------------------------
ENGINE_BIN="$ENGINE" # podman | docker — used for engine-level cleanup below
PROJECT_NAME="$(basename "$PWD" | tr '[:upper:]' '[:lower:]')"

remove_leftover_containers() {
  local leftovers
  leftovers="$("$ENGINE_BIN" ps -a --format '{{.Names}}' 2>/dev/null | grep -E "^${PROJECT_NAME}[_-]" || true)"
  if [ -n "$leftovers" ]; then
    echo "🧹 Removing leftover containers: $(echo "$leftovers" | tr '\n' ' ')"
    if ! echo "$leftovers" | xargs -r "$ENGINE_BIN" rm -f >/dev/null 2>&1; then
      echo "${YEL}⚠️  Could not remove some leftovers — if the start fails on a name conflict, run: $ENGINE_BIN rm -f \$(${ENGINE_BIN} ps -aq --filter name=${PROJECT_NAME})${NC}"
    fi
  fi
}

stop_stack() {
  step "Stopping the stack"
  # The profile goes BEFORE the subcommand (podman-compose only parses it
  # there) and is always passed on down: llamacpp may still be running from an
  # older .env.
  if ! $COMPOSE --profile local-llm down --remove-orphans; then
    $COMPOSE down || true
  fi
  remove_leftover_containers
}

prune_dangling_images() {
  # Untagged images from previous builds pile up (GBs each). Prune only the
  # dangling ones — tagged images of other projects are never touched.
  if "$ENGINE_BIN" image prune -f >/dev/null 2>&1; then
    echo "🧹 Dangling images from previous builds pruned"
  else
    echo "${YEL}⚠️  Could not prune dangling images (harmless — they only waste disk space)${NC}"
  fi
}

if [ "$MODE" = "install" ]; then
  stop_stack
  prune_dangling_images
fi

# ---------------------------------------------------------------------------
# 3. Create .env from the template on first run
# ---------------------------------------------------------------------------
step "Creating .env (first run only)"
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
# 4. Ensure runtime directories exist (rootless engines don't create mounts)
# ---------------------------------------------------------------------------
step "Preparing data folders"
mkdir -p models downloads auth backups data/db data/chroma embedding-service/cache

# ---------------------------------------------------------------------------
# 5. LLM backend: prefer the remote Ollama server, fall back to a local GGUF.
#    Restart/stop skip the probing and the .env rewrite entirely — the
#    llamacpp profile is derived from the LLM_URL already in .env.
# ---------------------------------------------------------------------------
# Read a value from .env without executing it ($2 = fallback)
env_val() {
  local v
  v=$(grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  echo "${v:-$2}"
}

USE_LOCAL_LLM=0
if [ "$MODE" != "install" ]; then
  case "$(env_val LLM_URL "")" in *llamacpp:8080*) USE_LOCAL_LLM=1 ;; esac
else
  step "Choosing the LLM backend"

  # Precedence: environment variable > .env > empty (local llama.cpp fallback)
  OLLAMA_REMOTE="${OLLAMA_REMOTE:-$(env_val OLLAMA_URL "")}"
  REMOTE_MODEL="${REMOTE_MODEL:-$(env_val OLLAMA_MODEL bestmodel:latest)}"
  # Fast medium 7B-class model (Q4_K_M quant, ~4.7 GB), good on CPU-only hosts
  GGUF_URL="https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf"

  set_llm_env() {
    sed -i "s|^LLM_URL=.*|LLM_URL=$1|" .env
    sed -i "s|^LLM_TYPE=.*|LLM_TYPE=$2|" .env
    sed -i "s|^LLM_MODEL=.*|LLM_MODEL=$3|" .env
  }

  USE_LOCAL_LLM=1
  if [ -z "$OLLAMA_REMOTE" ]; then
    echo "ℹ️  OLLAMA_URL is empty in .env — local llama.cpp model only"
    REMOTE_TAGS=""
  else
    REMOTE_TAGS=$(curl -s --max-time 5 "$OLLAMA_REMOTE/api/tags" || true)
  fi

  if echo "$REMOTE_TAGS" | grep -qF "\"name\":\"$REMOTE_MODEL\""; then
    echo "✔️  Remote Ollama found at $OLLAMA_REMOTE — using '$REMOTE_MODEL'"
    set_llm_env "$OLLAMA_REMOTE/api/chat" ollama "$REMOTE_MODEL"
    USE_LOCAL_LLM=0
  elif [ -n "$REMOTE_TAGS" ]; then
    echo "${YEL}⚠️  Ollama reachable at $OLLAMA_REMOTE but '$REMOTE_MODEL' is missing.${NC}"
    # grep -o parsing: the old cut -d'"' -f4 picked the wrong field and
    # grep -v exited 1 on empty input, killing the whole install under pipefail
    REMOTE_MODEL_LIST=$(echo "$REMOTE_TAGS" | grep -o '"name":"[^"]*"' | cut -d'"' -f4 || true)
    if [ -n "$REMOTE_MODEL_LIST" ]; then
      echo "    Models available on the remote:"
      echo "$REMOTE_MODEL_LIST" | sed 's/^/      - /'
    fi
    echo "    Falling back to a local model."
  elif [ -n "$OLLAMA_REMOTE" ]; then
    echo "${YEL}⚠️  Ollama not reachable at $OLLAMA_REMOTE — falling back to a local model.${NC}"
    echo "    (Check OLLAMA_URL in .env, or empty it to pick local without this warning.)"
  fi

  if [ "$USE_LOCAL_LLM" = "1" ]; then
    if [ -f models/model.gguf ]; then
      echo "✔️  Local model found: models/model.gguf"
    else
      echo "⬇️  Downloading Qwen2.5-7B-Instruct (Q4_K_M, ~4.7 GB)..."
      if ! curl -L -C - --fail --progress-bar -o models/model.gguf "$GGUF_URL"; then
        echo "${RED}❌ Model download failed (curl error above).${NC}"
        echo "   Resume it manually with:"
        echo "     curl -L -C - --fail -o models/model.gguf '$GGUF_URL'"
        exit 1
      fi
    fi
    set_llm_env "http://llamacpp:8080/v1/chat/completions" openai model
  fi
fi

# Clean stop: containers and networks go away, host data stays.
if [ "$MODE" = "stop" ]; then
  stop_stack
  echo ""
  echo "✅ Stack stopped — data and WhatsApp session kept."
  echo "   Start it again with: ./install.sh --restart"
  exit 0
fi

# ---------------------------------------------------------------------------
# 6. Start the stack (build on install; llamacpp only with a local model)
# ---------------------------------------------------------------------------
if [ "$MODE" = "restart" ]; then
  stop_stack
  step "Starting services (no rebuild — run ./install.sh to apply code changes)"
else
  step "Building and starting services (first build downloads ~1 GB)..."
fi
COMPOSE_UP=($COMPOSE)
# --profile is a global flag: it must precede the subcommand for podman-compose
if [ "$USE_LOCAL_LLM" = "1" ]; then COMPOSE_UP+=(--profile local-llm); fi
COMPOSE_UP+=(up -d)
if [ "$MODE" = "install" ]; then COMPOSE_UP+=(--build); fi
if ! "${COMPOSE_UP[@]}"; then
  echo "${RED}❌ Build/startup failed — the full error is printed above.${NC}"
  echo "   Inspect the stack with:"
  echo "     $COMPOSE ps"
  echo "     $COMPOSE logs --tail=100"
  echo "   Retry the whole install with: ./install.sh"
  exit 1
fi

if [ "$MODE" = "restart" ]; then
  echo ""
  echo "✅ Stack restarted cleanly — data and WhatsApp session kept."
  echo "   Status:  $COMPOSE ps"
  echo "   Logs:    $COMPOSE logs -f whatsapp-bot"
  echo "   Panel:   http://localhost:3000"
  exit 0
fi

cat <<EOF

✅ Installation complete!

Next steps:
  1. Scan the WhatsApp QR code with your phone:
       $COMPOSE logs -f whatsapp-bot
  2. Open the control panel:
       http://localhost:3000
     (the API token is in .env → API_TOKEN)
  3. Restart or stop everything later with:
       ./install.sh --restart     (no rebuild)
       ./install.sh --stop
EOF
