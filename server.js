const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const si = require('systeminformation');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const StreamEngine = require('./streamEngine');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const engine = new StreamEngine(__dirname);

// Trust the first proxy hop so express-rate-limit sees the real client IP behind Nginx.
app.set('trust proxy', 1);

// ---------- CORS ----------
// By default, only same-origin requests are allowed (no Origin header).
// Set ALLOWED_ORIGIN=https://your.domain to allow one cross-origin browser client.
const allowedOrigin = process.env.ALLOWED_ORIGIN;
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin, curl, server-to-server
    if (allowedOrigin && origin === allowedOrigin) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Session tokens (in-memory) ----------
const activeTokens = new Set();
function issueToken() {
  const token = crypto.randomBytes(32).toString('hex');
  activeTokens.add(token);
  return token;
}
function extractToken(req) {
  const raw = (req.headers['authorization'] || req.query.token || '').toString();
  return raw.replace(/^Bearer\s+/i, '').trim();
}
function isAuthed(req) {
  if (!engine.hasPassword()) return true; // initial setup mode
  const t = extractToken(req);
  return Boolean(t && activeTokens.has(t));
}
const checkAuth = (req, res, next) => {
  if (isAuthed(req)) return next();
  return res.status(401).json({ success: false, error: 'Unauthorized. Login diperlukan.' });
};

// ---------- Rate limiter for login ----------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Terlalu banyak percobaan login. Coba lagi ~15 menit lagi.' }
});

// ---------- Helpers ----------
function redactSettings(s) {
  const clone = { ...(s || {}) };
  delete clone.passwordHash;
  if (clone.streamKey) {
    const k = String(clone.streamKey);
    clone.streamKey = k.length > 4 ? '\u2022\u2022\u2022\u2022\u2022\u2022' + k.slice(-4) : '\u2022\u2022\u2022\u2022';
  }
  return clone;
}
function redactStatus(status) {
  return { ...status, settings: redactSettings(status.settings) };
}

// ---------- Static files ----------
// Dashboard static assets are public so the login page can load.
app.use(express.static(path.join(__dirname, 'public')));
// Media files are auth-only.
app.use('/media', checkAuth, express.static(path.join(__dirname, 'media')));

// ---------- Auth Routes (public) ----------
app.get('/api/auth/status', (req, res) => {
  res.json({
    hasPassword: engine.hasPassword(),
    isAuthenticated: isAuthed(req)
  });
});

app.post('/api/auth/setup', (req, res) => {
  const { password } = req.body || {};
  if (!password || String(password).trim().length < 8) {
    return res.status(400).json({ success: false, error: 'Password minimal 8 karakter!' });
  }
  if (engine.hasPassword()) {
    return res.status(400).json({ success: false, error: 'Password sudah pernah diset!' });
  }
  engine.setPassword(String(password).trim());
  const token = issueToken();
  res.json({ success: true, token, message: 'Master Password berhasil diset!' });
});

app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { password } = req.body || {};
  if (!password || !engine.verifyPassword(String(password))) {
    return res.status(401).json({ success: false, error: 'Password salah!' });
  }
  const token = issueToken();
  res.json({ success: true, token, message: 'Login berhasil!' });
});

app.post('/api/auth/logout', (req, res) => {
  const t = extractToken(req);
  if (t) activeTokens.delete(t);
  res.json({ success: true });
});

// ---------- Everything /api/* below this requires auth ----------
app.use('/api', checkAuth);

app.get('/api/status', (req, res) => {
  res.json(redactStatus(engine.getStatus()));
});

