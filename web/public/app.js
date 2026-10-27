document.addEventListener('DOMContentLoaded', () => {
  const downloadForm = document.getElementById('downloadForm');
  const tiktokUrl = document.getElementById('tiktokUrl');
  const clearBtn = document.getElementById('clearBtn');
  const pasteBtn = document.getElementById('pasteBtn');
  const submitBtn = document.getElementById('submitBtn');
  const sampleLinkBtn = document.getElementById('sampleLinkBtn');

  const resultContainer = document.getElementById('resultContainer');
  const resultVideo = document.getElementById('resultVideo');
  const authorAvatar = document.getElementById('authorAvatar');
  const authorNickname = document.getElementById('authorNickname');
  const authorHandle = document.getElementById('authorHandle');
  const videoTitle = document.getElementById('videoTitle');
  const musicTitle = document.getElementById('musicTitle');

  const statViews = document.getElementById('statViews');
  const statLikes = document.getElementById('statLikes');
  const statComments = document.getElementById('statComments');
  const statShares = document.getElementById('statShares');

  const btnDownloadHd = document.getElementById('btnDownloadHd');
  const btnDownloadAudio = document.getElementById('btnDownloadAudio');
  const btnDownloadFast = document.getElementById('btnDownloadFast');
  const btnDownloadCover = document.getElementById('btnDownloadCover');

  const videoOverlay = document.getElementById('videoOverlay');
  const playBtn = document.getElementById('playBtn');
  const playIcon = document.getElementById('playIcon');
  const pauseIcon = document.getElementById('pauseIcon');

  function togglePlay() {
    if (resultVideo.paused) {
      resultVideo.play();
      videoOverlay.classList.add('playing');
      playIcon.style.display = 'none';
      pauseIcon.style.display = 'block';
    } else {
      resultVideo.pause();
      videoOverlay.classList.remove('playing');
      playIcon.style.display = 'block';
      pauseIcon.style.display = 'none';
    }
  }

  if (videoOverlay) {
    videoOverlay.addEventListener('click', togglePlay);
  }
  if (resultVideo) {
    resultVideo.addEventListener('play', () => {
      videoOverlay.classList.add('playing');
      playIcon.style.display = 'none';
      pauseIcon.style.display = 'block';
    });
    resultVideo.addEventListener('pause', () => {
      videoOverlay.classList.remove('playing');
      playIcon.style.display = 'block';
      pauseIcon.style.display = 'none';
    });
    resultVideo.addEventListener('ended', () => {
      videoOverlay.classList.remove('playing');
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
  tiktokUrl.addEventListener('input', () => {
    clearBtn.style.display = tiktokUrl.value ? 'inline-flex' : 'none';
  });

  clearBtn.addEventListener('click', () => {
    tiktokUrl.value = '';
    clearBtn.style.display = 'none';
    tiktokUrl.focus();
  });

  // Paste button
  pasteBtn.addEventListener('click', async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text) {
          tiktokUrl.value = text.trim();
          clearBtn.style.display = 'inline-flex';
          pasteBtn.innerHTML = `<span>✓ Pasted</span>`;
          setTimeout(() => {
            pasteBtn.innerHTML = `
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect></svg>
              <span>Paste</span>
            `;
          }, 1500);
        }
      } else {
        tiktokUrl.focus();
      }
    } catch (err) {
      tiktokUrl.focus();
    }
  });

  // Try sample link
  sampleLinkBtn.addEventListener('click', () => {
    tiktokUrl.value = 'https://vt.tiktok.com/ZSgQuVgCe/';
    clearBtn.style.display = 'inline-flex';
    downloadForm.dispatchEvent(new Event('submit'));
  });

  // Handle Form Submission
  downloadForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = tiktokUrl.value.trim();
    if (!url) return;

    // Loading State
    const btnText = submitBtn.querySelector('.btn-text');
    const btnLoader = submitBtn.querySelector('.btn-loader');
    btnText.style.display = 'none';
    btnLoader.style.display = 'inline-flex';
    submitBtn.disabled = true;

    try {
      const response = await fetch(`/api/extract?url=${encodeURIComponent(url)}`);
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to extract TikTok media. Ensure link is public.');
      }

      // Populate Data
      authorAvatar.src = data.author.avatar || 'https://via.placeholder.com/100';
      authorNickname.textContent = data.author.nickname || 'TikTok Creator';
      authorHandle.textContent = data.author.unique_id ? `@${data.author.unique_id}` : '@tiktok_user';
      videoTitle.textContent = data.title || 'TikTok Video';
      musicTitle.textContent = data.music.title || 'Original Audio';

      statViews.textContent = formatNum(data.stats.views);
      statLikes.textContent = formatNum(data.stats.likes);
      statComments.textContent = formatNum(data.stats.comments);
      statShares.textContent = formatNum(data.stats.shares);

      // Setup Video Player
      const playableVideo = data.downloads.hd_video || data.downloads.fast_video;
      resultVideo.src = playableVideo;
      resultVideo.poster = data.cover || '';
      resultVideo.load();

      // Setup Download Links with streaming proxy attachment
      const videoFilename = `tiktok_${data.id || Date.now()}_clean.mp4`;
      const audioFilename = `tiktok_${data.id || Date.now()}_audio.mp3`;

      // 1. HD Video
      if (data.downloads.hd_video) {
        btnDownloadHd.href = `/api/download?url=${encodeURIComponent(data.downloads.hd_video)}&filename=${encodeURIComponent(videoFilename)}`;
        btnDownloadHd.style.display = 'flex';
      } else {
        btnDownloadHd.style.display = 'none';
      }

      // 2. Audio MP3
      if (data.downloads.audio) {
        btnDownloadAudio.href = `/api/download?url=${encodeURIComponent(data.downloads.audio)}&filename=${encodeURIComponent(audioFilename)}`;
        btnDownloadAudio.style.display = 'flex';
      } else {
        btnDownloadAudio.style.display = 'none';
      }

      // 3. Fast Server Video
      if (data.downloads.fast_video) {
        btnDownloadFast.href = `/api/download?url=${encodeURIComponent(data.downloads.fast_video)}&filename=${encodeURIComponent(videoFilename)}`;
        btnDownloadFast.style.display = 'flex';
      } else {
        btnDownloadFast.style.display = 'none';
      }

      // 4. Cover image
      if (data.cover) {
        btnDownloadCover.href = data.cover;
        btnDownloadCover.style.display = 'flex';
      } else {
        btnDownloadCover.style.display = 'none';
      }

      // Reveal & Smooth Scroll
      resultContainer.style.display = 'block';
      resultContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });

    } catch (err) {
      alert(`⚠️ ${err.message || 'Error occurred while resolving video.'}`);
    } finally {
      btnText.style.display = 'inline';
      btnLoader.style.display = 'none';
      submitBtn.disabled = false;
    }
  });
});
