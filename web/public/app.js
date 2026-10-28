document.addEventListener('DOMContentLoaded', () => {
  const htmlRoot = document.documentElement;
  const themeLightBtn = document.getElementById('themeLightBtn');
  const themeDarkBtn = document.getElementById('themeDarkBtn');

  const extractForm = document.getElementById('extractForm');
  const dockUrl = document.getElementById('dockUrl');
  const clearInputBtn = document.getElementById('clearInputBtn');
  const pasteBtn = document.getElementById('pasteBtn');
  const pasteBtnLabel = document.getElementById('pasteBtnLabel');
  const sampleBtn = document.getElementById('sampleBtn');
  const modePills = document.querySelectorAll('.mode-pill');
  const extractBtn = document.getElementById('extractBtn');

  const errorBanner = document.getElementById('errorBanner');
  const errorText = document.getElementById('errorText');
  const dismissErrorBtn = document.getElementById('dismissErrorBtn');

  const inspectorCard = document.getElementById('inspectorCard');
  const resetInspectorBtn = document.getElementById('resetInspectorBtn');
  const mediaTypeBadge = document.getElementById('mediaTypeBadge');
  const mediaIdBadge = document.getElementById('mediaIdBadge');

  const statViews = document.getElementById('statViews');
  const statLikes = document.getElementById('statLikes');
  const statComments = document.getElementById('statComments');
  const statShares = document.getElementById('statShares');

  const mediaVideo = document.getElementById('mediaVideo');
  const playerTrigger = document.getElementById('playerTrigger');
  const playOverlay = document.getElementById('playOverlay');
  const muteBtn = document.getElementById('muteBtn');
  const timecodeText = document.getElementById('timecodeText');
  const scrubberFill = document.getElementById('scrubberFill');

  const creatorAvatar = document.getElementById('creatorAvatar');
  const creatorName = document.getElementById('creatorName');
  const creatorHandle = document.getElementById('creatorHandle');
  const durationTag = document.getElementById('durationTag');
  const mediaCaption = document.getElementById('mediaCaption');
  const audioTitle = document.getElementById('audioTitle');

  const photoGridWrap = document.getElementById('photoGridWrap');
  const photoCountLabel = document.getElementById('photoCountLabel');
  const photoGrid = document.getElementById('photoGrid');

  const btnHdVideo = document.getElementById('btnHdVideo');
  const videoSubLabel = document.getElementById('videoSubLabel');
  const btnAudioMp3 = document.getElementById('btnAudioMp3');
  const btnFastServer = document.getElementById('btnFastServer');
  const btnCover = document.getElementById('btnCover');
  const btnCopyLink = document.getElementById('btnCopyLink');

  const recentSection = document.getElementById('recentSection');
  const recentList = document.getElementById('recentList');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  const edgeTelemetryLabel = document.getElementById('edgeTelemetryLabel');

  const THEME_KEY = 'rh_tiktok_studio_theme';
  const HISTORY_KEY = 'rh_tiktok_user_downloads_v3';
  const DEMO_LINK = 'https://vt.tiktok.com/ZSgQuVgCe/';
  let currentCleanUrl = '';
  let selectedMode = 'all';

  // 1. Theme Switcher (Default Light Mode, Switchable to Dark Mode)
  function applyTheme(theme) {
    const mode = theme === 'dark' ? 'dark' : 'light';
    htmlRoot.setAttribute('data-theme', mode);
    if (themeLightBtn && themeDarkBtn) {
      themeLightBtn.classList.toggle('active', mode === 'light');
      themeLightBtn.setAttribute('aria-pressed', String(mode === 'light'));
      themeDarkBtn.classList.toggle('active', mode === 'dark');
      themeDarkBtn.setAttribute('aria-pressed', String(mode === 'dark'));
    }
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch {}
  }

  try {
    const savedTheme = localStorage.getItem(THEME_KEY);
    const initialTheme = savedTheme || htmlRoot.getAttribute('data-theme') || 'light';
    applyTheme(initialTheme);
  } catch {
    applyTheme('light');
  }

  if (themeLightBtn) {
    themeLightBtn.addEventListener('click', () => applyTheme('light'));
  }
  if (themeDarkBtn) {
    themeDarkBtn.addEventListener('click', () => applyTheme('dark'));
  }

  // 2. Interactive Output Mode Selector
  modePills.forEach((pill) => {
    pill.addEventListener('click', () => {
      selectedMode = pill.getAttribute('data-mode') || 'all';
      modePills.forEach((p) => {
        const active = p === pill;
        p.classList.toggle('active', active);
        p.setAttribute('aria-pressed', String(active));
      });
    });
  });

  // 3. Clean String & Number Formatting
  function cleanLabel(str, fallback = 'TikTok Media') {
    if (!str) return fallback;
    const stripped = String(str)
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    return stripped || fallback;
  }

  function formatNumber(n) {
    return Number(n || 0).toLocaleString('en-US');
  }

  function formatTimecode(sec) {
    const total = Math.max(0, Math.floor(Number(sec || 0)));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // 4. Input Clear Button Visibility
  function syncInputState() {
    if (clearInputBtn) {
      clearInputBtn.style.display = dockUrl.value.trim().length > 0 ? 'inline-flex' : 'none';
    }
  }

  dockUrl.addEventListener('input', syncInputState);

  if (clearInputBtn) {
    clearInputBtn.addEventListener('click', () => {
      dockUrl.value = '';
      syncInputState();
      dockUrl.focus();
    });
  }

  if (dismissErrorBtn) {
    dismissErrorBtn.addEventListener('click', () => {
      errorBanner.style.display = 'none';
    });
  }

  if (resetInspectorBtn) {
    resetInspectorBtn.addEventListener('click', () => {
      if (mediaVideo) mediaVideo.pause();
      inspectorCard.style.display = 'none';
      dockUrl.value = '';
      syncInputState();
      dockUrl.focus();
    });
  }

  // 5. Load Live Edge Health Telemetry
  async function loadEdgeStats() {
    try {
      const res = await fetch('/health');
      if (!res.ok) return;
      const json = await res.json();
      if (json?.stats && edgeTelemetryLabel) {
        const cached = Number(json.stats.cachedVideos || 0);
        edgeTelemetryLabel.textContent =
          cached > 0
            ? `Cloudflare Edge · ${formatNumber(cached)} Cached · 3 Engines`
            : 'Cloudflare Edge · 3 Engines Active';
      }
    } catch {}
  }
  loadEdgeStats();

  // 6. User's Own Session History (Only shown when user has downloaded something)
  function getHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveToHistory(item) {
    try {
      const existing = getHistory().filter((x) => x.id !== item.id);
      const updated = [item, ...existing].slice(0, 3);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
      renderHistory(updated);
    } catch {}
  }

  function renderHistory(items) {
    if (!recentSection || !recentList) return;
    if (!Array.isArray(items) || items.length === 0) {
      recentSection.style.display = 'none';
      recentList.innerHTML = '';
      return;
    }

    recentSection.style.display = 'flex';
    recentList.innerHTML = '';
    for (const item of items.slice(0, 3)) {
      const card = document.createElement('div');
      card.className = 'recent-item';
      card.setAttribute('role', 'listitem');

      const img = document.createElement('img');
      img.className = 'recent-thumb';
      img.src = item.cover || 'sample-cover.jpg';
      img.alt = 'Downloaded video thumbnail';

      const info = document.createElement('div');
      info.className = 'recent-info';

      const title = document.createElement('span');
      title.className = 'recent-title';
      title.textContent = cleanLabel(item.title, 'TikTok Video');

      const sub = document.createElement('span');
      sub.className = 'recent-sub';
      sub.textContent = `${item.handle || '@tiktok'} · ${formatTimecode(item.duration || 0)}`;

      info.appendChild(title);
      info.appendChild(sub);

      const loadBtn = document.createElement('button');
      loadBtn.type = 'button';
      loadBtn.className = 'btn-recent-load';
      loadBtn.textContent = 'Open';
      loadBtn.addEventListener('click', () => {
        dockUrl.value = item.url || `https://www.tiktok.com/@a/video/${item.id}`;
        syncInputState();
        runExtraction(dockUrl.value);
      });

      card.appendChild(img);
      card.appendChild(info);
      card.appendChild(loadBtn);
      recentList.appendChild(card);
    }
  }

  renderHistory(getHistory());

  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', () => {
      try {
        localStorage.removeItem(HISTORY_KEY);
      } catch {}
      renderHistory([]);
    });
  }

  // 7. Video Player Transport Controls
  if (playerTrigger && mediaVideo) {
    playerTrigger.addEventListener('click', (e) => {
      if (e.target.closest('#muteBtn')) return;
      if (mediaVideo.paused) {
        mediaVideo.play().catch(() => {});
      } else {
        mediaVideo.pause();
      }
    });

    mediaVideo.addEventListener('play', () => {
      playOverlay.classList.add('playing');
    });

    mediaVideo.addEventListener('pause', () => {
      playOverlay.classList.remove('playing');
    });

    mediaVideo.addEventListener('ended', () => {
      playOverlay.classList.remove('playing');
    });

    mediaVideo.addEventListener('timeupdate', () => {
      const cur = mediaVideo.currentTime || 0;
      const dur = mediaVideo.duration || 0;
      if (timecodeText) {
        timecodeText.textContent = `${formatTimecode(cur)} / ${formatTimecode(dur)}`;
      }
      if (scrubberFill && dur > 0) {
        const pct = Math.min(100, Math.max(0, (cur / dur) * 100));
        scrubberFill.style.width = `${pct.toFixed(1)}%`;
      }
    });
  }

  if (muteBtn && mediaVideo) {
    muteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      mediaVideo.muted = !mediaVideo.muted;
      muteBtn.style.opacity = mediaVideo.muted ? '0.55' : '1';
    });
  }

  // 8. Paste Clipboard & Sample Link Buttons
  if (pasteBtn) {
    pasteBtn.addEventListener('click', async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          const text = await navigator.clipboard.readText();
          if (text && text.trim()) {
            dockUrl.value = text.trim();
            syncInputState();
            if (pasteBtnLabel) pasteBtnLabel.textContent = 'Pasted';
            setTimeout(() => {
              if (pasteBtnLabel) pasteBtnLabel.textContent = 'Paste Link';
            }, 1200);
            runExtraction(dockUrl.value);
          } else {
            dockUrl.focus();
          }
        } else {
          dockUrl.focus();
        }
      } catch {
        dockUrl.focus();
      }
    });
  }

  if (sampleBtn) {
    sampleBtn.addEventListener('click', () => {
      dockUrl.value = DEMO_LINK;
      syncInputState();
      runExtraction(DEMO_LINK);
    });
  }

  // 9. Copy Clean Link Button
  if (btnCopyLink) {
    btnCopyLink.addEventListener('click', async () => {
      if (!currentCleanUrl) return;
      try {
        await navigator.clipboard.writeText(currentCleanUrl);
        btnCopyLink.textContent = 'Copied Link';
        setTimeout(() => {
          btnCopyLink.textContent = 'Copy Clean Link';
        }, 1200);
      } catch {}
    });
  }

  // 10. Core Extraction Handler
  async function runExtraction(rawUrl) {
    const url = (rawUrl || '').trim();
    if (!url) {
      dockUrl.focus();
      return;
    }

    errorBanner.style.display = 'none';
    const btnText = extractBtn.querySelector('.btn-text');
    const btnSpinner = extractBtn.querySelector('.btn-spinner');
    btnText.style.display = 'none';
    btnSpinner.style.display = 'inline';
    extractBtn.disabled = true;

    try {
      const response = await fetch(`/api/extract?url=${encodeURIComponent(url)}`);
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Could not resolve TikTok link. Please check that the video is public.');
      }

      currentCleanUrl = data.id ? `https://www.tiktok.com/@${data.author?.unique_id || 'a'}/video/${data.id}` : url;

      const isPhoto = Array.isArray(data.images) && data.images.length > 0;
      mediaTypeBadge.textContent = isPhoto ? `Photo Carousel · ${data.images.length} Slides` : 'No Watermark · MP4';
      mediaIdBadge.textContent = data.id ? `#${String(data.id).slice(0, 8)}` : '#Resolved';

      statViews.textContent = formatNumber(data.stats?.views || 0);
      statLikes.textContent = formatNumber(data.stats?.likes || 0);
      statComments.textContent = formatNumber(data.stats?.comments || 0);
      statShares.textContent = formatNumber(data.stats?.shares || 0);

      creatorAvatar.src = data.author?.avatar || 'sample-avatar.jpg';
      creatorName.textContent = cleanLabel(data.author?.nickname, 'TikTok Creator');
      const handleStr = data.author?.unique_id ? `@${data.author.unique_id.replace(/^@/, '')}` : '@tiktok';
      creatorHandle.textContent = handleStr;

      const durSec = Number(data.duration || 0);
      const sizeMb = data.sizeBytes ? ` · ${(data.sizeBytes / 1024 / 1024).toFixed(1)} MB` : '';
      durationTag.textContent = durSec > 0 ? `${durSec}s${sizeMb}` : `HD Stream${sizeMb}`;

      mediaCaption.textContent = cleanLabel(data.title, 'Original TikTok media stream.');
      audioTitle.textContent = cleanLabel(data.music?.title, 'Original Sound');

      const playableVideo = data.downloads?.fast_video || data.downloads?.hd_video;
      if (isPhoto) {
        photoGridWrap.style.display = 'flex';
        photoCountLabel.textContent = `${data.images.length} slides`;
        photoGrid.innerHTML = '';
        data.images.slice(0, 6).forEach((imgUrl, idx) => {
          const a = document.createElement('a');
          a.className = 'photo-slide';
          a.href = `/api/download?url=${encodeURIComponent(imgUrl)}&filename=tiktok_${data.id || Date.now()}_slide_${idx + 1}.jpg`;
          a.setAttribute('download', '');
          const im = document.createElement('img');
          im.src = imgUrl;
          im.alt = `Carousel slide ${idx + 1}`;
          a.appendChild(im);
          photoGrid.appendChild(a);
        });
      } else {
        photoGridWrap.style.display = 'none';
      }

      if (playableVideo) {
        mediaVideo.src = `/api/download?url=${encodeURIComponent(playableVideo)}&inline=1`;
        mediaVideo.poster = data.cover || '';
        mediaVideo.load();
        timecodeText.textContent = `0:00 / ${formatTimecode(durSec)}`;
        scrubberFill.style.width = '0%';
      }

      const videoFilename = `tiktok_${data.id || Date.now()}_clean.mp4`;
      const audioFilename = `tiktok_${data.id || Date.now()}_audio.mp3`;

      if (data.downloads?.hd_video || data.downloads?.fast_video) {
        const targetVid = data.downloads.hd_video || data.downloads.fast_video;
        const fallbackVid = data.downloads.fast_video || '';
        btnHdVideo.href = `/api/download?url=${encodeURIComponent(targetVid)}&fallback=${encodeURIComponent(fallbackVid)}&filename=${encodeURIComponent(videoFilename)}`;
        btnHdVideo.style.display = selectedMode === 'audio' ? 'none' : 'flex';
        videoSubLabel.textContent = `Original MP4 · H.264 Stream${sizeMb}`;
      } else {
        btnHdVideo.style.display = 'none';
      }

      if (data.downloads?.audio) {
        btnAudioMp3.href = `/api/download?url=${encodeURIComponent(data.downloads.audio)}&filename=${encodeURIComponent(audioFilename)}`;
        btnAudioMp3.style.display = selectedMode === 'video' ? 'none' : 'flex';
      } else {
        btnAudioMp3.style.display = 'none';
      }

      if (data.downloads?.fast_video) {
        btnFastServer.href = `/api/download?url=${encodeURIComponent(data.downloads.fast_video)}&filename=${encodeURIComponent(videoFilename)}`;
        btnFastServer.style.display = 'inline-flex';
      }

      if (data.cover) {
        btnCover.href = data.cover;
      }

      inspectorCard.style.display = 'flex';
      inspectorCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      saveToHistory({
        id: String(data.id || Date.now()),
        url,
        title: cleanLabel(data.title, 'TikTok Video'),
        handle: handleStr,
        duration: durSec || 15,
        cover: data.cover || ''
      });

      loadEdgeStats();
    } catch (err) {
      errorText.textContent = err.message || 'Could not resolve TikTok link. Please check that the video is public.';
      errorBanner.style.display = 'flex';
    } finally {
      btnText.style.display = 'inline';
      btnSpinner.style.display = 'none';
      extractBtn.disabled = false;
    }
  }

  extractForm.addEventListener('submit', (e) => {
    e.preventDefault();
    runExtraction(dockUrl.value);
  });
});
