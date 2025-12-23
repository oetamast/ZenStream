#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "================================"
echo "    ZenStream Quick Installer   "
echo "================================"
echo

SUDO="sudo"
PORT=${PORT:-6969}
DATA_DIR=${DATA_DIR:-/data}
NODE_VERSION_SETUP=${NODE_VERSION_SETUP:-https://deb.nodesource.com/setup_22.x}

info() { echo "[+] $1"; }
warn() { echo "[!] $1"; }

ensure_packages() {
  info "Updating apt packages..."
  $SUDO apt-get update -y
  $SUDO apt-get upgrade -y

  info "Installing Node.js (22.x), FFmpeg, Git, and UFW..."
  curl -fsSL "$NODE_VERSION_SETUP" | $SUDO -E bash -
  $SUDO apt-get install -y nodejs ffmpeg git ufw
}

install_pm2() {
  if command -v pm2 >/dev/null 2>&1; then
    return
  fi
  info "Installing PM2 globally..."
  $SUDO npm install -g pm2
}

setup_firewall() {
  info "Configuring UFW firewall..."
  $SUDO ufw allow OpenSSH || $SUDO ufw allow 22/tcp
  $SUDO ufw allow ${PORT}/tcp
  $SUDO ufw --force enable
}

prepare_data_dirs() {
  info "Ensuring data directories under ${DATA_DIR}..."
  $SUDO mkdir -p "${DATA_DIR}/db" "${DATA_DIR}/assets" "${DATA_DIR}/logs" "${DATA_DIR}/config" "${DATA_DIR}/ffmpeg"
}

echo "🔧 Setup firewall..."
sudo ufw allow ssh
sudo ufw allow 6969
sudo ufw --force enable

load_or_create_secret() {
  local secret_file="${DATA_DIR}/config/session_secret"
  local current_secret="${SESSION_SECRET:-}"

echo "▶️ Starting ZenStream..."
pm2 start app.js --name zenstream
pm2 save

  if [[ -z "$current_secret" && -f "$secret_file" ]]; then
    current_secret="$($SUDO cat "$secret_file")"
    info "Loaded SESSION_SECRET from ${secret_file}."
  fi

SERVER_IP=$(curl -s ifconfig.me 2>/dev/null || echo "IP_SERVER")
echo
echo "🌐 URL Akses: http://$SERVER_IP:6969"
echo
echo "📋 Langkah selanjutnya:"
echo "1. Buka URL di browser"
echo "2. Buat username & password"
echo "3. Setelah membuat akun, lakukan Sign Out kemudian login kembali untuk sinkronisasi database"
echo "================================"
