const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const EventEmitter = require('events');

try {
  const ffmpegStatic = require('ffmpeg-static');
  if (ffmpegStatic) {
    ffmpeg.setFfmpegPath(ffmpegStatic);
    console.log('FFmpeg binary path set to:', ffmpegStatic);
  }
} catch (e) {
  console.log('Using system default FFmpeg binary');
}

class StreamEngine extends EventEmitter {
  constructor(baseDir) {
    super();
    this.baseDir = baseDir || __dirname;
    this.mediaAudioDir = path.join(this.baseDir, 'media', 'audio');
    this.mediaVideoDir = path.join(this.baseDir, 'media', 'video');
    this.configDir = path.join(this.baseDir, 'config');
    this.configFile = path.join(this.configDir, 'settings.json');
    this.playlistFile = path.join(this.configDir, 'playlist.txt');

    this.ensureDirectories();

    this.ffmpegProcess = null;
    this.isStreaming = false;
    this.startTime = null;
    this.currentTrackIndex = 0;
    this.playlist = [];
    this.videoFiles = [];

    this.settings = this.loadSettings();
    this.stats = {
      fps: 0,
      bitrate: '0 kbits/s',
      frames: 0,
      time: '00:00:00',
      uptimeSeconds: 0,
      currentTrack: null
    };

    this.uptimeInterval = null;
  }

  ensureDirectories() {
    [this.mediaAudioDir, this.mediaVideoDir, this.configDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  loadSettings() {
    const defaultSettings = {
      passwordHash: '', // bcrypt hash for dashboard authentication
      streamKey: '',
      rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
      resolution: '1280x720',
      fps: 30,
      videoBitrate: '2500k',
      audioBitrate: '190k',
      selectedVideo: '',
      preset: 'veryfast',
      audioNormalization: true // Auto-normalize audio loudness (EBU R128)
    };

    if (fs.existsSync(this.configFile)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
        return { ...defaultSettings, ...saved };
      } catch (err) {
        console.error('Error loading settings.json:', err);
      }
    }
    return defaultSettings;
  }

  hashPassword(password) {
    if (!password) return '';
    return bcrypt.hashSync(String(password), 12);
  }

  hasPassword() {
    return Boolean(this.settings.passwordHash && this.settings.passwordHash.length > 0);
  }

  setPassword(newPassword) {
    this.settings.passwordHash = this.hashPassword(newPassword);
    this.saveSettings(this.settings);
    return true;
  }

  verifyPassword(inputPassword) {
    if (!this.hasPassword()) return true;
    const hash = this.settings.passwordHash;
    const input = String(inputPassword || '');

    // Modern bcrypt hash
    if (typeof hash === 'string' && hash.startsWith('$2')) {
      try { return bcrypt.compareSync(input, hash); }
      catch { return false; }
    }

    // Legacy SHA-256 (64 hex chars) - verify with timing-safe compare, then upgrade to bcrypt
    if (typeof hash === 'string' && /^[a-f0-9]{64}$/i.test(hash)) {
      try {
        const sha = crypto.createHash('sha256').update(input).digest('hex');
        const a = Buffer.from(sha, 'hex');
        const b = Buffer.from(hash, 'hex');
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
          console.log('Upgrading legacy SHA-256 password hash to bcrypt...');
          this.settings.passwordHash = this.hashPassword(input);
          this.saveSettings(this.settings);
          return true;
        }
      } catch (e) {
        console.error('Legacy hash verify error:', e.message);
      }
    }
    return false;
  }

  saveSettings(newSettings) {
    // Convert plaintext newPassword into a bcrypt hash if provided
    if (newSettings && newSettings.newPassword) {
      newSettings.passwordHash = this.hashPassword(newSettings.newPassword);
      delete newSettings.newPassword;
    }
    this.settings = { ...this.settings, ...newSettings };
    fs.writeFileSync(this.configFile, JSON.stringify(this.settings, null, 2), { encoding: 'utf8', mode: 0o600 });
    // Ensure permissions even if the file already existed with different mode
    try { fs.chmodSync(this.configFile, 0o600); } catch (_) { /* best-effort */ }
    this.emit('settingsUpdated', this.settings);
    return this.settings;
  }

