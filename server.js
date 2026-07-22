const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const si = require('systeminformation');
const cors = require('cors');

const StreamEngine = require('./streamEngine');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const engine = new StreamEngine(__dirname);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper middleware to check token from Authorization header or Query string
const checkAuth = (req, res, next) => {
  if (!engine.hasPassword()) {
    return next(); // Initial setup mode: no password set yet
  }
  const token = req.headers['authorization'] || req.query.token;
  if (token && engine.verifyPassword(token.replace('Bearer ', ''))) {
    return next();
  }
  return res.status(401).json({ success: false, error: 'Unauthorized. Password required.' });
};

app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', checkAuth, express.static(path.join(__dirname, 'media')));

// Auth Routes
app.get('/api/auth/status', (req, res) => {
  const token = req.headers['authorization'] || req.query.token;
  const isAuthenticated = !engine.hasPassword() || Boolean(token && engine.verifyPassword(token.replace('Bearer ', '')));
  res.json({
    hasPassword: engine.hasPassword(),
    isAuthenticated
  });
});

app.post('/api/auth/setup', (req, res) => {
  const { password } = req.body;
  if (!password || password.trim().length < 4) {
    return res.status(400).json({ success: false, error: 'Password minimal 4 karakter!' });
  }
  if (engine.hasPassword()) {
    return res.status(400).json({ success: false, error: 'Password sudah pernah diset!' });
  }
  engine.setPassword(password.trim());
  res.json({ success: true, message: 'Master Password berhasil diset!' });
});

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (engine.verifyPassword(password)) {
    res.json({ success: true, token: password, message: 'Login berhasil!' });
  } else {
    res.status(401).json({ success: false, error: 'Password salah!' });
  }
});

// File Upload Configuration (Multer)
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
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `${Date.now()}_${cleanName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 1000 * 1024 * 1024 } // 1GB max limit
});

// REST API Endpoints
app.get('/api/status', (req, res) => {
  res.json(engine.getStatus());
});

app.post('/api/settings', (req, res) => {
  try {
    const updated = engine.saveSettings(req.body);
    res.json({ success: true, settings: updated });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/stream/start', (req, res) => {
  try {
    const { streamKey } = req.body;
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

// Dedicated video preview endpoint - bypasses all filename encoding issues
app.get('/api/preview-video', (req, res) => {
  const media = engine.scanMedia();
  let selectedVideo = media.selectedVideo;
  let videoPath = selectedVideo ? path.join(engine.mediaVideoDir, selectedVideo) : null;

  // If selected video doesn't exist on disk, fall back to first available
  if (!videoPath || !fs.existsSync(videoPath)) {
    if (media.videoFiles && media.videoFiles.length > 0) {
      selectedVideo = media.videoFiles[0];
      videoPath = path.join(engine.mediaVideoDir, selectedVideo);
      // Auto-update settings to point to the actual file
      engine.saveSettings({ selectedVideo: selectedVideo });
    } else {
      return res.status(404).send('No video files available');
    }
  }

  if (!fs.existsSync(videoPath)) {
    return res.status(404).send('Video file not found');
  }

  res.sendFile(videoPath);
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

app.delete('/api/media/:type/:filename(*)', (req, res) => {
  const type = req.params.type;
  const filename = decodeURIComponent(req.params.filename);
  const targetDir = type === 'audio' ? engine.mediaAudioDir : engine.mediaVideoDir;
  const filePath = path.join(targetDir, filename);

  console.log(`Delete request for [${type}]: ${filename}`);

  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      engine.scanMedia();
      res.json({ success: true, message: `File ${filename} berhasil dihapus.` });
    } catch (err) {
      res.status(500).json({ success: false, error: `Gagal menghapus file: ${err.message}` });
    }
  } else {
    // Also try matching basename if filename timestamp differs
    const filesInDir = fs.readdirSync(targetDir);
    const matched = filesInDir.find(f => f === filename || f.endsWith(filename));
    if (matched) {
      try {
        fs.unlinkSync(path.join(targetDir, matched));
        engine.scanMedia();
        return res.json({ success: true, message: `File ${matched} berhasil dihapus.` });
      } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
      }
    }
    res.status(404).json({ success: false, error: 'File tidak ditemukan di server.' });
  }
});

// Real-Time WebSockets Telemetry Broadcasting
wss.on('connection', (ws) => {
  console.log('Client dashboard terhubung ke WebSocket');

  // Send initial state
  ws.send(JSON.stringify({ type: 'INIT', data: engine.getStatus() }));

  const telemetryInterval = setInterval(async () => {
    if (ws.readyState === WebSocket.OPEN) {
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
    }
  }, 1500);

  ws.on('close', () => {
    clearInterval(telemetryInterval);
  });
});

// Engine events to WebSocket broadcast
engine.on('status', (data) => {
  broadcastWS({ type: 'STATUS_CHANGE', data });
});

engine.on('progress', (stats) => {
  broadcastWS({ type: 'STREAM_PROGRESS', data: stats });
});

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
  console.log(`🚀 StreamPulse 24/7 Control Hub is active!`);
  console.log(`🌐 Dashboard URL: http://localhost:${PORT}`);
  console.log(`====================================================`);
});
