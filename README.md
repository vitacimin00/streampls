# StreamPulse 24/7

YouTube Live Stream automation dashboard. Upload MP3 + video background, klik Start — stream jalan terus 24/7 tanpa henti.

## Stack
- **Node.js** + Express + WebSocket
- **FFmpeg** (fluent-ffmpeg)
- Vanilla HTML/CSS/JS dashboard

## Quick Start (Local)

```bash
npm install
node server.js
# buka http://localhost:3000
```

## Deploy ke VPS (Ubuntu/Debian)

```bash
git clone https://github.com/vitacimin00/streampls.git
cd streampls
sudo bash vps-setup.sh
```

Akses dashboard: `http://IP_VPS:3000`

## Struktur Folder

```
├── server.js          # Express server + WebSocket
├── streamEngine.js    # FFmpeg engine (start/stop/auto-restart)
├── vps-setup.sh       # Auto-installer untuk VPS
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── media/
│   ├── audio/         # Upload MP3 di sini
│   └── video/         # Upload MP4 di sini
└── config/
    └── settings.json  # Auto-generated (tidak di-commit)
```

## Upload Media ke VPS

```bash
# dari laptop kamu
scp lagu.mp3   root@IP_VPS:/path/to/streampulse/media/audio/
scp video.mp4  root@IP_VPS:/path/to/streampulse/media/video/
```

Atau langsung drag-drop lewat dashboard.

## PM2 Commands

```bash
pm2 status                  # cek status
pm2 logs streampulse        # lihat log real-time
pm2 restart streampulse     # restart
```