  scanMedia() {
    const audioExts = ['.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg'];
    const videoExts = ['.mp4', '.mkv', '.mov', '.webm'];

    this.playlist = fs.existsSync(this.mediaAudioDir)
      ? fs.readdirSync(this.mediaAudioDir)
          .filter(file => audioExts.includes(path.extname(file).toLowerCase()))
          .map(file => ({
            filename: file,
            title: path.basename(file, path.extname(file)),
            path: path.join(this.mediaAudioDir, file)
          }))
      : [];

    this.videoFiles = fs.existsSync(this.mediaVideoDir)
      ? fs.readdirSync(this.mediaVideoDir)
          .filter(file => videoExts.includes(path.extname(file).toLowerCase()))
      : [];

    // Select default video if none selected
    if (!this.settings.selectedVideo && this.videoFiles.length > 0) {
      this.settings.selectedVideo = this.videoFiles[0];
      this.saveSettings(this.settings);
    }

    return {
      playlist: this.playlist,
      videoFiles: this.videoFiles,
      selectedVideo: this.settings.selectedVideo
    };
  }

  generateConcatPlaylist() {
    this.scanMedia();
    if (this.playlist.length === 0) {
      throw new Error('Belum ada file audio di folder media/audio!');
    }

    let content = '';
    const repeatCount = 500;
    for (let r = 0; r < repeatCount; r++) {
      for (const track of this.playlist) {
        const escapedPath = track.path.replace(/\\/g, '/').replace(/'/g, "'\\''");
        content += `file '${escapedPath}'\n`;
      }
    }

    fs.writeFileSync(this.playlistFile, content, 'utf8');
    return this.playlistFile;
  }

  startStream(streamKey = null) {
    this.manualStop = false;
    if (this.isStreaming) {
      throw new Error('Stream sedang berjalan!');
    }

    if (streamKey) {
      this.settings.streamKey = streamKey;
      this.saveSettings(this.settings);
    }

    if (!this.settings.streamKey || this.settings.streamKey.trim() === '') {
      throw new Error('Stream Key YouTube belum diisi!');
    }

    this.scanMedia();
    if (this.playlist.length === 0) {
      throw new Error('Silakan upload minimal 1 file musik (MP3) ke folder media/audio terlebih dahulu!');
    }

    let videoPath = '';
    if (this.settings.selectedVideo && this.videoFiles.includes(this.settings.selectedVideo)) {
      videoPath = path.join(this.mediaVideoDir, this.settings.selectedVideo);
    } else if (this.videoFiles.length > 0) {
      videoPath = path.join(this.mediaVideoDir, this.videoFiles[0]);
    } else {
      throw new Error('Silakan upload file video background (MP4) ke folder media/video terlebih dahulu!');
    }

    const playlistFilePath = this.generateConcatPlaylist();
    const fullRtmpDestination = `${this.settings.rtmpUrl.replace(/\/$/, '')}/${this.settings.streamKey.trim()}`;

    console.log(`Starting FFmpeg stream to: ${this.settings.rtmpUrl}/[HIDDEN_KEY]`);
    console.log(`Video background: ${videoPath}`);
    console.log(`Playlist tracks: ${this.playlist.length} files`);

    const videoPathEscaped = videoPath.replace(/\\/g, '/');
    const playlistPathEscaped = playlistFilePath.replace(/\\/g, '/');

    const fpsVal = this.settings.fps || 30;
    const gopSize = fpsVal * 2;

    const audioFilter = this.settings.audioNormalization !== false
      ? 'dynaudnorm=f=75:g=25:p=0.95,aresample=async=1'
      : 'aresample=async=1';

    this.ffmpegProcess = ffmpeg()
      .input(videoPathEscaped)
      .inputOptions([
        '-stream_loop -1',
        '-re'
      ])
      .input(playlistPathEscaped)
      .inputOptions([
        '-f concat',
        '-safe 0',
        '-re'
      ])
      .outputOptions([
        '-map 0:v:0',
        '-map 1:a:0',
        '-c:v libx264',
        `-preset ${this.settings.preset || 'veryfast'}`,
        '-tune zerolatency',
        '-profile:v baseline',
        `-b:v ${this.settings.videoBitrate || '2500k'}`,
        `-maxrate ${this.settings.videoBitrate || '2500k'}`,
        `-bufsize ${this.settings.videoBitrate || '2500k'}`,
        `-r ${fpsVal}`,
        `-g ${gopSize}`,
        `-keyint_min ${gopSize}`,
        '-sc_threshold 0',
        '-fps_mode cfr',
        '-pix_fmt yuv420p',
        '-c:a aac',
        `-b:a ${this.settings.audioBitrate || '190k'}`,
        '-ar 44100',
        '-ac 2',
        `-af ${audioFilter}`,
        '-flvflags no_duration_filesize',
        '-flush_packets 1',
        '-threads 2'
      ])
      .format('flv')
      .output(fullRtmpDestination);

    this.ffmpegProcess.on('start', (commandLine) => {
      console.log('FFmpeg stream started successfully!');
      this.isStreaming = true;
      this.startTime = Date.now();
      this.currentTrackIndex = 0;
      this.stats.currentTrack = this.playlist[0] ? this.playlist[0].title : 'Playing...';

      this.startUptimeTimer();
      this.emit('status', { isStreaming: true, message: 'Live Stream YouTube Berhasil Dimulai!' });
    });

    this.ffmpegProcess.on('progress', (progress) => {
      this.stats.fps = progress.currentFps || 0;
      this.stats.bitrate = `${progress.currentKbps || 0} kbits/s`;
      this.stats.frames = progress.frames || 0;
      this.stats.time = progress.timemark || '00:00:00';
      this.emit('progress', this.stats);
    });

    this.ffmpegProcess.on('error', (err, stdout, stderr) => {
      const wasManualStop = this.manualStop;
      const previousState = this.isStreaming;
      this.cleanupStream();

      if (wasManualStop || err.message.includes('SIGKILL')) {
        this.emit('status', { isStreaming: false, message: 'Stream berhasil dihentikan.' });
        return;
      }

      console.error('FFmpeg Stream Error:', err.message);
      this.emit('status', { isStreaming: false, error: `Stream error: ${err.message}` });

      if (previousState && !err.message.includes('Cannot find ffmpeg')) {
        console.log('Auto-recovery dalam 5 detik...');
        setTimeout(() => {
          if (!this.isStreaming && this.settings.streamKey) {
            try { this.startStream(); } catch (e) { console.error('Auto-restart gagal:', e.message); }
          }
        }, 5000);
      }
    });

    this.ffmpegProcess.on('end', () => {
      console.log('FFmpeg Stream finished/ended');
      this.cleanupStream();

      if (!this.manualStop && this.settings.streamKey) {
        console.log('Playlist habis! Auto-restart stream dalam 3 detik...');
        this.emit('status', { isStreaming: false, message: 'Playlist habis, auto-restart...' });
        setTimeout(() => {
          if (!this.isStreaming && !this.manualStop) {
            try {
              this.startStream();
              console.log('Stream berhasil di-restart otomatis!');
            } catch (e) {
              console.error('Auto-restart gagal:', e.message);
              this.emit('status', { isStreaming: false, error: e.message });
            }
          }
        }, 3000);
      } else {
        this.emit('status', { isStreaming: false, message: 'Stream Dihentikan' });
      }
    });

    this.ffmpegProcess.run();
    return true;
  }

  stopStream() {
    this.manualStop = true;
    if (!this.isStreaming || !this.ffmpegProcess) {
      return false;
    }
    console.log('Stopping stream manually via dashboard...');
    this.isStreaming = false;
    try {
      this.ffmpegProcess.kill('SIGKILL');
    } catch (e) {
      console.error('Error killing FFmpeg process:', e.message);
    }
    this.cleanupStream();
    this.emit('status', { isStreaming: false, message: 'Stream berhasil dihentikan' });
    return true;
  }

  skipTrack() {
    if (!this.isStreaming || this.playlist.length === 0) return null;
    this.currentTrackIndex = (this.currentTrackIndex + 1) % this.playlist.length;
    this.stats.currentTrack = this.playlist[this.currentTrackIndex].title;
    this.emit('trackChanged', { currentTrack: this.stats.currentTrack });
    return this.stats.currentTrack;
  }

  startUptimeTimer() {
    if (this.uptimeInterval) clearInterval(this.uptimeInterval);
    this.uptimeInterval = setInterval(() => {
      if (this.startTime && this.isStreaming) {
        this.stats.uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);
      } else {
        this.stats.uptimeSeconds = 0;
      }
    }, 1000);
  }

  cleanupStream() {
    this.isStreaming = false;
    this.ffmpegProcess = null;
    this.startTime = null;
    if (this.uptimeInterval) {
      clearInterval(this.uptimeInterval);
      this.uptimeInterval = null;
    }
    this.stats = {
      fps: 0,
      bitrate: '0 kbits/s',
      frames: 0,
      time: '00:00:00',
      uptimeSeconds: 0,
      currentTrack: null
    };
  }

  async getDurations() {
    const durations = {};
    const promises = (this.playlist || []).map(track => {
      return new Promise((resolve) => {
        ffmpeg.ffprobe(track.path, (err, metadata) => {
          durations[track.filename] = (!err && metadata?.format?.duration)
            ? Math.floor(metadata.format.duration)
            : 0;
          resolve();
        });
      });
    });
    await Promise.all(promises);
    return durations;
  }

  getStatus() {
    return {
      isStreaming: this.isStreaming,
      stats: this.stats,
      settings: this.settings,
      hasStreamKey: Boolean(this.settings.streamKey && this.settings.streamKey.trim()),
      media: this.scanMedia()
    };
  }
}

module.exports = StreamEngine;
