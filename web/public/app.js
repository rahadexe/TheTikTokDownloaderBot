document.addEventListener('DOMContentLoaded', () => {
  const extractForm = document.getElementById('extractForm');
  const dockUrl = document.getElementById('dockUrl');
  const pasteBtn = document.getElementById('pasteBtn');
  const sampleBtn = document.getElementById('sampleBtn');
  const extractBtn = document.getElementById('extractBtn');
  const statusNotice = document.getElementById('statusNotice');
  const errorBanner = document.getElementById('errorBanner');
  const errorText = document.getElementById('errorText');
  const retryBtn = document.getElementById('retryBtn');

  const inspectorCard = document.getElementById('inspectorCard');
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

  const recentList = document.getElementById('recentList');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');
  const kvCacheCount = document.getElementById('kvCacheCount');

  const STORAGE_KEY = 'rh_tiktok_studio_recent_v2';
  const DEFAULT_SAMPLE_URL = 'https://vt.tiktok.com/ZSgQuVgCe/';
  let currentCleanUrl = DEFAULT_SAMPLE_URL;

  const DEFAULT_RECENT = [
    {
      id: '7692664817294773512',
      url: DEFAULT_SAMPLE_URL,
      title: 'Men peak level ego',
      handle: '@smdrasel54',
      duration: 59,
      cover: 'sample-cover.jpg'
    }
  ];

  // Strip emojis from dynamic text when needed for clean UI labels
  function cleanLabel(str, fallback = 'TikTok Media') {
    if (!str) return fallback;
    const stripped = String(str)
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
    return stripped || fallback;
  }

  function formatNumber(n) {
    const val = Number(n || 0);
    return val.toLocaleString('en-US');
  }

  function formatTimecode(sec) {
    const total = Math.max(0, Math.floor(Number(sec || 0)));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // Load live edge health stats quietly
  async function loadEdgeStats() {
    try {
      const res = await fetch('/health');
      if (!res.ok) return;
      const json = await res.json();
      if (json?.stats && kvCacheCount) {
        const cached = Number(json.stats.cachedVideos || 0);
        kvCacheCount.textContent = cached > 0 ? `${formatNumber(cached)} Cached · 30d TTL` : '30-Day Edge TTL';
      }
    } catch {}
  }
  loadEdgeStats();

  // Recent History Management
  function getHistory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return DEFAULT_RECENT;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_RECENT;
    } catch {
      return DEFAULT_RECENT;
    }
  }

  function saveToHistory(item) {
    try {
      const existing = getHistory().filter((x) => x.id !== item.id);
      const updated = [item, ...existing].slice(0, 3);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      renderHistory(updated);
    } catch {}
  }

  function renderHistory(items) {
    if (!recentList) return;
    recentList.innerHTML = '';
    for (const item of items.slice(0, 3)) {
      const row = document.createElement('div');
      row.className = 'recent-row';
      row.setAttribute('role', 'listitem');

      const img = document.createElement('img');
      img.className = 'recent-thumb';
      img.src = item.cover || 'sample-cover.jpg';
      img.alt = 'Clip thumbnail';

      const info = document.createElement('div');
      info.className = 'recent-info';

      const t = document.createElement('span');
      t.className = 'recent-title';
      t.textContent = cleanLabel(item.title, 'TikTok Video');

      const s = document.createElement('span');
      s.className = 'recent-sub';
      s.textContent = `${item.handle || '@tiktok'} · MP4 + MP3`;

      info.appendChild(t);
      info.appendChild(s);

      const right = document.createElement('div');
      right.className = 'recent-right';

      const dur = document.createElement('span');
      dur.className = 'recent-dur num';
      dur.textContent = formatTimecode(item.duration || 0);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'row-load-btn';
      btn.textContent = 'Inspect';
      btn.addEventListener('click', () => {
        dockUrl.value = item.url || `https://www.tiktok.com/@a/video/${item.id}`;
        runExtraction(dockUrl.value);
      });

      right.appendChild(dur);
      right.appendChild(btn);

      row.appendChild(img);
      row.appendChild(info);
      row.appendChild(right);
      recentList.appendChild(row);
    }
  }

  renderHistory(getHistory());

  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', () => {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {}
      renderHistory(DEFAULT_RECENT);
    });
  }

  // Video Transport Controls
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
      const dur = mediaVideo.duration || 59;
      if (timecodeText) {
        timecodeText.textContent = `${formatTimecode(cur)} / ${formatTimecode(dur)}`;
      }
      if (scrubberFill && dur > 0) {
        const pct = Math.min(100, Math.max(4, (cur / dur) * 100));
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

  // Paste Button
  if (pasteBtn) {
    pasteBtn.addEventListener('click', async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          const text = await navigator.clipboard.readText();
          if (text) {
            dockUrl.value = text.trim();
            pasteBtn.textContent = 'Pasted';
            setTimeout(() => {
              pasteBtn.textContent = 'Paste';
            }, 1200);
            runExtraction(dockUrl.value);
          }
        } else {
          dockUrl.focus();
        }
      } catch {
        dockUrl.focus();
      }
    });
  }

  // Sample Button
  if (sampleBtn) {
    sampleBtn.addEventListener('click', () => {
      dockUrl.value = DEFAULT_SAMPLE_URL;
      runExtraction(DEFAULT_SAMPLE_URL);
    });
  }

  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      dockUrl.value = DEFAULT_SAMPLE_URL;
      runExtraction(DEFAULT_SAMPLE_URL);
    });
  }

  // Copy Clean URL Button
  if (btnCopyLink) {
    btnCopyLink.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        await navigator.clipboard.writeText(currentCleanUrl);
        btnCopyLink.textContent = 'Copied';
        setTimeout(() => {
          btnCopyLink.textContent = 'Copy URL';
        }, 1200);
      } catch {}
    });
  }

  // Core Extraction Runner
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
    inspectorCard.classList.add('transitioning');
    if (statusNotice) statusNotice.textContent = 'Resolving stream on Edge...';

    try {
      const response = await fetch(`/api/extract?url=${encodeURIComponent(url)}`);
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Could not resolve TikTok link. Check that the video is public.');
      }

      currentCleanUrl = data.id ? `https://www.tiktok.com/@${data.author?.unique_id || 'a'}/video/${data.id}` : url;

      // Update Header & IDs
      const isPhoto = Array.isArray(data.images) && data.images.length > 0;
      mediaTypeBadge.textContent = isPhoto ? `Photo Carousel · ${data.images.length} Slides` : 'No Watermark · MP4';
      mediaIdBadge.textContent = data.id ? `#${String(data.id).slice(0, 8)}` : '#Resolved';

      // Update KPIs
      statViews.textContent = formatNumber(data.stats?.views || 0);
      statLikes.textContent = formatNumber(data.stats?.likes || 0);
      statComments.textContent = formatNumber(data.stats?.comments || 0);
      statShares.textContent = formatNumber(data.stats?.shares || 0);

      // Update Creator & Caption
      creatorAvatar.src = data.author?.avatar || 'sample-avatar.jpg';
      creatorName.textContent = cleanLabel(data.author?.nickname, 'TikTok Creator');
      const handleStr = data.author?.unique_id ? `@${data.author.unique_id.replace(/^@/, '')}` : '@tiktok';
      creatorHandle.textContent = handleStr;

      const durSec = Number(data.duration || 0);
      const sizeMb = data.sizeBytes ? ` · ${(data.sizeBytes / 1024 / 1024).toFixed(1)} MB` : '';
      durationTag.textContent = durSec > 0 ? `${durSec}s${sizeMb}` : `HD Stream${sizeMb}`;

      mediaCaption.textContent = cleanLabel(data.title, 'Original TikTok media stream.');
      audioTitle.textContent = cleanLabel(data.music?.title, 'Original Sound');

      // Video Player vs Photo Carousel
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
        mediaVideo.poster = data.cover || 'sample-cover.jpg';
        mediaVideo.load();
        timecodeText.textContent = `0:00 / ${formatTimecode(durSec || 59)}`;
        scrubberFill.style.width = '0%';
      }

      // Update Export Links
      const videoFilename = `tiktok_${data.id || Date.now()}_clean.mp4`;
      const audioFilename = `tiktok_${data.id || Date.now()}_audio.mp3`;

      if (data.downloads?.hd_video || data.downloads?.fast_video) {
        const targetVid = data.downloads.hd_video || data.downloads.fast_video;
        const fallbackVid = data.downloads.fast_video || '';
        btnHdVideo.href = `/api/download?url=${encodeURIComponent(targetVid)}&fallback=${encodeURIComponent(fallbackVid)}&filename=${encodeURIComponent(videoFilename)}`;
        btnHdVideo.style.display = 'flex';
        videoSubLabel.textContent = `MP4 · H.264${sizeMb}`;
      } else {
        btnHdVideo.style.display = 'none';
      }

      if (data.downloads?.audio) {
        btnAudioMp3.href = `/api/download?url=${encodeURIComponent(data.downloads.audio)}&filename=${encodeURIComponent(audioFilename)}`;
        btnAudioMp3.style.display = 'flex';
      } else {
        btnAudioMp3.style.display = 'none';
      }

      if (data.downloads?.fast_video) {
        btnFastServer.href = `/api/download?url=${encodeURIComponent(data.downloads.fast_video)}&filename=${encodeURIComponent(videoFilename)}`;
        btnFastServer.style.display = 'inline';
      }

      if (data.cover) {
        btnCover.href = data.cover;
      }

      saveToHistory({
        id: String(data.id || Date.now()),
        url,
        title: cleanLabel(data.title, 'TikTok Video'),
        handle: handleStr,
        duration: durSec || 15,
        cover: data.cover || 'sample-cover.jpg'
      });

      if (statusNotice) statusNotice.textContent = `Resolved ID ${data.id || 'Ready'}`;
      loadEdgeStats();
    } catch (err) {
      errorText.textContent = err.message || 'Could not resolve TikTok link. Check that the video is public.';
      errorBanner.style.display = 'flex';
      if (statusNotice) statusNotice.textContent = 'Resolution failed';
    } finally {
      btnText.style.display = 'inline';
      btnSpinner.style.display = 'none';
      extractBtn.disabled = false;
      inspectorCard.classList.remove('transitioning');
    }
  }

  extractForm.addEventListener('submit', (e) => {
    e.preventDefault();
    runExtraction(dockUrl.value);
  });
});
