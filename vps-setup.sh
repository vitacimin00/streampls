#!/bin/bash
# ==============================================================================
#  StreamPulse 24/7 — VPS Auto-Installer
#  Target  : Ubuntu 20.04 / 22.04 / Debian 11+
#  Jalankan: sudo bash vps-setup.sh
# ==============================================================================

set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC}   $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERR]${NC}  $1"; exit 1; }

echo ""
echo -e "${CYAN}======================================================"
echo "  StreamPulse 24/7 — VPS Installer"
echo -e "======================================================${NC}"
echo ""

# ── Root check ────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  error "Jalankan sebagai root: sudo bash vps-setup.sh"
fi

# ── Detect project directory ──────────────────────────────────
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
info "Project directory: $SCRIPT_DIR"

# ─────────────────────────────────────────────────────────────
# STEP 1: System Update
# ─────────────────────────────────────────────────────────────
info "[1/7] Update sistem..."
apt-get update -y -qq
apt-get upgrade -y -qq
success "Sistem up-to-date"

# ─────────────────────────────────────────────────────────────
# STEP 2: Install FFmpeg (versi terbaru via PPA) & Tools
# ─────────────────────────────────────────────────────────────
info "[2/7] Install FFmpeg versi terbaru, Git, Build Tools..."
apt-get install -y software-properties-common curl git wget build-essential ufw 2>/dev/null

# Install FFmpeg terbaru via PPA (bukan versi lama dari apt default)
# Ubuntu 20.04 default = FFmpeg 4.2.x (lama, ada bug)
# PPA ini memberikan FFmpeg 6.x+ yang stabil
add-apt-repository -y ppa:savoury1/ffmpeg4 2>/dev/null || true
apt-get update -y -qq
apt-get install -y ffmpeg 2>/dev/null

command -v ffmpeg &>/dev/null || error "FFmpeg gagal terinstall!"
FFMPEG_VER=$(ffmpeg -version 2>&1 | head -n1 | awk '{print $3}')
success "FFmpeg: $FFMPEG_VER"

# ─────────────────────────────────────────────────────────────
# STEP 3: Install Node.js v20 LTS
# ─────────────────────────────────────────────────────────────
info "[3/7] Install Node.js v20 LTS..."
if ! command -v node &>/dev/null || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - 2>/dev/null
  apt-get install -y nodejs 2>/dev/null
fi
success "Node.js: $(node -v) | NPM: $(npm -v)"

# ─────────────────────────────────────────────────────────────
# STEP 4: Install PM2
# ─────────────────────────────────────────────────────────────
info "[4/7] Install PM2 Process Manager..."
npm install -g pm2 --quiet
success "PM2: $(pm2 -v)"

# ─────────────────────────────────────────────────────────────
# STEP 5: Project Setup
# ─────────────────────────────────────────────────────────────
info "[5/7] Setup project & install dependencies..."
cd "$SCRIPT_DIR"

# Buat folder yang dibutuhkan
mkdir -p media/audio media/video config logs

# Install npm dependencies
npm install --omit=dev --quiet
success "NPM dependencies installed"

# ─────────────────────────────────────────────────────────────
# STEP 6: Firewall
# ─────────────────────────────────────────────────────────────
info "[6/7] Konfigurasi firewall UFW..."
ufw allow 22/tcp   comment 'SSH'         2>/dev/null || true
ufw allow 80/tcp   comment 'HTTP'        2>/dev/null || true
ufw allow 443/tcp  comment 'HTTPS'       2>/dev/null || true
ufw allow 3000/tcp comment 'StreamPulse' 2>/dev/null || true
ufw --force enable 2>/dev/null || true
success "Firewall: port 22, 80, 443, 3000 terbuka"

# ─────────────────────────────────────────────────────────────
# STEP 7: PM2 Service
# ─────────────────────────────────────────────────────────────
info "[7/7] Mendaftarkan StreamPulse ke PM2..."

# Stop instance lama jika ada
pm2 delete streampulse 2>/dev/null || true

# Start dengan PM2
pm2 start "$SCRIPT_DIR/server.js" \
  --name "streampulse" \
  --restart-delay=5000 \
  --max-restarts=10 \
  --log "$SCRIPT_DIR/logs/streampulse.log" \
  --merge-logs

# Simpan PM2 config & enable autostart on boot
pm2 save

# Buat PM2 startup script (auto-start saat VPS reboot)
PM2_STARTUP=$(pm2 startup systemd -u root --hp /root 2>&1 | tail -n 1)
if [[ "$PM2_STARTUP" == sudo* ]]; then
  eval "$PM2_STARTUP"
fi

success "PM2 service 'streampulse' terdaftar dan berjalan"

# ─────────────────────────────────────────────────────────────
# Done!
# ─────────────────────────────────────────────────────────────
SERVER_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')

echo ""
echo -e "${GREEN}======================================================"
echo "  SETUP BERHASIL!"
echo -e "======================================================${NC}"
echo ""
echo -e "  ${GREEN}▶ Dashboard URL:${NC}"
echo -e "    http://${SERVER_IP}:3000"
echo ""
echo -e "  ${YELLOW}▶ Perintah berguna:${NC}"
echo "    pm2 status                  — cek status semua service"
echo "    pm2 logs streampulse        — lihat log real-time"
echo "    pm2 restart streampulse     — restart dashboard"
echo "    pm2 stop streampulse        — stop dashboard"
echo ""
echo -e "  ${CYAN}▶ Upload media ke VPS (dari laptop kamu):${NC}"
echo "    scp file.mp3  root@${SERVER_IP}:$SCRIPT_DIR/media/audio/"
echo "    scp video.mp4 root@${SERVER_IP}:$SCRIPT_DIR/media/video/"
echo ""
echo -e "  ${CYAN}▶ Opsional — pasang domain + SSL (Nginx):${NC}"
echo "    apt install -y nginx certbot python3-certbot-nginx"
echo "    nano /etc/nginx/sites-available/streampulse"
echo "    # isi dengan: proxy_pass http://127.0.0.1:3000;"
echo "    certbot --nginx -d yourdomain.com"
echo ""
echo "======================================================"
echo ""