app.post('/api/settings', (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    // Never accept a raw passwordHash via the API. Password rotation must go
    // through newPassword, which streamEngine.saveSettings hashes with bcrypt.
    delete body.passwordHash;
    const updated = engine.saveSettings(body);
    res.json({ success: true, settings: redactSettings(updated) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/stream/start', (req, res) => {
  try {
    const { streamKey } = req.body || {};
    engine.startStream(streamKey);
    res.json({ success: true, message: 'Stream YouTube Berhasil Dijalankan!' });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/stream/stop', (req, res) => {
  const stopped = engine.stopStream();
  res.json({ success: true, stopped, message: 'Stream Berhasil Dihentikan.' });
});

app.post('/api/stream/skip', (req, res) => {
  const nextTrack = engine.skipTrack();
  res.json({ success: true, nextTrack });
});

app.get('/api/media', (req, res) => {
  res.json(engine.scanMedia());
});

app.get('/api/media/durations', async (req, res) => {
  try {
    engine.scanMedia();
    const durations = await engine.getDurations();
    res.json(durations);
  } catch (err) {
    res.json({});
  }
});

app.get('/api/preview-video', (req, res) => {
  const media = engine.scanMedia();
  let selectedVideo = media.selectedVideo;
  let videoPath = selectedVideo ? path.join(engine.mediaVideoDir, selectedVideo) : null;

  if (!videoPath || !fs.existsSync(videoPath)) {
    if (media.videoFiles && media.videoFiles.length > 0) {
      selectedVideo = media.videoFiles[0];
      videoPath = path.join(engine.mediaVideoDir, selectedVideo);
      engine.saveSettings({ selectedVideo });
    } else {
      return res.status(404).send('No video files available');
    }
  }

  // Defense in depth: make sure the resolved file is inside mediaVideoDir.
  const resolved = path.resolve(videoPath);
  const dirBase = path.resolve(engine.mediaVideoDir) + path.sep;
  if (!resolved.startsWith(dirBase) || !fs.existsSync(resolved)) {
    return res.status(404).send('Video file not found');
  }
  res.sendFile(resolved);
});

// ---------- Multer upload ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const isAudio = file.mimetype.startsWith('audio/') || ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg'].includes(ext);
    const isVideo = file.mimetype.startsWith('video/') || ['.mp4', '.mkv', '.mov', '.webm', '.avi'].includes(ext);

    if (isAudio) {
      cb(null, path.join(__dirname, 'media', 'audio'));
    } else if (isVideo) {
      cb(null, path.join(__dirname, 'media', 'video'));
    } else {
      cb(new Error('Tipe file tidak didukung! Hanya file Audio (MP3/WAV) dan Video (MP4) yang diizinkan.'));
    }
  },
  filename: (req, file, cb) => {
    // Strip any directory portion the client sends and sanitize the rest.
    const base = path.basename(file.originalname);
    const cleanName = base.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `${Date.now()}_${cleanName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 1000 * 1024 * 1024 } // 1GB
});

app.post('/api/upload', (req, res) => {
  upload.array('files', 20)(req, res, (err) => {
    if (err) {
      console.error('Upload Error:', err.message);
      return res.status(400).json({ success: false, error: err.message });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'Tidak ada file yang diupload.' });
    }
    engine.scanMedia();
    res.json({
      success: true,
      message: `${req.files.length} file berhasil di-upload!`,
      files: req.files.map(f => f.filename)
    });
  });
});

// Safe delete with path-traversal guard
app.delete('/api/media/:type/:filename(*)', (req, res) => {
  const type = req.params.type;
  if (!['audio', 'video'].includes(type)) {
    return res.status(400).json({ success: false, error: 'Tipe media tidak valid.' });
  }
  let filename;
  try {
    filename = decodeURIComponent(req.params.filename);
  } catch (e) {
    return res.status(400).json({ success: false, error: 'Nama file tidak valid.' });
  }
  // Reject anything that isn't a plain basename.
  if (!filename || filename !== path.basename(filename) || filename.includes('\0')) {
    return res.status(400).json({ success: false, error: 'Nama file tidak valid.' });
  }
  const targetDir = type === 'audio' ? engine.mediaAudioDir : engine.mediaVideoDir;
  const filePath = path.resolve(targetDir, filename);
  const dirBase = path.resolve(targetDir) + path.sep;
  if (!filePath.startsWith(dirBase)) {
    return res.status(400).json({ success: false, error: 'Path tidak diizinkan.' });
  }

  console.log(`Delete request for [${type}]: ${filename}`);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: 'File tidak ditemukan di server.' });
  }
  try {
    fs.unlinkSync(filePath);
    engine.scanMedia();
    return res.json({ success: true, message: `File ${filename} berhasil dihapus.` });
  } catch (err) {
    return res.status(500).json({ success: false, error: `Gagal menghapus file: ${err.message}` });
  }
});

// ---------- WebSocket telemetry (auth via ?token=) ----------
wss.on('connection', (ws, req) => {
  let token = '';
  try {
    const parsed = new URL(req.url, 'http://localhost');
    token = (parsed.searchParams.get('token') || '').trim();
  } catch (_) {}

  if (engine.hasPassword() && !activeTokens.has(token)) {
    try { ws.send(JSON.stringify({ type: 'ERROR', data: { error: 'Unauthorized' } })); } catch (_) {}
    ws.close(4401, 'Unauthorized');
    return;
  }

  console.log('Client dashboard terhubung ke WebSocket');

  ws.send(JSON.stringify({ type: 'INIT', data: redactStatus(engine.getStatus()) }));

  const telemetryInterval = setInterval(async () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      const cpu = await si.currentLoad();
      const mem = await si.mem();
      const disk = await si.fsSize();

      const rootDisk = disk[0] || { size: 1, used: 0, use: 0 };

      const telemetry = {
        type: 'TELEMETRY',
        data: {
          system: {
            cpuLoad: Math.round(cpu.currentLoad || 0),
            ramUsed: (mem.active / (1024 * 1024 * 1024)).toFixed(2),
            ramTotal: (mem.total / (1024 * 1024 * 1024)).toFixed(2),
            ramPercent: Math.round((mem.active / mem.total) * 100),
            diskUsedGB: (rootDisk.used / (1024 * 1024 * 1024)).toFixed(1),
            diskTotalGB: (rootDisk.size / (1024 * 1024 * 1024)).toFixed(1),
            diskPercent: Math.round(rootDisk.use || 0)
          },
          stream: {
            isStreaming: engine.isStreaming,
            stats: engine.stats
          }
        }
      };

      ws.send(JSON.stringify(telemetry));
    } catch (err) {
      console.error('Error fetching telemetry:', err.message);
    }
  }, 1500);

  ws.on('close', () => clearInterval(telemetryInterval));
});

engine.on('status', (data) => broadcastWS({ type: 'STATUS_CHANGE', data }));
engine.on('progress', (stats) => broadcastWS({ type: 'STREAM_PROGRESS', data: stats }));

function broadcastWS(payload) {
  const message = JSON.stringify(payload);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`\uD83D\uDE80 StreamPulse 24/7 Control Hub is active!`);
  console.log(`\uD83C\uDF10 Dashboard URL: http://localhost:${PORT}`);
  console.log(`====================================================`);
});
