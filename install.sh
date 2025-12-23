#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PORT=${PORT:-6969}
DATA_DIR=${DATA_DIR:-/data}
NODE_VERSION_SETUP=${NODE_VERSION_SETUP:-https://deb.nodesource.com/setup_22.x}

if [[ $(id -u) -eq 0 ]]; then
  SUDO=""
else
  if ! command -v sudo >/dev/null 2>&1; then
    echo "sudo is required to install dependencies. Please install sudo or run as root." >&2
    exit 1
  fi
  SUDO="sudo"
fi

info() { echo "[+] $1"; }
warn() { echo "[!] $1"; }

ensure_packages() {
  info "Updating apt packages..."
  ${SUDO} apt-get update -y
  ${SUDO} apt-get upgrade -y

  info "Installing prerequisites (curl, ca-certificates)..."
  ${SUDO} apt-get install -y curl ca-certificates

  info "Installing Node.js (22.x), FFmpeg, Git, and UFW..."
  curl -fsSL "$NODE_VERSION_SETUP" | ${SUDO} -E bash -
  ${SUDO} apt-get install -y nodejs ffmpeg git ufw
}

install_pm2() {
  if command -v pm2 >/dev/null 2>&1; then
    return
  fi
  info "Installing PM2 globally..."
  ${SUDO} npm install -g pm2
}

setup_firewall() {
  info "Configuring UFW firewall..."
  ${SUDO} ufw allow OpenSSH || ${SUDO} ufw allow 22/tcp
  ${SUDO} ufw allow ${PORT}/tcp
  ${SUDO} ufw --force enable
}

prepare_data_dirs() {
  info "Ensuring data directories under ${DATA_DIR}..."
  ${SUDO} mkdir -p "${DATA_DIR}/db" \
    "${DATA_DIR}/assets/videos" "${DATA_DIR}/assets/audios" "${DATA_DIR}/assets/sfx" \
    "${DATA_DIR}/assets/thumbs" "${DATA_DIR}/logs" "${DATA_DIR}/config" "${DATA_DIR}/ffmpeg"
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

load_or_create_secret() {
  local secret_file="${DATA_DIR}/config/session_secret"
  local current_secret="${SESSION_SECRET:-}"

  if [[ -z "$current_secret" && -f .env ]]; then
    current_secret=$(grep -E '^SESSION_SECRET=' .env | head -n1 | cut -d= -f2- || true)
  fi

  if [[ -z "$current_secret" && -f "$secret_file" ]]; then
    current_secret="$(cat "$secret_file")"
    info "Loaded SESSION_SECRET from ${secret_file}."
  fi

  if [[ -z "$current_secret" ]]; then
    current_secret=$(generate_secret)
    info "Generated new SESSION_SECRET and stored at ${secret_file}."
    echo "$current_secret" | ${SUDO} tee "$secret_file" >/dev/null
  elif [[ ! -f "$secret_file" ]]; then
    echo "$current_secret" | ${SUDO} tee "$secret_file" >/dev/null
  fi

  SESSION_SECRET="$current_secret"
  INSTALL_SECRET=${INSTALL_SECRET:-$SESSION_SECRET}
}

write_env_file() {
  if [[ -f .env ]]; then
    info ".env already exists; keeping existing values."
    return
  fi

  info "Writing .env to ${SCRIPT_DIR}..."
  cat > .env <<EOF_ENV
PORT=${PORT}
DATA_DIR=${DATA_DIR}
SESSION_SECRET=${SESSION_SECRET}
INSTALL_SECRET=${INSTALL_SECRET}
EOF_ENV
}

install_dependencies() {
  info "Installing Node dependencies (omit dev)..."
  if ! npm ci --omit=dev; then
    warn "npm ci failed, falling back to npm install --omit=dev"
    npm install --omit=dev
  fi
}

start_pm2() {
  info "Starting ZenStream via PM2..."
  export PORT DATA_DIR SESSION_SECRET INSTALL_SECRET
  if pm2 list | grep -q " zenstream"; then
    pm2 restart zenstream --update-env
  else
    pm2 start app.js --name zenstream --update-env
  fi
  pm2 save
}

print_finish() {
  local ip
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  [[ -z "$ip" ]] && ip="<server-ip>"
  echo "============================================"
  echo "ZenStream is running."
  echo "Open: http://${ip}:${PORT} to complete setup (first visit will redirect to /setup)."
  echo "PM2 process: zenstream (port ${PORT})"
  echo "============================================"
}

echo "================================"
echo "    ZenStream Quick Installer"
echo "================================"

ensure_packages
prepare_data_dirs
load_or_create_secret
write_env_file
install_pm2
install_dependencies
setup_firewall
start_pm2
print_finish
