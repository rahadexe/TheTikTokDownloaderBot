document.addEventListener('DOMContentLoaded', () => {
  const extractForm = document.getElementById('extractForm');
  const dockUrl = document.getElementById('dockUrl');
  const pasteBtn = document.getElementById('pasteBtn');
  const extractBtn = document.getElementById('extractBtn');
  const sampleBtn = document.getElementById('sampleBtn');

  const inspectorCard = document.getElementById('inspectorCard');
  const mediaVideo = document.getElementById('mediaVideo');
  const playerTrigger = document.getElementById('playerTrigger');

  const creatorAvatar = document.getElementById('creatorAvatar');
  const creatorName = document.getElementById('creatorName');
  const creatorHandle = document.getElementById('creatorHandle');
  const mediaCaption = document.getElementById('mediaCaption');
  const audioTitle = document.getElementById('audioTitle');

  const btnHdVideo = document.getElementById('btnHdVideo');
  const btnAudioMp3 = document.getElementById('btnAudioMp3');
  const btnCover = document.getElementById('btnCover');
  const btnFastServer = document.getElementById('btnFastServer');

  // Video play/pause
  if (playerTrigger && mediaVideo) {
    const playOverlay = playerTrigger.querySelector('.play-overlay');
    playerTrigger.addEventListener('click', () => {
      if (mediaVideo.paused) {
        mediaVideo.play();
        playOverlay.classList.add('playing');
      } else {
        mediaVideo.pause();
        playOverlay.classList.remove('playing');
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
  }

  // Paste button
  pasteBtn.addEventListener('click', async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text) {
          dockUrl.value = text.trim();
          pasteBtn.textContent = '✓ Done';
          setTimeout(() => {
            pasteBtn.textContent = 'Paste';
          }, 1200);
        }
      } else {
        dockUrl.focus();
      }
    } catch {
      dockUrl.focus();
    }
  });

  // Try sample link
  sampleBtn.addEventListener('click', () => {
    dockUrl.value = 'https://vt.tiktok.com/ZSgQuVgCe/';
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
    btnSpinner.style.display = 'inline';
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
      creatorHandle.textContent = data.author.unique_id ? `@${data.author.unique_id}` : '@tiktok';
      mediaCaption.textContent = data.title || 'Untitled video';
      audioTitle.textContent = data.music.title || 'Original Sound';

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
        btnCover.style.display = 'inline';
      } else {
        btnCover.style.display = 'none';
      }

      // Fast Server Mirror
      if (data.downloads.fast_video) {
        btnFastServer.href = `/api/download?url=${encodeURIComponent(data.downloads.fast_video)}&filename=${encodeURIComponent(videoFilename)}`;
        btnFastServer.style.display = 'inline';
      } else {
        btnFastServer.style.display = 'none';
      }

      // Reveal & Smooth Scroll
      inspectorCard.style.display = 'flex';
      inspectorCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    } catch (err) {
      alert(`⚠️ ${err.message || 'Error occurred while resolving video.'}`);
    } finally {
      btnText.style.display = 'inline';
      btnSpinner.style.display = 'none';
      extractBtn.disabled = false;
    }
  });
});
