document.addEventListener('DOMContentLoaded', () => {
  // ─── DOM References ────────────────────────────────────────
  const liveIndicator     = document.getElementById('live-indicator');
  const liveStatusText    = document.getElementById('live-status-text');
  const btnToggleStream   = document.getElementById('btn-toggle-stream');
  const btnStreamText     = document.getElementById('btn-stream-text');
  const btnOpenSettings   = document.getElementById('btn-open-settings');

  const bgVideoPreview    = document.getElementById('bg-video-preview');
  const nowPlayingTitle   = document.getElementById('now-playing-title');
  const previewRes        = document.getElementById('preview-res');

  const statCpu   = document.getElementById('stat-cpu');
  const barCpu    = document.getElementById('bar-cpu');
  const statRam   = document.getElementById('stat-ram');
  const barRam    = document.getElementById('bar-ram');
  const statDisk  = document.getElementById('stat-disk');
  const barDisk   = document.getElementById('bar-disk');

  const statBitrate = document.getElementById('stat-bitrate');
  const statFps     = document.getElementById('stat-fps');
  const statFrames  = document.getElementById('stat-frames');
  const statUptime  = document.getElementById('stat-uptime');

  const dropzone          = document.getElementById('dropzone');
  const fileInput         = document.getElementById('file-input');
  const videoSelectorGrid = document.getElementById('video-selector-grid');
  const playlistList      = document.getElementById('playlist-list');
  const audioCount        = document.getElementById('audio-count');
  const videoCount        = document.getElementById('video-count');

  // Settings Modal
  const settingsModal    = document.getElementById('settings-modal');
  const btnCloseModal    = document.getElementById('btn-close-modal');
  const btnCancelSettings = document.getElementById('btn-cancel-settings');
  const settingsForm     = document.getElementById('settings-form');
  const inputStreamKey   = document.getElementById('input-stream-key');
  const inputResolution  = document.getElementById('input-resolution');
  const inputFps         = document.getElementById('input-fps');
  const inputVbitrate    = document.getElementById('input-vbitrate');
  const inputPreset      = document.getElementById('input-preset');
  const inputAudioNorm   = document.getElementById('input-audio-norm');
  const btnToggleKey     = document.getElementById('btn-toggle-key');
  const iconEyeKey       = document.getElementById('icon-eye-key');

  // Confirm Modal
  const confirmModal     = document.getElementById('confirm-modal');
  const btnConfirmCancel = document.getElementById('btn-confirm-cancel');
  const btnConfirmStop   = document.getElementById('btn-confirm-stop');

  // Error Banner
  const errorBanner      = document.getElementById('error-banner');
  const errorBannerText  = document.getElementById('error-banner-text');
  const btnDismissError  = document.getElementById('btn-dismiss-error');

  // Auth Modal
  const authModal        = document.getElementById('auth-modal');
  const authForm         = document.getElementById('auth-form');
  const authModalTitle   = document.getElementById('auth-modal-title');
  const authModalSubtitle= document.getElementById('auth-modal-subtitle');
  const authLabel        = document.getElementById('auth-label');
  const inputAuthPassword= document.getElementById('input-auth-password');
  const inputAuthConfirm = document.getElementById('input-auth-confirm');
  const authConfirmGroup = document.getElementById('auth-confirm-group');
  const btnAuthSubmit    = document.getElementById('btn-auth-submit');

  // ─── State ────────────────────────────────────────────────
  let isStreaming = false;
  let isProcessing = false;
  let isSetupMode = false;
  let ws = null;
  let currentSettings = {};
  let currentPlayingTitle = null;
  let cachedDurations = {};
  let pendingStop = false;   // resolves confirm modal promise

  // ─── Init ─────────────────────────────────────────────────
  fetchStatus();
  fetchMedia();
  checkAuthStatus();
  initWebSocket();
  fetchDurations();

  if (bgVideoPreview) {
    bgVideoPreview.muted = true;
    document.addEventListener('click', () => {
      bgVideoPreview.play().catch(() => {});
    }, { once: true });
  }

  // ─── Error Banner ─────────────────────────────────────────
  function showError(msg) {
    errorBannerText.textContent = msg;
    errorBanner.classList.remove('hidden');
    // re-trigger animation
    errorBanner.style.animation = 'none';
    requestAnimationFrame(() => {
      errorBanner.style.animation = '';
    });
    // auto-dismiss after 8s
    setTimeout(() => errorBanner.classList.add('hidden'), 8000);
  }

  btnDismissError.addEventListener('click', () => errorBanner.classList.add('hidden'));

  // ─── WebSocket ────────────────────────────────────────────
  function initWebSocket() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${window.location.host}`);

    ws.onopen = () => console.log('StreamPulse WS connected');

    ws.onmessage = (event) => {
      try { handleWebSocketMessage(JSON.parse(event.data)); }
      catch (e) { console.error('WS parse error:', e); }
    };

    ws.onclose = () => setTimeout(initWebSocket, 3000);
  }

  function handleWebSocketMessage(msg) {
    if (msg.type === 'INIT') {
      updateState(msg.data);
    } else if (msg.type === 'TELEMETRY') {
      updateTelemetry(msg.data);
    } else if (msg.type === 'STATUS_CHANGE') {
      if (msg.data.error) showError(msg.data.error);
      else if (msg.data.message) showToast(msg.data.message);
      fetchStatus();
    } else if (msg.type === 'STREAM_PROGRESS') {
      updateStreamStats(msg.data);
    } else if (msg.type === 'TRACK_CHANGED') {
      currentPlayingTitle = msg.data.currentTrack;
      nowPlayingTitle.textContent = currentPlayingTitle || 'Playing...';
      highlightCurrentTrack(currentPlayingTitle);
    }
  }

  // ─── State Update ─────────────────────────────────────────
  function updateState(data) {
    isStreaming = data.isStreaming;
    currentSettings = data.settings || {};

    const liveBadge    = document.getElementById('live-badge-overlay');
    const trackLabel   = document.getElementById('track-status-label');

    if (currentSettings.resolution) {
      previewRes.textContent = `${currentSettings.resolution} @ ${currentSettings.fps || 30}FPS`;
    }

    if (isStreaming) {
      liveIndicator.className = 'live-status online';
      liveStatusText.textContent = 'LIVE';
      btnToggleStream.className = 'btn btn-danger btn-glow';
      btnStreamText.textContent = 'Stop Live';
      if (liveBadge) { liveBadge.textContent = 'LIVE'; liveBadge.className = 'live-badge-overlay online-badge'; }
      if (trackLabel) trackLabel.textContent = 'NOW PLAYING';

      // highlight track from stats
      if (data.stats && data.stats.currentTrack) {
        currentPlayingTitle = data.stats.currentTrack;
        highlightCurrentTrack(currentPlayingTitle);
      }
    } else {
      liveIndicator.className = 'live-status offline';
      liveStatusText.textContent = 'OFFLINE';
      btnToggleStream.className = 'btn btn-primary btn-glow';
      btnStreamText.textContent = 'Start Live';
      if (liveBadge) { liveBadge.textContent = 'PREVIEW'; liveBadge.className = 'live-badge-overlay offline-badge'; }
      if (trackLabel) trackLabel.textContent = 'NOW PLAYING';
      clearTrackHighlight();
    }

    if (data.media) renderMedia(data.media);
  }

  function highlightCurrentTrack(title) {
    if (!title) return;
    document.querySelectorAll('.playlist-item').forEach(item => {
      const itemTitle = item.getAttribute('data-track-title');
      item.classList.toggle('playing', itemTitle === title);
    });
  }

  function clearTrackHighlight() {
    document.querySelectorAll('.playlist-item.playing').forEach(el => el.classList.remove('playing'));
  }

  // ─── Telemetry ────────────────────────────────────────────
  function updateTelemetry(data) {
    const sys = data.system;
    const stream = data.stream;

    statCpu.textContent  = `${sys.cpuLoad}%`;
    barCpu.style.width   = `${sys.cpuLoad}%`;
    statRam.textContent  = `${sys.ramUsed} / ${sys.ramTotal} GB`;
    barRam.style.width   = `${sys.ramPercent}%`;
    statDisk.textContent = `${sys.diskUsedGB} / ${sys.diskTotalGB} GB`;
    barDisk.style.width  = `${sys.diskPercent}%`;

    if (stream.isStreaming && stream.stats) updateStreamStats(stream.stats);
  }

  function updateStreamStats(stats) {
    statBitrate.textContent = stats.bitrate || '0 kbits/s';
    statFps.textContent     = `${stats.fps || 0} FPS`;
    statFrames.textContent  = stats.frames || 0;

    if (stats.currentTrack && stats.currentTrack !== currentPlayingTitle) {
      currentPlayingTitle = stats.currentTrack;
      nowPlayingTitle.textContent = currentPlayingTitle;
      highlightCurrentTrack(currentPlayingTitle);
    }

    if (stats.uptimeSeconds) {
      const h = String(Math.floor(stats.uptimeSeconds / 3600)).padStart(2, '0');
      const m = String(Math.floor((stats.uptimeSeconds % 3600) / 60)).padStart(2, '0');
      const s = String(stats.uptimeSeconds % 60).padStart(2, '0');
      statUptime.textContent = `Uptime: ${h}:${m}:${s}`;
    } else {
      statUptime.textContent = 'Uptime: 00:00:00';
    }
  }

  // ─── Fetch ────────────────────────────────────────────────
  async function fetchStatus() {
    try {
      const data = await fetch('/api/status').then(r => r.json());
      updateState(data);
    } catch (err) {
      console.error('fetchStatus:', err);
    }
  }

  async function fetchMedia() {
    try {
      const media = await fetch('/api/media').then(r => r.json());
      renderMedia(media);
    } catch (err) {
      console.error('fetchMedia:', err);
    }
  }

  async function fetchDurations() {
    try {
      cachedDurations = await fetch('/api/media/durations').then(r => r.json());
      // update displayed durations if playlist already rendered
      document.querySelectorAll('.playlist-item[data-track-filename]').forEach(item => {
        const fn = item.getAttribute('data-track-filename');
        const durEl = item.querySelector('.track-duration');
        if (durEl && cachedDurations[fn]) durEl.textContent = formatDuration(cachedDurations[fn]);
      });
    } catch (err) {
      console.error('fetchDurations:', err);
    }
  }

  function formatDuration(secs) {
    if (!secs) return '';
    const m = Math.floor(secs / 60);
    const s = String(secs % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  // ─── Render Media ─────────────────────────────────────────
  function renderMedia(media, newFilenames = []) {
    // Audio playlist
    const playlist = media.playlist || [];
    audioCount.textContent = `${playlist.length} Track`;
    playlistList.innerHTML = '';

    if (playlist.length === 0) {
      playlistList.innerHTML = '<div class="drop-sub" style="text-align:center;padding:1rem;">Belum ada file audio. Upload file MP3.</div>';
    } else {
      playlist.forEach((track, idx) => {
        const dur = cachedDurations[track.filename] ? formatDuration(cachedDurations[track.filename]) : '';
        const isNew = newFilenames.includes(track.filename);
        const isPlaying = isStreaming && currentPlayingTitle === track.title;

        const item = document.createElement('div');
        item.className = `playlist-item${isPlaying ? ' playing' : ''}${isNew ? ' new-item' : ''}`;
        item.setAttribute('data-track-title', track.title);
        item.setAttribute('data-track-filename', track.filename);
        item.innerHTML = `
          <div class="track-name-box">
            <span class="track-index">${idx + 1}.</span>
            <i data-lucide="music" style="width:15px;flex-shrink:0;color:var(--accent);"></i>
            <span class="track-title-text">${track.title}</span>
          </div>
          ${dur ? `<span class="track-duration">${dur}</span>` : '<span class="track-duration">--:--</span>'}
          <button class="delete-track-btn" data-type="audio" data-filename="${track.filename}" title="Hapus">
            <i data-lucide="trash-2" style="width:14px;"></i>
          </button>
        `;
        playlistList.appendChild(item);
      });
    }

    // Video selector
    const videoFiles = media.videoFiles || [];
    videoCount.textContent = `${videoFiles.length} File`;
    videoSelectorGrid.innerHTML = '';

    if (videoFiles.length === 0) {
      videoSelectorGrid.innerHTML = '<div class="drop-sub" style="grid-column:span 2;text-align:center;padding:1rem;">Belum ada video background. Upload file MP4.</div>';
      bgVideoPreview.src = '';
    } else {
      videoFiles.forEach(vid => {
        const isSelected = media.selectedVideo === vid;
        const item = document.createElement('div');
        item.className = `video-item${isSelected ? ' active' : ''}`;
        item.innerHTML = `
          <i data-lucide="film" style="width:22px;color:var(--primary);"></i>
          <span>${vid}</span>
          <button class="delete-track-btn" data-type="video" data-filename="${vid}" title="Hapus" style="position:absolute;top:4px;right:4px;">
            <i data-lucide="x" style="width:13px;"></i>
          </button>
        `;
        item.addEventListener('click', (e) => {
          if (e.target.closest('.delete-track-btn')) return;
          selectVideo(vid);
        });
        videoSelectorGrid.appendChild(item);
      });

      bgVideoPreview.muted = true;
      bgVideoPreview.src = '/api/preview-video?t=' + Date.now();
      bgVideoPreview.load();
      bgVideoPreview.play().catch(() => {});
    }

    lucide.createIcons();
    attachDeleteHandlers();
  }

  async function selectVideo(vid) {
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedVideo: vid })
      });
      fetchMedia();
    } catch { showToast('Gagal memilih video', true); }
  }

  function attachDeleteHandlers() {
    document.querySelectorAll('.delete-track-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const type = btn.getAttribute('data-type');
        const filename = btn.getAttribute('data-filename');
        if (!confirm(`Hapus "${filename}"?`)) return;
        try {
          const data = await fetch(`/api/media/${type}/${encodeURIComponent(filename)}`, { method: 'DELETE' }).then(r => r.json());
          if (data.success) { showToast(data.message || 'Dihapus!'); fetchMedia(); fetchDurations(); }
          else showToast(data.error || 'Gagal hapus', true);
        } catch { showToast('Gagal hapus', true); }
      });
    });
  }

  // ─── Stream Toggle ─────────────────────────────────────────
  btnToggleStream.addEventListener('click', async () => {
    if (isProcessing) return;

    if (isStreaming) {
      // Show custom confirm modal
      showConfirmModal();
    } else {
      if (!currentSettings.streamKey) {
        openSettingsModal();
        return;
      }
      await doStartStream();
    }
  });

  function showConfirmModal() {
    confirmModal.classList.remove('hidden');
    lucide.createIcons();
  }

  function hideConfirmModal() {
    confirmModal.classList.add('hidden');
  }

  btnConfirmCancel.addEventListener('click', hideConfirmModal);

  // Close confirm modal on backdrop click
  confirmModal.addEventListener('click', (e) => {
    if (e.target === confirmModal) hideConfirmModal();
  });

  btnConfirmStop.addEventListener('click', async () => {
    hideConfirmModal();
    await doStopStream();
  });

  async function doStartStream() {
    isProcessing = true;
    btnToggleStream.disabled = true;
    btnStreamText.textContent = 'Starting...';
    btnToggleStream.classList.add('btn-loading');

    try {
      const data = await fetch('/api/stream/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamKey: currentSettings.streamKey })
      }).then(r => r.json());

      if (data.success) showToast(data.message);
      else { showError(data.error || 'Gagal memulai stream'); }
    } catch {
      showError('Tidak bisa terhubung ke server');
    }

    await new Promise(r => setTimeout(r, 2000));
    fetchStatus();
    btnToggleStream.classList.remove('btn-loading');
    btnToggleStream.disabled = false;
    isProcessing = false;
  }

  async function doStopStream() {
    isProcessing = true;
    btnToggleStream.disabled = true;
    btnStreamText.textContent = 'Stopping...';
    btnToggleStream.classList.add('btn-loading');

    try {
      const data = await fetch('/api/stream/stop', { method: 'POST' }).then(r => r.json());
      showToast(data.message || 'Stream dihentikan');
      clearTrackHighlight();
      nowPlayingTitle.textContent = 'Idle';
    } catch {
      showError('Gagal menghentikan stream');
    }

    await new Promise(r => setTimeout(r, 1500));
    fetchStatus();
    btnToggleStream.classList.remove('btn-loading');
    btnToggleStream.disabled = false;
    isProcessing = false;
  }

  // ─── Upload ───────────────────────────────────────────────
  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => uploadFiles(fileInput.files));

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'var(--primary)';
    dropzone.style.background = 'rgba(99,102,241,0.08)';
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.style.borderColor = 'rgba(255,255,255,0.15)';
    dropzone.style.background = '';
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'rgba(255,255,255,0.15)';
    dropzone.style.background = '';
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  });

  async function uploadFiles(files) {
    if (!files.length) return;

    const uploadedNames = Array.from(files).map(f => f.name);
    const formData = new FormData();
    for (let i = 0; i < files.length; i++) formData.append('files', files[i]);

    const progressContainer = document.getElementById('upload-progress-container');
    const progressBar       = document.getElementById('upload-progress-bar');
    const statusText        = document.getElementById('upload-status-text');

    progressContainer.classList.remove('hidden');
    progressBar.style.width = '0%';
    statusText.textContent = `Uploading ${files.length} file...`;

    await new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload', true);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          progressBar.style.width = `${pct}%`;
          statusText.textContent = `Uploading: ${pct}%`;
        }
      };

      xhr.onload = async () => {
        progressContainer.classList.add('hidden');
        fileInput.value = '';
        if (xhr.status === 200) {
          const result = JSON.parse(xhr.responseText);
          showToast(`${result.files?.length || files.length} file berhasil diupload!`);
          // fetch fresh durations first, then render with new-item flash
          await fetchDurations();
          const media = await fetch('/api/media').then(r => r.json());
          // match uploaded files by checking if title contains original name fragment
          const newFns = (media.playlist || [])
            .filter(t => uploadedNames.some(n => t.filename.includes(n.replace(/\.[^.]+$/, ''))))
            .map(t => t.filename);
          renderMedia(media, newFns);
        } else {
          showError('Gagal upload file — coba lagi');
        }
        resolve();
      };

      xhr.onerror = () => {
        progressContainer.classList.add('hidden');
        showError('Koneksi error saat upload');
        resolve();
      };

      xhr.send(formData);
    });
  }

  // ─── Settings Modal ───────────────────────────────────────
  btnOpenSettings.addEventListener('click', openSettingsModal);
  btnCloseModal.addEventListener('click', closeSettingsModal);
  btnCancelSettings.addEventListener('click', closeSettingsModal);

  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettingsModal();
  });

  function openSettingsModal() {
    if (currentSettings.streamKey) inputStreamKey.value = currentSettings.streamKey;
    if (currentSettings.resolution) inputResolution.value = currentSettings.resolution;
    if (currentSettings.fps) inputFps.value = currentSettings.fps;
    if (currentSettings.videoBitrate) inputVbitrate.value = currentSettings.videoBitrate;
    if (currentSettings.preset) inputPreset.value = currentSettings.preset;
    if (inputAudioNorm) inputAudioNorm.checked = currentSettings.audioNormalization !== false;
    settingsModal.classList.remove('hidden');
    lucide.createIcons();
  }

  function closeSettingsModal() {
    settingsModal.classList.add('hidden');
    // reset stream key visibility
    inputStreamKey.type = 'password';
    if (iconEyeKey) iconEyeKey.setAttribute('data-lucide', 'eye');
    lucide.createIcons();
  }

  // Stream Key Eye Toggle
  if (btnToggleKey) {
    btnToggleKey.addEventListener('click', () => {
      const isHidden = inputStreamKey.type === 'password';
      inputStreamKey.type = isHidden ? 'text' : 'password';
      iconEyeKey.setAttribute('data-lucide', isHidden ? 'eye-off' : 'eye');
      lucide.createIcons();
    });
  }

  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newSettings = {
      streamKey:          inputStreamKey.value.trim() || currentSettings.streamKey || '',
      resolution:         inputResolution.value,
      fps:                parseInt(inputFps.value, 10),
      videoBitrate:       inputVbitrate.value,
      preset:             inputPreset.value,
      audioNormalization: inputAudioNorm ? inputAudioNorm.checked : true
    };

    try {
      const data = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings)
      }).then(r => r.json());

      if (data.success) {
        showToast('Settings tersimpan!');
        closeSettingsModal();
        fetchStatus();
      }
    } catch { showToast('Gagal menyimpan settings', true); }
  });

  // ─── Auth Modal ───────────────────────────────────────────
  async function checkAuthStatus() {
    if (!authModal) return;
    try {
      const data = await fetch('/api/auth/status', {
        headers: { 'Authorization': `Bearer ${localStorage.getItem('sp_auth_token') || ''}` }
      }).then(r => r.json());

      if (!data.hasPassword) {
        isSetupMode = true;
        if (authModalTitle)    authModalTitle.innerHTML = '<i data-lucide="shield-alert"></i> Set Master Password';
        if (authModalSubtitle) authModalSubtitle.textContent = 'Set password untuk mengamankan dashboard VPS kamu.';
        if (authConfirmGroup)  authConfirmGroup.classList.remove('hidden');
        if (authLabel)         authLabel.textContent = 'Password Baru';
        if (btnAuthSubmit)     btnAuthSubmit.textContent = 'Simpan & Masuk';
        authModal.classList.remove('hidden');
        lucide.createIcons();
      } else if (!data.isAuthenticated) {
        isSetupMode = false;
        if (authModalTitle)    authModalTitle.innerHTML = '<i data-lucide="lock"></i> Login';
        if (authModalSubtitle) authModalSubtitle.textContent = 'Masukkan password dashboard.';
        if (authConfirmGroup)  authConfirmGroup.classList.add('hidden');
        if (authLabel)         authLabel.textContent = 'Password';
        if (btnAuthSubmit)     btnAuthSubmit.textContent = 'Login';
        authModal.classList.remove('hidden');
        lucide.createIcons();
      } else {
        authModal.classList.add('hidden');
      }
    } catch {
      if (authModal) authModal.classList.add('hidden');
    }
  }

  if (authForm) {
    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pass    = inputAuthPassword?.value.trim() || '';
      const confirm = inputAuthConfirm?.value.trim()  || '';

      if (isSetupMode) {
        if (pass.length < 4) { showToast('Password minimal 4 karakter!', true); return; }
        if (pass !== confirm) { showToast('Password tidak cocok!', true); return; }
        try {
          const data = await fetch('/api/auth/setup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pass })
          }).then(r => r.json());
          if (data.success) {
            localStorage.setItem('sp_auth_token', pass);
            showToast('Password berhasil dibuat!');
            authModal.classList.add('hidden');
          } else showToast(data.error || 'Gagal', true);
        } catch { showToast('Error koneksi', true); }
      } else {
        try {
          const data = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pass })
          }).then(r => r.json());
          if (data.success) {
            localStorage.setItem('sp_auth_token', data.token);
            showToast('Login berhasil!');
            authModal.classList.add('hidden');
          } else showToast(data.error || 'Password salah!', true);
        } catch { showToast('Error koneksi', true); }
      }
    });
  }

  // ─── Toast ────────────────────────────────────────────────
  function showToast(msg, isError = false) {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed; bottom: 24px; right: 24px; z-index: 9999;
      background: ${isError ? 'var(--danger)' : 'var(--success)'};
      color: #fff; padding: 12px 20px; border-radius: 12px;
      font-weight: 600; font-size: 0.88rem;
      box-shadow: 0 12px 32px rgba(0,0,0,0.5);
      animation: toastIn 0.3s cubic-bezier(0.34,1.56,0.64,1) forwards;
    `;
    toast.textContent = msg;
    // inject animation if not already in page
    if (!document.getElementById('toast-style')) {
      const s = document.createElement('style');
      s.id = 'toast-style';
      s.textContent = `
        @keyframes toastIn {
          from { opacity:0; transform: translateY(12px) scale(0.95); }
          to   { opacity:1; transform: translateY(0) scale(1); }
        }
      `;
      document.head.appendChild(s);
    }
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }
});
