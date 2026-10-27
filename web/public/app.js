document.addEventListener('DOMContentLoaded', () => {
  const extractForm = document.getElementById('extractForm');
  const dockUrl = document.getElementById('dockUrl');
  const clearBtn = document.getElementById('clearBtn');
  const pasteBtn = document.getElementById('pasteBtn');
  const extractBtn = document.getElementById('extractBtn');
  const sampleBtn = document.getElementById('sampleBtn');

  const inspectorCard = document.getElementById('inspectorCard');
  const mediaVideo = document.getElementById('mediaVideo');
  const playerOverlay = document.getElementById('playerOverlay');
  const playBtn = document.getElementById('playBtn');
  const playIcon = document.getElementById('playIcon');
  const pauseIcon = document.getElementById('pauseIcon');

  const creatorAvatar = document.getElementById('creatorAvatar');
  const creatorName = document.getElementById('creatorName');
  const creatorHandle = document.getElementById('creatorHandle');
  const mediaCaption = document.getElementById('mediaCaption');
  const audioTitle = document.getElementById('audioTitle');
  const mediaMetrics = document.getElementById('mediaMetrics');

  const btnHdVideo = document.getElementById('btnHdVideo');
  const btnAudioMp3 = document.getElementById('btnAudioMp3');
  const btnCover = document.getElementById('btnCover');
  const btnFastServer = document.getElementById('btnFastServer');

  // Video play/pause
  function togglePlay() {
    if (mediaVideo.paused) {
      mediaVideo.play();
      playerOverlay.classList.add('playing');
      playIcon.style.display = 'none';
      pauseIcon.style.display = 'block';
    } else {
      mediaVideo.pause();
      playerOverlay.classList.remove('playing');
      playIcon.style.display = 'block';
      pauseIcon.style.display = 'none';
    }
  }

  if (playerOverlay) {
    playerOverlay.addEventListener('click', togglePlay);
  }
  if (mediaVideo) {
    mediaVideo.addEventListener('play', () => {
      playerOverlay.classList.add('playing');
      playIcon.style.display = 'none';
      pauseIcon.style.display = 'block';
    });
    mediaVideo.addEventListener('pause', () => {
      playerOverlay.classList.remove('playing');
      playIcon.style.display = 'block';
      pauseIcon.style.display = 'none';
    });
    mediaVideo.addEventListener('ended', () => {
      playerOverlay.classList.remove('playing');
      playIcon.style.display = 'block';
      pauseIcon.style.display = 'none';
    });
  }

  // Format numbers (e.g. 1500000 -> 1.5M)
  function formatNum(num) {
    if (!num) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    return num.toLocaleString();
  }

  // Toggle clear button
  dockUrl.addEventListener('input', () => {
    clearBtn.style.display = dockUrl.value ? 'inline-flex' : 'none';
  });

  clearBtn.addEventListener('click', () => {
    dockUrl.value = '';
    clearBtn.style.display = 'none';
    dockUrl.focus();
  });

  // Paste button
  pasteBtn.addEventListener('click', async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text) {
          dockUrl.value = text.trim();
          clearBtn.style.display = 'inline-flex';
          pasteBtn.innerHTML = `<span>✓ Pasted</span>`;
          setTimeout(() => {
            pasteBtn.innerHTML = `
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>
              <span>Paste</span>
            `;
          }, 1500);
        }
      } else {
        dockUrl.focus();
      }
    } catch (err) {
      dockUrl.focus();
    }
  });

  // Try sample link
  sampleBtn.addEventListener('click', () => {
    dockUrl.value = 'https://vt.tiktok.com/ZSgQuVgCe/';
    clearBtn.style.display = 'inline-flex';
    extractForm.dispatchEvent(new Event('submit'));
  });

  // Handle Form Submission
  extractForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = dockUrl.value.trim();
    if (!url) return;

    // Loading State
    const btnText = extractBtn.querySelector('.btn-text');
    const btnSpinner = extractBtn.querySelector('.btn-spinner');
    btnText.style.display = 'none';
    btnSpinner.style.display = 'inline-flex';
    extractBtn.disabled = true;

    try {
      const response = await fetch(`/api/extract?url=${encodeURIComponent(url)}`);
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to extract TikTok media. Ensure link is public.');
      }

      // Populate Data
      creatorAvatar.src = data.author.avatar || 'https://via.placeholder.com/100';
      creatorName.textContent = data.author.nickname || 'Creator';
      creatorHandle.textContent = data.author.unique_id ? `@${data.author.unique_id}` : '@tiktok_user';
      mediaCaption.textContent = data.title || 'Untitled video';
      audioTitle.textContent = data.music.title || 'Original Sound';

      const viewsStr = formatNum(data.stats.views);
      const likesStr = formatNum(data.stats.likes);
      mediaMetrics.textContent = `${viewsStr} views · ${likesStr} likes`;

      // Setup Video Player
      const playableVideo = data.downloads.hd_video || data.downloads.fast_video;
      mediaVideo.src = playableVideo;
      mediaVideo.poster = data.cover || '';
      mediaVideo.load();

      // Setup Download Links
      const videoFilename = `tiktok_${data.id || Date.now()}_clean.mp4`;
      const audioFilename = `tiktok_${data.id || Date.now()}_audio.mp3`;

      // HD Video
      if (data.downloads.hd_video || data.downloads.fast_video) {
        const targetVid = data.downloads.hd_video || data.downloads.fast_video;
        btnHdVideo.href = `/api/download?url=${encodeURIComponent(targetVid)}&filename=${encodeURIComponent(videoFilename)}`;
        btnHdVideo.style.display = 'flex';
      } else {
        btnHdVideo.style.display = 'none';
      }

      // Audio MP3
      if (data.downloads.audio) {
        btnAudioMp3.href = `/api/download?url=${encodeURIComponent(data.downloads.audio)}&filename=${encodeURIComponent(audioFilename)}`;
        btnAudioMp3.style.display = 'flex';
      } else {
        btnAudioMp3.style.display = 'none';
      }

      // Cover image
      if (data.cover) {
        btnCover.href = data.cover;
        btnCover.style.display = 'inline-flex';
      } else {
        btnCover.style.display = 'none';
      }

      // Fast Server Mirror
      if (data.downloads.fast_video) {
        btnFastServer.href = `/api/download?url=${encodeURIComponent(data.downloads.fast_video)}&filename=${encodeURIComponent(videoFilename)}`;
        btnFastServer.style.display = 'inline-flex';
      } else {
        btnFastServer.style.display = 'none';
      }

      // Reveal & Smooth Scroll
      inspectorCard.style.display = 'grid';
      inspectorCard.scrollIntoView({ behavior: 'smooth', block: 'center' });

    } catch (err) {
      alert(`⚠️ ${err.message || 'Error occurred while resolving video.'}`);
    } finally {
      btnText.style.display = 'inline';
      btnSpinner.style.display = 'none';
      extractBtn.disabled = false;
    }
  });
});
