#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This installer currently supports Linux hosts." >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required. Please install curl and re-run." >&2
  exit 1
fi

# Detect package manager (Debian/Ubuntu preferred)
if [[ -f /etc/os-release ]]; then
  . /etc/os-release
fi

INSTALL_DIR=${INSTALL_DIR:-/opt/zenstream}
REPO_URL=${REPO_URL:-https://github.com/bangtutorial/zenstream.git}
DATA_DIR=${DATA_DIR:-/data}
PORT=${PORT:-6969}

install_docker() {
  if command -v docker >/dev/null 2>&1; then
    echo "Docker already installed."
    return
  fi

  if [[ "${ID_LIKE:-}" =~ debian || "${ID:-}" =~ debian || "${ID:-}" =~ ubuntu ]]; then
    echo "Installing Docker via apt..."
    sudo apt-get update -y
    sudo apt-get install -y ca-certificates curl gnupg lsb-release
    sudo apt-get install -y docker.io docker-compose-plugin
    sudo systemctl enable --now docker
  else
    echo "Unsupported distro for automatic Docker install. Please install Docker and Docker Compose plugin manually:"
    echo " - https://docs.docker.com/engine/install/"
    exit 1
  fi
}

install_git() {
  if command -v git >/dev/null 2>&1; then
    return
  fi
  if [[ "${ID_LIKE:-}" =~ debian || "${ID:-}" =~ debian || "${ID:-}" =~ ubuntu ]]; then
    sudo apt-get update -y
    sudo apt-get install -y git
  else
    echo "Git is required to clone the repository. Please install git and re-run." >&2
    exit 1
  fi
}

fetch_repo() {
  mkdir -p "${INSTALL_DIR}"
  if [[ -d "${INSTALL_DIR}/.git" ]]; then
    echo "Repository already present at ${INSTALL_DIR}. Skipping clone."
    return
  fi

  install_git
  echo "Cloning ZenStream into ${INSTALL_DIR}..."
  git clone "${REPO_URL}" "${INSTALL_DIR}"
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

create_env() {
  local secret
  secret=$(generate_secret)
  cat > "${INSTALL_DIR}/.env" <<EOF_ENV
PORT=${PORT}
DATA_DIR=${DATA_DIR}
SESSION_SECRET=${secret}
INSTALL_SECRET=${secret}
EOF_ENV
}

start_stack() {
  cd "${INSTALL_DIR}"
  echo "Starting ZenStream with Docker Compose..."
  docker compose up -d --build
}

print_complete() {
  local ip
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  [[ -z "$ip" ]] && ip="<server-ip>"
  echo "============================================"
  echo "✅ ZenStream is building/starting."
  echo "Open: http://${ip}:${PORT} to complete setup in your browser."
  echo "Default data dir: ${DATA_DIR}"
  echo "Repo location: ${INSTALL_DIR}"
  echo "============================================"
}

install_docker
fetch_repo
create_env
start_stack
print_complete
