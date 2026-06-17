const feed = document.getElementById('feed');

// ── Search bar ────────────────────────────────────────────────────────────────
let searchBarProActive = false;

const searchBarEl = document.createElement('div');
searchBarEl.id = 'search-bar';
searchBarEl.className = 'search-bar search-bar--locked';

const searchIcon = document.createElement('span');
searchIcon.className = 'search-bar__icon';
searchIcon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="22" y2="22"/></svg>`;

const searchInput = document.createElement('input');
searchInput.type = 'text';
searchInput.className = 'search-bar__input';
searchInput.placeholder = 'AI Search…';
searchInput.autocomplete = 'off';
searchInput.disabled = true;

const searchLockedLabel = document.createElement('span');
searchLockedLabel.className = 'search-bar__locked-label';
searchLockedLabel.textContent = 'Locked: Start your free trial for AI search';

searchBarEl.appendChild(searchIcon);
searchBarEl.appendChild(searchInput);
searchBarEl.appendChild(searchLockedLabel);
document.body.appendChild(searchBarEl);

// ── Back button ──────────────────────────────────────────────────────────────
const backBtn = document.createElement('button');
backBtn.id = 'back-btn';
backBtn.setAttribute('aria-label', 'Back to feed');
backBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="15 18 9 12 15 6"/></svg><span>Feed</span>`;
document.body.appendChild(backBtn);

backBtn.addEventListener('click', () => {
  setCategoryFilter(null).catch(() => {});
});

function updateBackBtn() {
  if (activeCategoryFilter) {
    backBtn.classList.add('back-btn--visible');
    backBtn.querySelector('span').textContent = activeCategoryFilter;
  } else {
    backBtn.classList.remove('back-btn--visible');
  }
}
// ─────────────────────────────────────────────────────────────────────────────

async function initSearchBar() {
  try {
    const res = await fetch('/api/recommendation-mode', { credentials: 'same-origin' });
    const data = await res.json();
    // Enable the search bar only when the server reports enhanced mode is enabled
    searchBarProActive = !!(data && data.enhancedEnabled === true);
  } catch (err) {
    searchBarProActive = false;
  }
  applySearchBarProState();
}

function applySearchBarProState() {
  if (searchBarProActive) {
    searchBarEl.classList.remove('search-bar--locked');
    searchBarEl.classList.add('search-bar--active');
    searchInput.disabled = false;
    searchLockedLabel.style.display = 'none';
  } else {
    searchBarEl.classList.add('search-bar--locked');
    searchBarEl.classList.remove('search-bar--active');
    searchInput.disabled = true;
    searchLockedLabel.style.display = '';
  }
}

initSearchBar().catch(() => {});
// ─────────────────────────────────────────────────────────────────────────────


let lastDecision = null;
const INITIAL_PRELOAD_POSTS = 2;
const PREWARM_AHEAD_COUNT = 2;
const PRELOAD_REQUEST_TIMEOUT_MS = 2500;
const MOBILE_BOOTSTRAP_RETRY_DELAYS = [60, 140, 280, 520];
const MOBILE_PRELOAD_TARGET_SECONDS = 2;
const MOBILE_PRELOAD_MAX_SEGMENTS = 3;
const MOBILE_BACKTRACK_CACHE_BYTES = 768 * 1024;
const MODE_MAIN_KEY = '__main__';
let playbackUnlocked = false;
let currentVisibleSection = null;
let activeCategoryFilter = null;
let feedVersion = 0;
let playbackRequestToken = 0;
let lastHostFallbackThumb = '';
let hasAssignedInitialFirstPost = false;
const hlsPrepareInflight = new Map();
const mobileBacktrackCacheInflight = new Set();
const viewedVideoKeys = new Set();
const firstPostByMode = new Map();
const startupOverlay = document.createElement('div');
startupOverlay.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#ddd;background:#000;z-index:2;font-family:system-ui,sans-serif;font-size:14px;letter-spacing:0.2px;';
startupOverlay.textContent = 'Loading videos…';
feed.style.position = 'relative';
feed.appendChild(startupOverlay);
let streamPlaybackConfig = {
  hlsEnabled: true,
  maxResolution: '720',
  fragmentSeconds: 1,
};

function withTimeout(promise, timeoutMs = PRELOAD_REQUEST_TIMEOUT_MS, fallbackValue = null) {
  let timerId = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      timerId = setTimeout(() => resolve(fallbackValue), timeoutMs);
    })
  ]).finally(() => {
    if (timerId) clearTimeout(timerId);
  });
}

function silenceVideo(videoEl) {
  if (!videoEl) return;
  try {
    videoEl.muted = true;
    videoEl.defaultMuted = true;
    if (typeof videoEl.volume === 'number') videoEl.volume = 0;
  } catch (err) {}
}

function sectionCacheKey(section) {
  if (!section || !section.dataset) return '';
  return `${section.dataset.user || ''}/${section.dataset.caption || ''}`;
}

function postCacheKey(post) {
  if (!post) return '';
  return `${post.user || ''}/${post.caption || ''}`;
}

function modeCacheKey(categoryFilter) {
  return categoryFilter ? String(categoryFilter) : MODE_MAIN_KEY;
}

function warmPostSourceForInstantStart(post, categoryFilter = null) {
  if (!isMobileLikeDevice()) return;
  if (!post) return;

  const modeKey = modeCacheKey(categoryFilter);
  firstPostByMode.set(modeKey, post);

  try {
    if (post.thumbnailUrl) {
      const img = new Image();
      img.decoding = 'async';
      img.src = post.thumbnailUrl;
    }
  } catch (err) {}

  if (streamPlaybackConfig.hlsEnabled && post.hlsUrl) {
    const pseudoSection = {
      dataset: {
        hlsUrl: post.hlsUrl,
        user: post.user || '',
        caption: post.caption || '',
      }
    };
    prefetchHlsUpToSeconds(pseudoSection, MOBILE_PRELOAD_TARGET_SECONDS).catch(() => {});
  }

  const rawVideoUrl = String(post.videoUrl || '');
  if (rawVideoUrl) {
    const mobileVideoUrl = `${rawVideoUrl}${rawVideoUrl.includes('?') ? '&' : '?'}mobile=1`;
    withTimeout(fetch(mobileVideoUrl, {
      credentials: 'same-origin',
      headers: { Range: `bytes=0-${MOBILE_BACKTRACK_CACHE_BYTES - 1}` }
    }), PRELOAD_REQUEST_TIMEOUT_MS, null).catch(() => null);
  }
}

function cacheCurrentForBackNavigation(section) {
  if (!isMobileLikeDevice()) return;
  if (!section || !section.dataset) return;

  const key = sectionCacheKey(section);
  if (!key) return;
  if (mobileBacktrackCacheInflight.has(key)) return;
  mobileBacktrackCacheInflight.add(key);

  const finish = () => {
    setTimeout(() => mobileBacktrackCacheInflight.delete(key), 2000);
  };

  if (streamPlaybackConfig.hlsEnabled && canUseHlsForSection(section)) {
    prefetchHlsUpToSeconds(section, MOBILE_PRELOAD_TARGET_SECONDS)
      .catch(() => {})
      .finally(finish);
    return;
  }

  const src = section.dataset.videoUrl;
  if (!src) {
    finish();
    return;
  }

  withTimeout(fetch(src, {
    credentials: 'same-origin',
    headers: { Range: `bytes=0-${MOBILE_BACKTRACK_CACHE_BYTES - 1}` }
  }), PRELOAD_REQUEST_TIMEOUT_MS, null)
    .catch(() => null)
    .finally(finish);
}

async function refreshStreamPlaybackConfig() {
  try {
    const res = await fetch('/api/stream-settings', { credentials: 'same-origin' });
    if (!res.ok) return;
    const payload = await res.json();
    if (!payload || !payload.ok) return;
    const settings = payload.settings || {};
    streamPlaybackConfig = {
      hlsEnabled: payload.hlsEnabled !== false,
      maxResolution: settings.maxResolution || '720',
      fragmentSeconds: Number(settings.fragmentSeconds || 1),
    };
  } catch (err) {}
}

function canUseHlsForSection(section) {
  if (!section || !section.dataset) return false;
  if (!section.dataset.hlsUrl) return false;
  if (section.dataset.initial === '1') return false; // first video stays MP4 for fastest first paint
  if (!streamPlaybackConfig.hlsEnabled) return false;
  if (isLocalDesktopHostPlayback()) return false;
  const videoEl = section.querySelector('video');
  const canNativeHls = Boolean(videoEl && typeof videoEl.canPlayType === 'function' && videoEl.canPlayType('application/vnd.apple.mpegurl'));
  if (canNativeHls) {
    return true;
  }
  return typeof window.Hls !== 'undefined' && window.Hls && window.Hls.isSupported && window.Hls.isSupported();
}
let enhancedAlgorithmActive = false;

async function refreshRecommendationMode() {
  try {
    const res = await fetch('/api/recommendation-mode');
    if (!res.ok) return;
    const data = await res.json();
    enhancedAlgorithmActive = !!(data && data.enhancedEnabled);
    document.body.classList.toggle('enhanced-mode', enhancedAlgorithmActive);
  } catch (err) {
    enhancedAlgorithmActive = false;
    document.body.classList.remove('enhanced-mode');
  }
}

function isMobileLikeDevice() {
  try {
    return window.matchMedia('(pointer: coarse), (max-width: 900px)').matches;
  } catch (err) {
    return false;
  }
}

function isLocalDesktopHostPlayback() {
  try {
    const host = String(window.location.hostname || '').toLowerCase();
    const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    return isLocalHost && !isMobileLikeDevice();
  } catch (err) {
    return false;
  }
}

function getVideoForSection(section) {
  if (!section) return null;
  return section.querySelector('video');
}

function pauseAllVideosExcept(exceptVideo) {
  document.querySelectorAll('.post video').forEach((videoEl) => {
    if (exceptVideo && videoEl === exceptVideo) {
      return;
    }
    try {
      videoEl.muted = true;
      videoEl.pause();
      const parentSection = videoEl.closest('.post');
      if (parentSection) {
        if (parentSection._thumbHideTimer) {
          clearTimeout(parentSection._thumbHideTimer);
          parentSection._thumbHideTimer = null;
        }
        const thumb = ensureSectionThumbnail(parentSection);
        if (thumb) thumb.style.opacity = '1';
      }
    } catch (err) {}
  });
}

function stopSectionPlayback(section) {
  if (!section) return;
  const videoEl = getVideoForSection(section);
  if (!videoEl) return;
  try {
    videoEl.muted = true;
    videoEl.pause();
    if (section._thumbHideTimer) {
      clearTimeout(section._thumbHideTimer);
      section._thumbHideTimer = null;
    }
    const thumb = ensureSectionThumbnail(section);
    if (thumb) thumb.style.opacity = '1';
  } catch (err) {}
}

function isSectionNearViewport(section) {
  if (!section) return false;
  const rootRect = feed.getBoundingClientRect();
  const rect = section.getBoundingClientRect();
  const margin = Math.max(rootRect.height * 1.25, 320);
  return rect.bottom >= (rootRect.top - margin) && rect.top <= (rootRect.bottom + margin);
}

function chooseMostVisibleSection() {
  const posts = Array.from(feed.querySelectorAll('.post'));
  if (!posts.length) return null;
  const rootRect = feed.getBoundingClientRect();
  let best = null;
  let bestRatio = 0;

  for (const post of posts) {
    const rect = post.getBoundingClientRect();
    const overlap = Math.max(0, Math.min(rect.bottom, rootRect.bottom) - Math.max(rect.top, rootRect.top));
    const ratio = overlap / Math.max(1, rect.height);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = post;
    }
  }

  return best;
}

function pickSectionByScrollPosition() {
  const posts = Array.from(feed.querySelectorAll('.post'));
  if (!posts.length) return null;
  const vh = feed.clientHeight || window.innerHeight || 1;
  const idx = Math.max(0, Math.min(posts.length - 1, Math.round((feed.scrollTop || 0) / vh)));
  return posts[idx] || null;
}

async function playVisibleSection(section) {
  if (!section || !section.isConnected) {
    return;
  }
  const mobileDevice = isMobileLikeDevice();
  const hostDesktop = isLocalDesktopHostPlayback();
  const myToken = ++playbackRequestToken;
  attachVideoToSection(section, { prefetch: false });
  const visibleVideo = getVideoForSection(section);
  if (!visibleVideo) {
    return;
  }

  if (hostDesktop) {
    const now = Date.now();
    const recentCall = now - Number(section._lastHostPlayVisibleAt || 0) < 280;
    const alreadyRunning = !visibleVideo.paused && visibleVideo.readyState >= 2 && (visibleVideo.currentTime || 0) > 0.04;
    section._lastHostPlayVisibleAt = now;
    if (recentCall && alreadyRunning) {
      return;
    }
  }

  const thumb = ensureSectionThumbnail(section);
  if (section._thumbHideTimer) {
    clearTimeout(section._thumbHideTimer);
    section._thumbHideTimer = null;
  }
  if (thumb) thumb.style.opacity = '1';

  // Determine if we can take over an already-decoding video instantly.
  // Host: if it is already playing and has enough data, never issue another startup play().
  const canInstantTakeover = !visibleVideo.paused
    && visibleVideo.readyState >= 2
    && (hostDesktop ? true : (visibleVideo.currentTime || 0) > (mobileDevice ? 0.01 : 0.06));

  pauseAllVideosExcept(visibleVideo);
  if (!canInstantTakeover) {
    // Only silence/mute when we are about to call play() fresh — never mute a video that is already playing.
    if (mobileDevice) {
      silenceVideo(visibleVideo);
    } else {
      visibleVideo.muted = false;
    }
  } else if (!mobileDevice) {
    try {
      visibleVideo.defaultMuted = false;
      visibleVideo.muted = false;
      if (typeof visibleVideo.volume === 'number') visibleVideo.volume = 1;
    } catch (err) {}
  }
  visibleVideo.preload = 'auto'; // upgrade buffering for the active video
  let usedMutedFallback = false;
  let played = canInstantTakeover ? true : await playWithRetry(visibleVideo, mobileDevice ? 2 : 3);

  if (!played && isLocalDesktopHostPlayback() && section && section.dataset && section.dataset.videoUrl && section.dataset.hostFallbackTried !== '1') {
    try {
      section.dataset.hostFallbackTried = '1';
      const baseSrc = section.dataset.videoUrl;
      const fallbackSrc = `${baseSrc}${baseSrc.includes('?') ? '&' : '?'}mobile=1`;
      visibleVideo.src = fallbackSrc;
      visibleVideo.load();
      played = await playWithRetry(visibleVideo, 2);
    } catch (err) {}
  }

  if (!played) {
    try {
      visibleVideo.muted = true;
      usedMutedFallback = true;
    } catch (err) {}
    played = await playWithRetry(visibleVideo, 2);
  }

  if (played && playbackUnlocked && usedMutedFallback && !mobileDevice) {
    try { visibleVideo.muted = false; } catch (err) {}
    const unmutedPlayed = await playWithRetry(visibleVideo, 1);
    if (!unmutedPlayed) {
      try { visibleVideo.muted = true; } catch (err) {}
    }
  }

  if (myToken !== playbackRequestToken || !section.isConnected) {
    try {
      visibleVideo.muted = true;
      visibleVideo.pause();
    } catch (err) {}
    return;
  }

  if (played) {
    section._intentionalPause = false;
    const key = sectionCacheKey(section);
    if (key) viewedVideoKeys.add(key);
  }

  document.querySelectorAll('.post').forEach((post) => {
    if (post !== section) {
      stopSectionPlayback(post);
    }
  });
  warmNextVideoFrom(section);
  cacheCurrentForBackNavigation(section);
  enforceActiveVideoAudio(section, mobileDevice ? 35 : (hostDesktop ? 320 : 120));
  enforceActiveVideoAudio(section, mobileDevice ? 140 : (hostDesktop ? 780 : 520));
  scheduleActivePlaybackHealthCheck(section, 900);
  scheduleActivePlaybackHealthCheck(section, 1800);
}

function enforceActiveVideoAudio(section, delayMs = 180) {
  setTimeout(() => {
    if (!playbackUnlocked) return;
    if (!section || currentVisibleSection !== section) return;
    const activeVideo = getVideoForSection(section);
    if (!activeVideo) return;

    pauseAllVideosExcept(activeVideo);

    try {
      activeVideo.defaultMuted = false;
      activeVideo.muted = false;
      if (typeof activeVideo.volume === 'number') {
        activeVideo.volume = 1;
      }
    } catch (err) {}

    // Only call play() if the video is actually stuck paused.
    // Calling play() on an already-playing video causes a decoder restart stutter.
    if (activeVideo.paused && !section._intentionalPause) {
      playWithRetry(activeVideo, 1).catch(() => {});
    }
  }, delayMs);
}

function warmNextVideoFrom(section) {
  if (!section) return;
  const mobileDevice = isMobileLikeDevice();
  const prewarmCount = mobileDevice ? 1 : PREWARM_AHEAD_COUNT;

  const toWarm = [];
  const addWarmCandidate = (candidate) => {
    if (!candidate) return;
    if (!(candidate.classList && candidate.classList.contains('post'))) return;
    if (candidate === section) return;
    if (toWarm.includes(candidate)) return;
    if (mobileDevice) {
      const key = sectionCacheKey(candidate);
      if (key && viewedVideoKeys.has(key)) {
        return;
      }
    }
    toWarm.push(candidate);
  };

  let nextCursor = section.nextElementSibling;
  let nextCount = 0;
  while (nextCursor && nextCount < prewarmCount) {
    if (nextCursor.classList && nextCursor.classList.contains('post')) {
      addWarmCandidate(nextCursor);
      nextCount += 1;
    }
    nextCursor = nextCursor.nextElementSibling;
  }

  let prevCursor = section.previousElementSibling;
  let prevCount = 0;
  while (!mobileDevice && prevCursor && prevCount < prewarmCount) {
    if (prevCursor.classList && prevCursor.classList.contains('post')) {
      addWarmCandidate(prevCursor);
      prevCount += 1;
    }
    prevCursor = prevCursor.previousElementSibling;
  }

  if (!toWarm.length) return;

  const releaseSectionVideoWithoutTracking = (candidate) => {
    if (!candidate) return;
    if (candidate._thumbHideTimer) {
      clearTimeout(candidate._thumbHideTimer);
      candidate._thumbHideTimer = null;
    }
    if (candidate._hls) {
      try { candidate._hls.destroy(); } catch (e) {}
      candidate._hls = null;
    }
    const thumb = ensureSectionThumbnail(candidate);
    if (thumb) thumb.style.opacity = '1';
    const videoEl = getVideoForSection(candidate);
    if (videoEl) {
      try {
        videoEl.pause();
        videoEl.muted = true;
        videoEl.defaultMuted = true;
        if (typeof videoEl.volume === 'number') videoEl.volume = 0;
        videoEl.src = '';
        videoEl.load();
        videoEl.remove();
      } catch (e) {}
    }
    candidate._hasVideo = false;
    candidate._prefetchedVideo = false;
  };

  if (mobileDevice) {
    const keep = new Set([section, ...toWarm]);
    const prev = section.previousElementSibling;
    if (prev && prev.classList && prev.classList.contains('post')) {
      const prevKey = sectionCacheKey(prev);
      if (prevKey && viewedVideoKeys.has(prevKey)) {
        keep.add(prev);
      }
    }
    document.querySelectorAll('.post').forEach((candidate) => {
      if (keep.has(candidate)) return;
      if (candidate === currentVisibleSection) return;
      releaseSectionVideoWithoutTracking(candidate);
    });
  }

  if (streamPlaybackConfig.hlsEnabled) {
    const keys = toWarm
      .map((candidate) => `${candidate.dataset.user || ''}/${candidate.dataset.caption || ''}`)
      .filter((candidate) => candidate && candidate !== '/');

    if (keys.length) {
      withTimeout(fetch('/api/hls/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys, waitMs: 900 })
      }), PRELOAD_REQUEST_TIMEOUT_MS, null)
        .then((res) => res ? res.json() : null)
        .then((payload) => {
          if (!payload || !Array.isArray(payload.results)) return;
          const readyByKey = new Map(payload.results.map((entry) => [entry.key, !!entry.ready]));
          for (const candidate of toWarm) {
            const key = `${candidate.dataset.user || ''}/${candidate.dataset.caption || ''}`;
            if (!key) continue;
            const ready = readyByKey.get(key);
            if (ready === false) {
              candidate.dataset.hlsReady = '0';
            } else if (ready === true) {
              candidate.dataset.hlsReady = '1';
            }
          }
        })
        .catch(() => {});
    }
  }

  for (let i = 0; i < toWarm.length; i += 1) {
    const next = toWarm[i];
    warmThumbnail(next);
    if (mobileDevice) {
      attachVideoToSection(next, { prefetch: true });
      const nextVideo = getVideoForSection(next);

      if (streamPlaybackConfig.hlsEnabled && canUseHlsForSection(next)) {
        prefetchHlsUpToSeconds(next, MOBILE_PRELOAD_TARGET_SECONDS).catch(() => {});
      }

      if (!nextVideo) continue;
      nextVideo.preload = 'auto';
      try {
        silenceVideo(nextVideo);
        nextVideo.pause();
        nextVideo.load();
      } catch (err) {}
      continue;
    }

    attachVideoToSection(next, { prefetch: true });
    const nextVideo = getVideoForSection(next);
    if (!nextVideo) continue;

    if (streamPlaybackConfig.hlsEnabled && canUseHlsForSection(next)) {
      prefetchHlsUpToSeconds(next, MOBILE_PRELOAD_TARGET_SECONDS).catch(() => {});
    }

    nextVideo.preload = 'auto';
    try {
      silenceVideo(nextVideo);
      nextVideo.pause();
      nextVideo.load();
    } catch (err) {}
  }
}

async function prefetchHlsUpToSeconds(section, seconds = MOBILE_PRELOAD_TARGET_SECONDS) {
  if (!section || !section.dataset) return;
  const hlsUrl = section.dataset.hlsUrl;
  if (!hlsUrl) return;

  const key = `${section.dataset.user || ''}/${section.dataset.caption || ''}::${hlsUrl}`;
  if (hlsPrepareInflight.has(key)) {
    return hlsPrepareInflight.get(key);
  }

  const task = (async () => {
    const playlistRes = await withTimeout(fetch(hlsUrl, { credentials: 'same-origin' }), PRELOAD_REQUEST_TIMEOUT_MS, null);
    if (!playlistRes) {
      section.dataset.hlsReady = '0';
      return;
    }
    if (!playlistRes.ok) {
      section.dataset.hlsReady = '0';
      return;
    }
    const playlistText = await playlistRes.text();
    const lines = String(playlistText || '').split(/\r?\n/).map((line) => line.trim());
    const segmentTargets = [];
    let secondsAccumulated = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line) continue;
      if (line.startsWith('#EXTINF:')) {
        const durationRaw = line.replace('#EXTINF:', '').split(',')[0];
        const duration = Number.parseFloat(durationRaw);
        const nextLine = lines[i + 1];
        if (nextLine && !nextLine.startsWith('#')) {
          segmentTargets.push({ path: nextLine, duration: Number.isFinite(duration) ? duration : 1 });
          i += 1;
        }
      }
    }

    if (!segmentTargets.length) {
      section.dataset.hlsReady = '0';
      return;
    }

    for (let i = 0; i < segmentTargets.length; i += 1) {
      if (secondsAccumulated >= seconds) break;
      if (i >= MOBILE_PRELOAD_MAX_SEGMENTS) break;
      const seg = segmentTargets[i];
      const segUrl = new URL(seg.path, window.location.origin + hlsUrl).toString();
      await withTimeout(fetch(segUrl, { credentials: 'same-origin' }), PRELOAD_REQUEST_TIMEOUT_MS, null);
      secondsAccumulated += Math.max(0.2, Number(seg.duration || 1));
    }

    section.dataset.hlsReady = '1';
  })().catch(() => {
    section.dataset.hlsReady = '0';
  }).finally(() => {
    hlsPrepareInflight.delete(key);
  });

  hlsPrepareInflight.set(key, task);
  return task;
}

function ensureSectionThumbnail(section) {
  if (!section) return null;

  let thumbImg = section.querySelector(':scope > .thumb') || null;
  if (!thumbImg && section._earlyThumb && section._earlyThumb.isConnected) {
    thumbImg = section._earlyThumb;
  }

  if (!thumbImg) {
    thumbImg = document.createElement('img');
    thumbImg.className = 'thumb';
    thumbImg.decoding = 'async';
    thumbImg.onerror = () => { thumbImg.style.background = '#111'; };

    if (section.dataset.thumb) {
      thumbImg.src = section.dataset.thumb;
    }

    section.insertBefore(thumbImg, section.firstChild);
  } else if (!thumbImg.isConnected) {
    section.insertBefore(thumbImg, section.firstChild);
  }

  thumbImg.style.opacity = '1';
  thumbImg.style.transition = isLocalDesktopHostPlayback() ? 'none' : '';
  section._earlyThumb = thumbImg;

  if (!thumbImg.getAttribute('src') && section.dataset.thumb) {
    thumbImg.src = section.dataset.thumb;
  }

  if (!thumbImg.getAttribute('src') && isLocalDesktopHostPlayback() && lastHostFallbackThumb) {
    thumbImg.src = lastHostFallbackThumb;
  }

  if (thumbImg.getAttribute('src') && isLocalDesktopHostPlayback()) {
    lastHostFallbackThumb = thumbImg.getAttribute('src') || lastHostFallbackThumb;
  }

  return thumbImg;
}

function revealThumbnailsAround(section, radius = 1) {
  if (!section) return;
  const markVisible = (candidate) => {
    if (!candidate) return;
    const thumb = ensureSectionThumbnail(candidate);
    if (thumb) thumb.style.opacity = '1';
  };

  markVisible(section);
  let next = section;
  for (let i = 0; i < radius; i++) {
    next = next && next.nextElementSibling;
    if (next && next.classList && next.classList.contains('post')) {
      markVisible(next);
    }
  }

  let prev = section;
  for (let i = 0; i < radius; i++) {
    prev = prev && prev.previousElementSibling;
    if (prev && prev.classList && prev.classList.contains('post')) {
      markVisible(prev);
    }
  }
}

function warmThumbnail(section){
  if(!section || section._thumbWarmStarted) return;
  section._thumbWarmStarted = true;

  const src = section.dataset.videoUrl;
  const hlsSrc = section.dataset.hlsUrl;
  const thumb = section.dataset.thumb;

  if(thumb){
    const img = new Image();
    img.decoding = 'async';
    img.src = thumb;
    img.onerror = () => {
      getVideoThumbnail(src, 640)
        .then((data) => {
          section.dataset.thumb = data;
          const thumbEl = ensureSectionThumbnail(section);
          if (thumbEl && !thumbEl.getAttribute('src')) {
            thumbEl.src = data;
          }
          if (isLocalDesktopHostPlayback()) {
            lastHostFallbackThumb = data;
          }
        })
        .catch(() => {});
    };
    if (isLocalDesktopHostPlayback()) {
      lastHostFallbackThumb = thumb;
    }
    return;
  }

  getVideoThumbnail(src, 640)
    .then((data) => {
      section.dataset.thumb = data;
      const thumbEl = ensureSectionThumbnail(section);
      if (thumbEl && !thumbEl.getAttribute('src')) {
        thumbEl.src = data;
      }
      if (isLocalDesktopHostPlayback()) {
        lastHostFallbackThumb = data;
      }
    })
    .catch(() => {});
}

function hardStopAllPlayback() {
  playbackRequestToken += 1;
  const videos = Array.from(document.querySelectorAll('video'));
  for (const videoEl of videos) {
    try {
      videoEl.pause();
      silenceVideo(videoEl);
    } catch (err) {}
  }
}

function clearFeedPosts() {
  hardStopAllPlayback();
  mobileEarlyPrimeSection = null;
  lastPrimedSection = null;
  const posts = Array.from(feed.querySelectorAll('.post'));
  posts.forEach((post) => {
    try { viewObserver.unobserve(post); } catch (err) {}
    try { detachVideoFromSection(post); } catch (err) {}
    try { post.remove(); } catch (err) {}
  });
  currentVisibleSection = null;
  updateTapToUnpauseVisibility();
}

async function reloadFeedForCurrentMode() {
  return reloadFeedForCurrentModeWithPrefetch(null);
}

async function fetchFirstPostForMode(categoryFilter) {
  const payload = {};
  if (categoryFilter) {
    payload.categoryFilter = categoryFilter;
  }

  try {
    const res = await fetch('/api/next', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    return data && data.post ? data.post : null;
  } catch (err) {
    return null;
  }
}

function appendPostToFeed(post) {
  if (!post) return null;
  firstPostByMode.set(modeCacheKey(activeCategoryFilter), post);
  const ph = createPlaceholder(post);
  if (!feed.querySelector('.post')) {
    // Keep the MP4-first optimization only for the very first app load in main feed.
    // Category entry should not force MP4-first, otherwise mobile can stall waiting
    // for variant readiness and fail autoplay.
    if (!hasAssignedInitialFirstPost && !activeCategoryFilter) {
      ph.dataset.initial = '1';
      hasAssignedInitialFirstPost = true;
    }
  }
  feed.insertBefore(ph, sentinel);
  viewObserver.observe(ph);
  warmThumbnail(ph);
  if (startupOverlay && startupOverlay.isConnected) {
    startupOverlay.remove();
  }
  return ph;
}

function ensureMobileCategoryAutoplay() {
  if (!isMobileLikeDevice()) return;
  if (!playbackUnlocked) return;
  const modeSnapshot = modeCacheKey(activeCategoryFilter);

  const target = feed.querySelector('.post') || chooseMostVisibleSection() || pickSectionByScrollPosition();
  if (!target || !target.isConnected) return;

  currentVisibleSection = target;
  attachVideoToSection(target, { prefetch: false });

  const startAttempt = (tries = 2) => {
    const v = getVideoForSection(target);
    if (!v) return;

    // In category mode we aggressively prefer HLS when available for faster consistency.
    if (activeCategoryFilter && streamPlaybackConfig.hlsEnabled && canUseHlsForSection(target)) {
      target.dataset.hlsReady = '1';
      forceSectionToHls(target, v, target.dataset.videoUrl || v.currentSrc || v.src || '');
      if (target._hls && typeof target._hls.startLoad === 'function') {
        try { target._hls.startLoad(-1); } catch (err) {}
      }
    }

    playWithRetry(v, tries).catch(() => {});
  };

  startAttempt(2);

  const retryDelays = [220, 520, 900, 1400];
  for (const delay of retryDelays) {
    setTimeout(() => {
      if (modeSnapshot !== modeCacheKey(activeCategoryFilter)) return;
      if (!target.isConnected) return;
      if (currentVisibleSection !== target) return;

      attachVideoToSection(target, { prefetch: false });
      const v = getVideoForSection(target);
      if (!v) return;
      const started = !v.paused && v.readyState >= 2 && (v.currentTime || 0) > 0.03;
      if (started) return;

      startAttempt(3);
    }, delay);
  }
}

async function reloadFeedForCurrentModeWithPrefetch(prefetchedFirstPost) {
  feedVersion += 1;
  playbackRequestToken += 1;
  loading = false;
  lastDecision = null;
  clearFeedPosts();
  feed.scrollTop = 0;

  if (prefetchedFirstPost) {
    appendPostToFeed(prefetchedFirstPost);
    const backgroundWarm = isMobileLikeDevice() ? 1 : 2;
    for (let i = 0; i < backgroundWarm; i++) {
      loadNext().catch(() => {});
    }
  } else {
    await primeInitialFeed();
  }

  // Only one direct bootstrap call here — the inner mobile retry loop inside
  // ensureActivePlaybackBootstrap covers the later delay slots [60,140,280,520]ms.
  // Extra outer calls were incrementing playbackRequestToken and cancelling
  // in-progress playVisibleSection awaits (token collision bug).
  ensureActivePlaybackBootstrap();

  // Mobile category mode: aggressively ensure first visible post autoplays.
  // This catches transition windows where source readiness races the mode swap.
  if (isMobileLikeDevice() && playbackUnlocked) {
    ensureMobileCategoryAutoplay();
  }
}

async function setCategoryFilter(nextCategory) {
  const normalized = nextCategory ? String(nextCategory) : null;
  if (activeCategoryFilter === normalized) return;

  const nextModeKey = modeCacheKey(normalized);
  const cachedFirstPost = firstPostByMode.get(nextModeKey) || null;
  if (cachedFirstPost) {
    warmPostSourceForInstantStart(cachedFirstPost, normalized);
  }

  const prefetchedFirstPost = await fetchFirstPostForMode(normalized);
  if (prefetchedFirstPost) {
    warmPostSourceForInstantStart(prefetchedFirstPost, normalized);
  }

  activeCategoryFilter = normalized;
  updateBackBtn();
  await reloadFeedForCurrentModeWithPrefetch(prefetchedFirstPost || cachedFirstPost);
  ensureMobileCategoryAutoplay();
}

function makeMeta(p){
  const meta = document.createElement('div');
  meta.className = 'meta';
  const userLabel = p.user;
  const userTitle = activeCategoryFilter ? `Show only ${p.user}` : `Show only ${p.user}`;
  meta.innerHTML = `<div class="user" title="${userTitle}">${userLabel}</div><div class="caption">${p.caption}</div><div class="music">♪ ${p.song || ''}</div>`;
  return meta;
}

function getDownloadFilenameForSection(section, absoluteUrl) {
  const fallbackName = 'video.mp4';
  if (!section) return fallbackName;

  const rawName = String(section.dataset.caption || 'video').trim();
  const safeBase = (rawName || 'video').replace(/[\\/:*?"<>|]+/g, '_');

  try {
    const pathname = new URL(absoluteUrl, window.location.href).pathname;
    const extMatch = pathname.match(/\.([a-z0-9]+)$/i);
    const ext = extMatch ? `.${extMatch[1].toLowerCase()}` : '.mp4';
    if (safeBase.toLowerCase().endsWith(ext)) {
      return safeBase;
    }
    return `${safeBase}${ext}`;
  } catch (err) {
    return fallbackName;
  }
}

async function downloadVideoForSection(section) {
  if (!section || !section.dataset.videoUrl) return;

  const absoluteUrl = new URL(section.dataset.videoUrl, window.location.href).toString();
  const filename = getDownloadFilenameForSection(section, absoluteUrl);

  try {
    const res = await fetch(absoluteUrl, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`download failed: ${res.status}`);

    const blob = await res.blob();

    // On mobile, try native share sheet first so users can save to camera roll/photos.
    if (isMobileLikeDevice() && navigator.share && navigator.canShare && typeof File !== 'undefined') {
      const file = new File([blob], filename, { type: blob.type || 'video/mp4' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    }

    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
  } catch (err) {
    // Fallback to direct attachment response from server.
    const fallback = document.createElement('a');
    fallback.href = absoluteUrl + (absoluteUrl.includes('?') ? '&' : '?') + 'download=1';
    fallback.download = filename;
    fallback.rel = 'noopener';
    document.body.appendChild(fallback);
    fallback.click();
    fallback.remove();
  }
}

function createTapToUnpauseButton() {
  const btn = document.createElement('button');
  btn.className = 'tap-unpause-btn';
  btn.type = 'button';
  btn.innerHTML = '<span class="tap-unpause-icon">▶</span><span>Tap to Unpause</span>';

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();

    playbackUnlocked = true;
    btn.classList.remove('visible');

    try {
      if (!window.__globalAudioCtx && (window.AudioContext || window.webkitAudioContext)) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        window.__globalAudioCtx = new AudioCtx();
      }
      if (window.__globalAudioCtx && window.__globalAudioCtx.state !== 'running') {
        window.__globalAudioCtx.resume().catch(() => {});
      }
    } catch (err) {}

    if (!currentVisibleSection) {
      currentVisibleSection = feed.querySelector('.post') || null;
    }
    updateTapToUnpauseVisibility();
    playVisibleSection(currentVisibleSection).catch(() => {});
  });

  document.body.appendChild(btn);
  return btn;
}

const tapUnpauseBtn = createTapToUnpauseButton();

document.addEventListener('click', (e) => {
  if (playbackUnlocked) return;
  if (tapUnpauseBtn && tapUnpauseBtn.contains(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
}, true);

function updateTapToUnpauseVisibility() {
  if (!tapUnpauseBtn) return;
  if (!playbackUnlocked && currentVisibleSection) {
    tapUnpauseBtn.classList.add('visible');
    return;
  }
  tapUnpauseBtn.classList.remove('visible');
}

// generate a thumbnail dataURL for a video source by drawing a frame to canvas
async function getVideoThumbnail(src, width = 480){
  return new Promise((resolve, reject) => {
    try{
      const v = document.createElement('video');
      v.crossOrigin = 'anonymous';
      v.preload = 'metadata';
      v.muted = true;
      v.src = src;

      const cleanup = () => { try{ v.src = ''; v.remove(); }catch(e){} };

      const onError = ()=>{ cleanup(); reject(new Error('thumbnail load error')); };
      v.addEventListener('error', onError, { once: true });

      v.addEventListener('loadeddata', async () => {
        // try to seek a little into the video to avoid black frames at 0
        const seekTo = Math.min(0.1, (v.duration || 0) * 0.1 || 0.1);
        const doSeek = () => {
          const canvas = document.createElement('canvas');
          const ratio = v.videoWidth ? (v.videoHeight ? v.videoWidth / v.videoHeight : 16/9) : 16/9;
          canvas.width = width;
          canvas.height = Math.round(width / ratio);
          try{
            const ctx = canvas.getContext('2d');
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            const data = canvas.toDataURL('image/jpeg', 0.7);
            cleanup();
            resolve(data);
          }catch(e){
            cleanup();
            reject(e);
          }
        };

        // some browsers require waiting for seek to complete
        try{
          v.currentTime = seekTo;
          v.addEventListener('seeked', doSeek, { once: true });
          // fallback if seeked doesn't fire quickly
          setTimeout(() => { if(!v.paused) doSeek(); }, 800);
        }catch(e){ doSeek(); }
      }, { once: true });
    }catch(err){ reject(err); }
  });
}

function createPlaceholder(p){
  const section = document.createElement('section');
  section.className = 'post';
  const shouldUseMobileVariant = isMobileLikeDevice() || Boolean(p && p.forceMobileVariant);
  const mobileVideoUrl = shouldUseMobileVariant
    ? `${p.videoUrl}${p.videoUrl.includes('?') ? '&' : '?'}mobile=1`
    : p.videoUrl;
  section.dataset.videoUrl = mobileVideoUrl;
  section.dataset.forceMobileVariant = shouldUseMobileVariant ? '1' : '0';
  section.dataset.hlsUrl = p.hlsUrl || '';
  if(p.thumbnailUrl) section.dataset.thumb = p.thumbnailUrl;
  section.dataset.user = p.user;
  section.dataset.caption = p.caption;
  section.dataset.song = p.song || '';

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.appendChild(makeMeta(p));

  const actions = document.createElement('div');
  actions.className = 'actions';
  const likeWrap = document.createElement('div');
  likeWrap.style.textAlign = 'center';
  const likeBtn = document.createElement('button');
  likeBtn.className = 'action like-btn';
  likeBtn.textContent = '♥';
  const likeCount = document.createElement('div');
  likeCount.className = 'like-count';
  likeCount.textContent = '0';
  likeWrap.appendChild(likeBtn);
  likeWrap.appendChild(likeCount);

  const profileBtn = document.createElement('button');
  profileBtn.className = 'action profile-btn';
  profileBtn.title = 'Browse this user';
  profileBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.58-7 8-7s8 3 8 7"/></svg>`;

  const commentBtn = document.createElement('button');
  commentBtn.className = 'action';
  commentBtn.textContent = '💬';
  commentBtn.title = 'Show file data';
  const shareBtn = document.createElement('button');
  shareBtn.className = 'action';
  shareBtn.textContent = '⤴';
  shareBtn.title = 'Download video';

  actions.appendChild(profileBtn);
  actions.appendChild(likeWrap);
  actions.appendChild(commentBtn);
  actions.appendChild(shareBtn);

  overlay.appendChild(actions);

  const commentsPanel = document.createElement('div');
  commentsPanel.className = 'comments-panel';
  const commentsHeader = document.createElement('div');
  commentsHeader.className = 'comments-header';
  commentsHeader.textContent = 'File Data';
  const commentsList = document.createElement('div');
  commentsList.className = 'comments-list';
  commentsPanel.appendChild(commentsHeader);
  commentsPanel.appendChild(commentsList);
  overlay.appendChild(commentsPanel);

  const userLabelEl = overlay.querySelector('.meta .user');
  if (userLabelEl) {
    userLabelEl.style.cursor = 'pointer';
    userLabelEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const next = activeCategoryFilter ? null : p.user;
      setCategoryFilter(next).catch(() => {});
    });
  }

  section.appendChild(overlay);

  // basic interactions
  let liked = false;
  let commentsOpen = false;
  let metadataLoaded = false;
  let singleTapTimer = null;

  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const renderComments = (detailsObj) => {
    const rows = Object.entries(detailsObj || {});
    if (!rows.length) {
      commentsList.innerHTML = '<div class="comment-row"><div class="comment-user">System</div><div class="comment-text">No metadata found.</div></div>';
      return;
    }

    commentsList.innerHTML = rows.map(([k, v]) => (
      `<div class="comment-row"><div class="comment-user">${esc(k)}</div><div class="comment-text">${esc(v)}</div></div>`
    )).join('');
  };

  const closeComments = () => {
    commentsOpen = false;
    commentsPanel.classList.remove('open');
  };

  const openComments = async () => {
    commentsOpen = true;
    commentsPanel.classList.add('open');
    if (metadataLoaded) return;

    commentsList.innerHTML = '<div class="comment-row"><div class="comment-user">Loading</div><div class="comment-text">Fetching file data...</div></div>';
    const key = section.dataset.user + '/' + section.dataset.caption;
    try {
      const res = await fetch('/api/video-metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key })
      });
      const payload = await res.json();
      if (payload && payload.ok && payload.details) {
        renderComments(payload.details);
        metadataLoaded = true;
      } else {
        commentsList.innerHTML = '<div class="comment-row"><div class="comment-user">Error</div><div class="comment-text">Could not load file data.</div></div>';
      }
    } catch (e) {
      commentsList.innerHTML = '<div class="comment-row"><div class="comment-user">Error</div><div class="comment-text">Could not load file data.</div></div>';
    }
  };
  const burstLike = (x, y) => {
    const rect = section.getBoundingClientRect();
    const originX = Number.isFinite(x) ? Math.round(x - rect.left) : Math.round(rect.width * 0.5);
    const originY = Number.isFinite(y) ? Math.round(y - rect.top) : Math.round(rect.height * 0.45);

    const count = 6;
    for (let i = 0; i < count; i++) {
      const heart = document.createElement('div');
      heart.className = 'like-burst';
      heart.textContent = '♥';
      heart.style.left = `${originX}px`;
      heart.style.top = `${originY}px`;
      heart.style.setProperty('--dx', `${Math.round((Math.random() - 0.5) * 90)}px`);
      heart.style.setProperty('--dy', `${-55 - Math.round(Math.random() * 70)}px`);
      heart.style.setProperty('--delay', `${Math.round(Math.random() * 70)}ms`);
      heart.style.setProperty('--scale', `${(0.7 + Math.random() * 0.55).toFixed(2)}`);
      section.appendChild(heart);
      requestAnimationFrame(() => heart.classList.add('show'));
      setTimeout(() => { try { heart.remove(); } catch (e) {} }, 850);
    }
  };

  const setLikedState = (nextLiked, triggerPulse = true) => {
    liked = !!nextLiked;
    likeBtn.classList.toggle('liked', liked);
    likeCount.textContent = liked ? '1' : '0';
    section.dataset.liked = liked ? '1' : '0';
    if (liked && triggerPulse) {
      likeBtn.classList.remove('like-pop');
      void likeBtn.offsetWidth;
      likeBtn.classList.add('like-pop');
      setTimeout(() => likeBtn.classList.remove('like-pop'), 260);
    }
    // report like to server
    try{ fetch('/api/track', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify({ key: section.dataset.user + '/' + section.dataset.caption, action: liked ? 'like' : undefined, watchTime: 0 }) }); }catch(e){}
  };

  profileBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = activeCategoryFilter ? null : p.user;
    setCategoryFilter(next).catch(() => {});
  });

  likeBtn.addEventListener('click', ()=>{
    setLikedState(!liked, true);
  });

  commentBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (commentsOpen) closeComments();
    else openComments().catch(() => {});
  });

  commentsPanel.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  shareBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const targetSection = currentVisibleSection || section;
    downloadVideoForSection(targetSection).catch(() => {});
  });

  // single tap toggles play/pause (deferred so double-tap can cancel it)
  section.addEventListener('click', (e)=>{
    if(e.target.tagName.toLowerCase() === 'button') return;
    if (commentsOpen) {
      closeComments();
      return;
    }
    if (!playbackUnlocked) {
      return;
    }
    if (singleTapTimer) clearTimeout(singleTapTimer);
    singleTapTimer = setTimeout(() => {
      const v = section.querySelector('video');
      if(!v) return;
      if(v.paused) {
        section._intentionalPause = false;
        try {
          v.defaultMuted = false;
          v.muted = false;
          if (typeof v.volume === 'number') v.volume = 1;
        } catch (err) {}
        v.play();
      } else {
        section._intentionalPause = true;
        v.pause();
      }
      singleTapTimer = null;
    }, 220);
  });

  // dbl to like with TikTok-style burst
  section.addEventListener('dblclick', (e)=> {
    if (singleTapTimer) {
      clearTimeout(singleTapTimer);
      singleTapTimer = null;
    }
    burstLike(e.clientX, e.clientY);
    if (!liked) setLikedState(true, true);
  });

  // Immediately show the server-generated thumbnail so there is zero black screen
  // while the video element is being created / buffering.
  if (p.thumbnailUrl) {
    const earlyThumb = document.createElement('img');
    earlyThumb.className = 'thumb';
    earlyThumb.decoding  = 'async';
    earlyThumb.src       = p.thumbnailUrl;
    earlyThumb.onerror   = () => { earlyThumb.style.background = '#111'; };
    section.insertBefore(earlyThumb, section.firstChild);
    section._earlyThumb = earlyThumb;
  }

  return section;
}

// play with retry to handle transient autoplay failures
async function playWithRetry(v, tries = 3){
  const retryDelayBaseMs = isMobileLikeDevice() ? 24 : 90;
  for(let i=0;i<tries;i++){
    try{
      await v.play();
      return true;
    }catch(e){
      // If autoplay with sound is blocked, fall back to muted autoplay.
      if(i === 0 && !playbackUnlocked && !v.muted){
        try { v.muted = true; } catch(err){}
      }
      await new Promise(r=>setTimeout(r, retryDelayBaseMs * (i+1)));
    }
  }
  return false;
}

function forceSectionToHls(section, vid, fallbackSrc = '') {
  if (!section || !vid) return false;
  if (!streamPlaybackConfig.hlsEnabled) return false;
  const hlsSrc = section.dataset && section.dataset.hlsUrl ? section.dataset.hlsUrl : '';
  if (!hlsSrc) return false;
  if (!canUseHlsForSection(section)) return false;

  const currentSrc = String(vid.currentSrc || vid.src || '');
  const alreadyUsingHls = !!section._hls || currentSrc.includes('/hls/') || currentSrc.includes('.m3u8');
  if (alreadyUsingHls) {
    // Only resume loading when the stream is actually stalled — never interrupt a healthy playing stream.
    if (section._hls && typeof section._hls.startLoad === 'function' && vid.paused) {
      try { section._hls.startLoad(-1); } catch (err) {}
    }
    return true;
  }

  // Never switch source on a currently-playing video — that destroys playback.
  if (!vid.paused) return false;

  const canNativeHls = typeof vid.canPlayType === 'function' && vid.canPlayType('application/vnd.apple.mpegurl');
  if (canNativeHls) {
    // Native HLS (e.g. Safari/iOS) also doesn't loop properly with HLS playlists.
    // Remove the native loop attribute and implement looping via ended event.
    vid.removeAttribute('loop');
    vid.loop = false;
    vid.addEventListener('ended', () => {
      if (!playbackUnlocked || currentVisibleSection !== section) return;
      try { vid.currentTime = 0; vid.play(); } catch (e) {}
    });
    vid.src = hlsSrc;
    try { vid.load(); } catch (err) {}
    return true;
  }

  if (typeof window.Hls === 'undefined' || !window.Hls || !window.Hls.isSupported || !window.Hls.isSupported()) {
    return false;
  }

  try {
    const mobile = isMobileLikeDevice();
    const hls = new window.Hls({
      lowLatencyMode: false,
      backBufferLength: mobile ? 16 : 12,
      maxBufferLength: mobile ? 8 : 5,
      maxMaxBufferLength: mobile ? 16 : 10,
      maxBufferHole: mobile ? 0.35 : 0.18,
      maxFragLookUpTolerance: mobile ? 0.15 : 0.1,
      nudgeOffset: mobile ? 0.12 : 0.08,
      nudgeMaxRetry: mobile ? 10 : 7,
      enableWorker: true,
      startFragPrefetch: true,
      startLevel: 0,
      capLevelToPlayerSize: true,
      abrEwmaFastLive: 1.5,
      abrEwmaSlowLive: 3,
    });
    // HLS.js does not support the native `loop` attribute — remove it to prevent the
    // browser's loop logic from conflicting with HLS segment management (causes audio
    // to keep playing while the video decoder freezes on loop). We handle looping manually.
    vid.removeAttribute('loop');
    vid.loop = false;

    hls.loadSource(hlsSrc);
    hls.attachMedia(vid);
    section._hls = hls;

    // Manual loop: on ended, reset HLS pipeline cleanly then seek and play.
    vid.addEventListener('ended', () => {
      if (!playbackUnlocked) return;
      if (currentVisibleSection !== section) return;
      try {
        hls.stopLoad();
        vid.currentTime = 0;
        hls.startLoad(0);
        playWithRetry(vid, 2).catch(() => {});
      } catch (loopErr) {
        // If HLS fails to restart, do a full source reload.
        try { hls.loadSource(hlsSrc); hls.startLoad(0); vid.play(); } catch (e) {}
      }
    });

    hls.on(window.Hls.Events.ERROR, (_evt, data) => {
      const isFatal = !!(data && data.fatal);
      if (!isFatal) return;

      const activeMobileSection = isMobileLikeDevice() && currentVisibleSection === section;
      if (activeMobileSection) {
        try {
          if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad(-1);
            return;
          }
          if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
            return;
          }
        } catch (err) {}
      }

      recoverPlaybackForSection(section, vid, fallbackSrc || section.dataset.videoUrl || vid.currentSrc || vid.src || '');
    });
    return true;
  } catch (err) {
    return false;
  }
}

function recoverPlaybackForSection(section, vid, src) {
  if (!section || !vid) return;

  if (section._hls) {
    try { section._hls.destroy(); } catch (e) {}
    section._hls = null;
  }

  section.dataset.hlsReady = '0';
  vid.src = src;
  try { vid.load(); } catch (e) {}
  if (playbackUnlocked) {
    playWithRetry(vid, 2).catch(() => {});
  }

  if (isMobileLikeDevice()) {
    setTimeout(() => {
      if (!section || currentVisibleSection !== section) return;
      const activeVideo = getVideoForSection(section);
      if (!activeVideo) return;
      if (!activeVideo.paused && activeVideo.readyState >= 3 && (activeVideo.currentTime || 0) > 0.03) return;
      try { activeVideo.load(); } catch (e) {}
      playWithRetry(activeVideo, 2).catch(() => {});
    }, 350);
  }
}

function scheduleActivePlaybackHealthCheck(section, delayMs = 420) {
  setTimeout(() => {
    if (isLocalDesktopHostPlayback()) return;
    if (!playbackUnlocked) return;
    if (!section || currentVisibleSection !== section) return;
    // Don't force-restart a video the user intentionally paused.
    if (section._intentionalPause) return;
    const activeVideo = getVideoForSection(section);
    if (!activeVideo) return;

    const healthy = !activeVideo.paused && activeVideo.readyState >= 2;
    if (healthy) {
      return;
    }

    const hasNotStarted = (activeVideo.currentTime || 0) <= 0.03;
    const isStalled = activeVideo.paused || activeVideo.readyState < 2;
    if (!isStalled && hasNotStarted) return;

    recoverPlaybackForSection(section, activeVideo, section.dataset.videoUrl || activeVideo.currentSrc || activeVideo.src || '');
  }, delayMs);
}

function attachVideoToSection(section, opts = {}){
  const prefetchOnly = !!opts.prefetch;

  if(section._hasVideo) {
    if (!prefetchOnly) {
      section._prefetchedVideo = false;
      const existingVideo = getVideoForSection(section);
      if (existingVideo) {
        existingVideo.preload = 'auto';
        const fallbackSrc = section.dataset.videoUrl || existingVideo.currentSrc || existingVideo.src || '';
        forceSectionToHls(section, existingVideo, fallbackSrc);
      }
    }
    return;
  }
  section._hasVideo = true;
  section._prefetchedVideo = prefetchOnly;

  // Remove zombie video elements left over from an interrupted detach
  section.querySelectorAll('video').forEach(v => {
    try { v.pause(); v.src = ''; v.load(); v.remove(); } catch(e) {}
  });

  const src = section.dataset.videoUrl;
  const hlsSrc = section.dataset.hlsUrl;

  // Reuse the thumbnail img already shown by createPlaceholder; create one only as fallback
  let thumbImg = ensureSectionThumbnail(section);
  if (thumbImg) {
    thumbImg.style.opacity = '1';
  }
  if (!thumbImg && !section.dataset.thumb) {
    thumbImg = document.createElement('img');
    thumbImg.className = 'thumb';
    thumbImg.style.opacity = '1';
    section.insertBefore(thumbImg, section.firstChild);
    getVideoThumbnail(src, 640)
      .then(data => {
        section.dataset.thumb = data;
        thumbImg.src = data;
      })
      .catch(() => { thumbImg.style.background = '#111'; });
    section._earlyThumb = thumbImg;
  }

  const vid = document.createElement('video');
  vid.setAttribute('playsinline','');
  vid.setAttribute('webkit-playsinline',''); // iOS older
  vid.setAttribute('loop','');
  vid.setAttribute('disablePictureInPicture','');
  vid.preload = 'auto';
  vid.muted = !playbackUnlocked;
  if (section.dataset.thumb) {
    vid.poster = section.dataset.thumb;
  }
  const shouldUseHls = canUseHlsForSection(section);
  const allowHlsForThisAttach = !prefetchOnly || section.dataset.hlsReady !== '0';
  if (shouldUseHls && hlsSrc && allowHlsForThisAttach) {
    const switchedToHls = forceSectionToHls(section, vid, src);
    if (!switchedToHls) {
      vid.src = src;
    }
  } else {
    vid.src = src;
  }
  vid.style.width = '100%';
  vid.style.display = 'block';
  vid.style.objectFit = 'cover';
  vid.style.transition = 'opacity 300ms ease';
  vid.style.opacity = '0';

  let stallThumbTimer = null;
  const clearStallThumbTimer = () => {
    if (!stallThumbTimer) return;
    clearTimeout(stallThumbTimer);
    stallThumbTimer = null;
    section._stallThumbTimer = null;
  };

  const hideThumbIfPlaying = () => {
    if (!thumbImg) return;
    if (currentVisibleSection !== section) return;
    const hostDesktop = isLocalDesktopHostPlayback();
    const minTime = hostDesktop ? 0.16 : 0.03;
    const minReadyState = hostDesktop ? 3 : 2;
    const healthy = !vid.paused && vid.readyState >= minReadyState && (vid.currentTime || 0) > minTime;
    if (!healthy) return;
    thumbImg.style.opacity = '0';
  };

  const maybeShowThumbForStall = () => {
    if (!thumbImg) return;
    clearStallThumbTimer();

    const mobile = isMobileLikeDevice();
    const stallDelay = mobile ? 260 : 120;
    stallThumbTimer = setTimeout(() => {
      stallThumbTimer = null;
      section._stallThumbTimer = null;
      if (currentVisibleSection !== section) return;
      const stillStalled = vid.paused || vid.readyState < 2;
      if (!stillStalled) return;
      thumbImg.style.opacity = '1';
    }, stallDelay);
    section._stallThumbTimer = stallThumbTimer;
  };

  vid.addEventListener('error', ()=>{
    if (thumbImg) thumbImg.style.opacity = '1';
    const canUseHostFallback = isLocalDesktopHostPlayback() && section && section.dataset && section.dataset.videoUrl && section.dataset.hostFallbackTried !== '1';
    if (canUseHostFallback) {
      try {
        section.dataset.hostFallbackTried = '1';
        const baseSrc = section.dataset.videoUrl;
        vid.src = `${baseSrc}${baseSrc.includes('?') ? '&' : '?'}mobile=1`;
        vid.load();
        if (playbackUnlocked && !section._prefetchedVideo) {
          setTimeout(() => playWithRetry(vid, 2).catch(() => {}), 120);
        }
        return;
      } catch (err) {}
    }

    // try a cache-busting reload if playback fails
    if (section._hls) return recoverPlaybackForSection(section, vid, src);
    vid.src = src + (src.includes('?') ? '&' : '?') + 'cb=' + Date.now();
    if (playbackUnlocked && !section._prefetchedVideo) {
      setTimeout(() => playWithRetry(vid, 2).catch(() => {}), 250);
    }
  });

  vid.addEventListener('stalled', ()=>{
    maybeShowThumbForStall();
    if (!section._prefetchedVideo && playbackUnlocked) {
      playWithRetry(vid, 2).catch(() => {});
    }
  });

  vid.addEventListener('waiting', ()=>{
    maybeShowThumbForStall();
    if (!section._prefetchedVideo && playbackUnlocked) {
      playWithRetry(vid, 2).catch(() => {});
    }
  });
  vid.addEventListener('play', () => {
    clearStallThumbTimer();
    hideThumbIfPlaying();
    if (currentVisibleSection !== section) return;
    pauseAllVideosExcept(vid);
  });
  vid.addEventListener('playing', () => {
    clearStallThumbTimer();
    hideThumbIfPlaying();
  });
  vid.addEventListener('canplay', () => {
    clearStallThumbTimer();
    hideThumbIfPlaying();
  });

  // insert video at top of section (above thumbnail)
  section.insertBefore(vid, thumbImg);

  // Watch time tracking for adaptive recommendations
  section._watchAccum = section._watchAccum || 0;
  let lastTime = 0;
  const sendAccum = () => {
    const key = section.dataset.user + '/' + section.dataset.caption;
    const toSend = Math.floor(section._watchAccum);
    if(toSend > 0){
      try{ fetch('/api/track',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ key, watchTime: toSend }) }); }catch(e){}
      section._watchAccum = 0;
    }
  };

  vid.addEventListener('timeupdate', ()=>{
    try{
      const t = vid.currentTime || 0;
      if(lastTime && t > lastTime){
        section._watchAccum += (t - lastTime);
      }
      lastTime = t;
      // send periodically when accumulated > 5s
      if(section._watchAccum >= 5){ sendAccum(); }
    }catch(e){}
  });

  vid.addEventListener('pause', ()=>{ sendAccum(); });
  vid.addEventListener('ended', () => {
    sendAccum();
    section._ended = true;
    // For non-HLS (plain MP4) videos, the native `loop` attribute handles restart.
    // For HLS-controlled videos the loop is managed in forceSectionToHls; skip here.
    if (section._hls) return;
    // Safety net: if native loop failed and video is paused, replay it.
    setTimeout(() => {
      if (!playbackUnlocked) return;
      if (currentVisibleSection !== section) return;
      if (section._intentionalPause) return;
      if (!vid.paused) return; // already replaying
      try { vid.currentTime = 0; } catch (e) {}
      playWithRetry(vid, 2).catch(() => {});
    }, 80);
  });

  // reveal the first decoded frame as soon as it's available
  let firstFrameShown = false;
  const showFirstFrame = () => {
    if (firstFrameShown) return;
    firstFrameShown = true;
    // Fade the video in ON TOP of the thumbnail (thumbnail stays fully visible during
    // the video's 300ms opacity transition so no black frame ever shows through).
    requestAnimationFrame(() => { vid.style.opacity = '1'; });
  };

  const hideThumbWhenPlaying = () => {
    if (!thumbImg) return;
    if (section._thumbHideTimer) {
      clearTimeout(section._thumbHideTimer);
      section._thumbHideTimer = null;
    }
    const hostDesktop = isLocalDesktopHostPlayback();
    const hideDelay = hostDesktop ? 260 : 120;
    const minHideTime = hostDesktop ? 0.16 : 0.03;
    section._thumbHideTimer = setTimeout(() => {
      const isActiveSection = currentVisibleSection === section;
      const canHide = isActiveSection && !vid.paused && vid.readyState >= 3 && (vid.currentTime || 0) > minHideTime;
      if (canHide && thumbImg) {
        thumbImg.style.opacity = '0';
      }
      section._thumbHideTimer = null;
    }, hideDelay);
  };

  vid.addEventListener('loadeddata', showFirstFrame, { once: true });
  vid.addEventListener('playing', hideThumbWhenPlaying, { once: true });
  vid.addEventListener('timeupdate', () => {
    if (!thumbImg) return;
    const hostDesktop = isLocalDesktopHostPlayback();
    const minHideTime = hostDesktop ? 0.16 : 0.03;
    if (vid.readyState >= 3 && (vid.currentTime || 0) > minHideTime) {
      hideThumbWhenPlaying();
    }
  });

  // Deduplicate startup autoplay attempts from canplay/loadedmetadata/immediate bootstrap.
  let startupPlayIssued = false;
  const requestStartupPlay = (tries = 2) => {
    if (startupPlayIssued) return;
    startupPlayIssued = true;
    playWithRetry(vid, tries).catch(() => {});
  };

  // start playback right after first frame can be shown
  const onCanPlay = async () => {
    showFirstFrame();
    if (section._prefetchedVideo) {
      return;
    }
    if (!playbackUnlocked) {
      try { vid.pause(); } catch (e) {}
      updateTapToUnpauseVisibility();
      return;
    }
    // Video may already be playing from the immediate playWithRetry call above.
    // Calling play() on an already-playing video causes the decoder to restart
    // from scratch, producing the visible stutter at the beginning.
    if (!vid.paused) return;
    requestStartupPlay(2);
  };

  vid.addEventListener('canplay', onCanPlay, { once: true });
  vid.addEventListener('loadedmetadata', () => {
    if (section._prefetchedVideo || !playbackUnlocked) return;
    if (isLocalDesktopHostPlayback()) return;
    if (!vid.paused) return;
    requestStartupPlay(1);
  }, { once: true });

  // ensure playback attempt starts promptly after unlock
  if (playbackUnlocked && !section._prefetchedVideo) {
    requestStartupPlay(2);
    const startupRecoveryDelay = isLocalDesktopHostPlayback() ? 1600 : 900;
    setTimeout(() => {
      if (!playbackUnlocked || section._prefetchedVideo) return;
      if (!section.isConnected) return;
      const progressed = (vid.currentTime || 0) > 0.15;
      const healthy = !vid.paused && (vid.readyState >= 2 || progressed);
      if (healthy) return;
      recoverPlaybackForSection(section, vid, src);
    }, startupRecoveryDelay);
  }

  // pause when leaving viewport handled by observer
}

function detachVideoFromSection(section){
  const watchedSeconds = Number(section._watchAccum || 0);
  if (section._stallThumbTimer) {
    clearTimeout(section._stallThumbTimer);
    section._stallThumbTimer = null;
  }
  if (section._thumbHideTimer) {
    clearTimeout(section._thumbHideTimer);
    section._thumbHideTimer = null;
  }
  if (section._hls) {
    try { section._hls.destroy(); } catch (e) {}
    section._hls = null;
  }
  const thumbImg = ensureSectionThumbnail(section);
  if (thumbImg) {
    thumbImg.style.opacity = '1';
  }
  const v = section.querySelector('video');
  if(v){
    try{ v.pause(); }catch(e){}
    // fade out for smooth transition then remove
    v.style.opacity = '0';
    setTimeout(()=>{
      try {
        v.pause();
        v.src = '';
        v.load();
        v.remove();
      } catch(e){}
    }, 350);
    // send any remaining watch time when detaching
    try{
      const key = section.dataset.user + '/' + section.dataset.caption;
      const toSend = Math.floor(section._watchAccum || 0);
      if(toSend > 0){ fetch('/api/track',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ key, watchTime: toSend }) }); }
      section._watchAccum = 0;
    }catch(e){}
  }
  section._hasVideo = false;
  section._prefetchedVideo = false;

  if (!section._actionSent) {
    const key = section.dataset.user + '/' + section.dataset.caption;
    const liked = section.dataset.liked === '1';
    let action = 'skip';
    if (section._ended) action = 'complete';
    else if (liked) action = 'like';
    else if (watchedSeconds >= 6) action = 'watch';

    lastDecision = { lastKey: key, action };
    try {
      fetch('/api/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(lastDecision)
      });
    } catch (e) {}
    section._actionSent = true;
  }
}

// Observer: when a placeholder intersects, attach video; when leaves, detach
const viewOptions = { root: feed, threshold: 0.6, rootMargin: '20% 0px 20% 0px' };
const viewObserver = new IntersectionObserver((entries)=>{
  entries.forEach((entry) => {
    const sec = entry.target;
    if (!entry.isIntersecting) {
      if (currentVisibleSection === sec) {
        currentVisibleSection = null;
      }
      if (isMobileLikeDevice()) {
        if (isSectionNearViewport(sec)) {
          stopSectionPlayback(sec);
        } else {
          detachVideoFromSection(sec);
        }
        return;
      }
      if (isSectionNearViewport(sec)) {
        stopSectionPlayback(sec);
      } else {
        detachVideoFromSection(sec);
      }
    }
  });

  const active = chooseMostVisibleSection() || pickSectionByScrollPosition();
  if (active) {
    currentVisibleSection = active;
    attachVideoToSection(active, { prefetch: false });
    if (playbackUnlocked) {
      playVisibleSection(active).catch(() => {});
    } else {
      const v = getVideoForSection(active);
      if (v) { try { v.pause(); v.muted = true; } catch (e) {} }
    }
    warmNextVideoFrom(active);
  }

  document.querySelectorAll('.post').forEach((post) => {
    if (post !== currentVisibleSection) {
      stopSectionPlayback(post);
    }
  });

  updateTapToUnpauseVisibility();
}, viewOptions);

let scrollSettleTimer = null;
let lastFeedScrollTop = 0;
let lastPrimedSection = null;
let mobileEarlyPrimeSection = null;
let lastHostBootstrapAt = 0;

function primeSectionForIncomingPlayback(section) {
  if (!section || !section.isConnected) return;
  const mobileDevice = isMobileLikeDevice();
  const desktopHost = isLocalDesktopHostPlayback();
  attachVideoToSection(section, { prefetch: desktopHost || mobileDevice });
  const v = getVideoForSection(section);
  if (!v) return;

  try {
    v.preload = 'auto';
    v.muted = true;
  } catch (err) {}

  if (!desktopHost && !mobileDevice) {
    playWithRetry(v, 1).catch(() => {});
  } else {
    try { v.load(); } catch (err) {}
  }
  warmNextVideoFrom(section);
  lastPrimedSection = section;
}

function primeIncomingByScrollDirection(direction) {
  if (isLocalDesktopHostPlayback() || isMobileLikeDevice()) return;
  if (!playbackUnlocked) return;
  if (!Number.isFinite(direction) || direction === 0) return;

  const posts = Array.from(feed.querySelectorAll('.post'));
  if (!posts.length) return;

  const base = chooseMostVisibleSection() || pickSectionByScrollPosition();
  if (!base) return;
  const baseIndex = posts.indexOf(base);
  if (baseIndex < 0) return;

  const targetIndex = Math.max(0, Math.min(posts.length - 1, baseIndex + (direction > 0 ? 1 : -1)));
  const target = posts[targetIndex];
  if (!target || target === currentVisibleSection || target === lastPrimedSection) return;

  primeSectionForIncomingPlayback(target);
}

// Mobile-only: start playing the destination post (muted) the moment a swipe
// gesture ends, while the CSS scroll animation is still running. This gives
// the video a ~300-500 ms head start so it is already decoding when the feed
// snaps into place, eliminating the thumbnail-flash / black-frame gap.
function startMobileEarlyPrime(section) {
  if (!section || !section.isConnected) return;
  if (section === currentVisibleSection) return;
  if (section === mobileEarlyPrimeSection) return; // already primed this target

  // Cancel previous prime if the user reversed direction
  if (mobileEarlyPrimeSection) {
    const prev = mobileEarlyPrimeSection;
    mobileEarlyPrimeSection = null;
    if (prev !== currentVisibleSection) {
      const pv = getVideoForSection(prev);
      if (pv) { try { pv.pause(); } catch (e) {} }
    }
  }

  mobileEarlyPrimeSection = section;
  attachVideoToSection(section, { prefetch: true });
  if (streamPlaybackConfig.hlsEnabled && canUseHlsForSection(section)) {
    prefetchHlsUpToSeconds(section, MOBILE_PRELOAD_TARGET_SECONDS).catch(() => {});
  }
  const thumb = ensureSectionThumbnail(section);
  if (thumb) thumb.style.opacity = '1';
  const v = getVideoForSection(section);
  if (!v) return;
  try {
    v.preload = 'auto';
    silenceVideo(v);
    forceSectionToHls(section, v, section.dataset.videoUrl || v.currentSrc || v.src || '');
    if (section._hls && typeof section._hls.startLoad === 'function') {
      try { section._hls.startLoad(-1); } catch (err) {}
    }
    // Start decode while user is still scrolling (muted) so target starts instantly on snap.
    // Thumbnail stays visible because hide logic only applies to the current visible section.
    v.load();
    playWithRetry(v, 1).catch(() => {});
  } catch (e) {}
}

function snapFeedToNearestPost() {
  const posts = Array.from(feed.querySelectorAll('.post'));
  if (!posts.length) return null;
  const vh = feed.clientHeight || window.innerHeight || 1;
  const nearestIndex = Math.max(0, Math.min(posts.length - 1, Math.round((feed.scrollTop || 0) / vh)));
  const target = posts[nearestIndex];
  if (!target) return null;

  const targetTop = target.offsetTop;
  if (Math.abs((feed.scrollTop || 0) - targetTop) > 1) {
    feed.scrollTo({ top: targetTop, behavior: 'auto' });
  }
  return target;
}

function ensureActivePlaybackBootstrap() {
  if (isLocalDesktopHostPlayback()) {
    const now = Date.now();
    const withinCooldown = (now - lastHostBootstrapAt) < 320;
    if (withinCooldown && currentVisibleSection && currentVisibleSection.isConnected) {
      const activeVideo = getVideoForSection(currentVisibleSection);
      const alreadyPlaying = activeVideo && !activeVideo.paused && activeVideo.readyState >= 2 && (activeVideo.currentTime || 0) > 0.03;
      if (alreadyPlaying) {
        return;
      }
    }
    lastHostBootstrapAt = now;
  }

  const target = isMobileLikeDevice()
    ? (chooseMostVisibleSection() || pickSectionByScrollPosition() || feed.querySelector('.post'))
    : (snapFeedToNearestPost() || chooseMostVisibleSection() || pickSectionByScrollPosition() || feed.querySelector('.post'));
  if (!target) return;

  currentVisibleSection = target;
  attachVideoToSection(target, { prefetch: false });
  if (playbackUnlocked) {
    playVisibleSection(target).catch(() => {});
    warmNextVideoFrom(target);
  } else {
    const v = getVideoForSection(target);
    if (v) {
      try {
        v.pause();
        v.muted = true;
      } catch (e) {}
    }
    updateTapToUnpauseVisibility();
  }

  if (isMobileLikeDevice()) {
    for (const delay of MOBILE_BOOTSTRAP_RETRY_DELAYS) {
      setTimeout(() => {
        if (!target.isConnected) return;
        if (currentVisibleSection !== target) return;
        attachVideoToSection(target, { prefetch: !playbackUnlocked });
        warmNextVideoFrom(target);
        if (!playbackUnlocked) return;
        const v = getVideoForSection(target);
        if (!v) return;
        const started = !v.paused && v.readyState >= 2 && (v.currentTime || 0) > 0.01;
        if (started) return;
        // Use playWithRetry directly instead of playVisibleSection to avoid
        // incrementing playbackRequestToken and cancelling any in-progress play.
        playWithRetry(v, 2).catch(() => {});
      }, delay);
    }
  }
}

feed.addEventListener('scroll', () => {
  const currentTop = Number(feed.scrollTop || 0);
  const delta = currentTop - lastFeedScrollTop;
  lastFeedScrollTop = currentTop;

  if (isLocalDesktopHostPlayback()) {
    const focus = chooseMostVisibleSection() || pickSectionByScrollPosition();
    if (focus) revealThumbnailsAround(focus, 1);
  }

  if (Math.abs(delta) > 2) {
    primeIncomingByScrollDirection(delta);
    if (isMobileLikeDevice() && playbackUnlocked) {
      const posts = Array.from(feed.querySelectorAll('.post'));
      const base = chooseMostVisibleSection() || pickSectionByScrollPosition();
      if (posts.length && base) {
        const baseIndex = posts.indexOf(base);
        if (baseIndex >= 0) {
          const direction = delta > 0 ? 1 : -1;
          const targetIndex = Math.max(0, Math.min(posts.length - 1, baseIndex + direction));
          const target = posts[targetIndex];
          if (target && target !== currentVisibleSection) {
            startMobileEarlyPrime(target);
          }
        }
      }
    }
  }

  if (scrollSettleTimer) clearTimeout(scrollSettleTimer);
  // Desktop: use 380ms so the smooth-scroll animation from wheelNavigate fully completes
  // before snapFeedToNearestPost() reads scrollTop. At 20ms the animation is mid-flight
  // and snapFeedToNearestPost would read the old position and instantly snap back,
  // requiring a second scroll to actually advance. Mobile uses 20ms because touch
  // navigation is driven by touchend, not by this timer.
  const scrollSettleDelay = isMobileLikeDevice() ? 20 : 380;
  scrollSettleTimer = setTimeout(() => {
    if (!playbackUnlocked) return;
    const target = isMobileLikeDevice()
      ? (chooseMostVisibleSection() || pickSectionByScrollPosition())
      : (snapFeedToNearestPost() || chooseMostVisibleSection() || pickSectionByScrollPosition());
    if (!target) return;
    currentVisibleSection = target;
    if (mobileEarlyPrimeSection === target) mobileEarlyPrimeSection = null;
    attachVideoToSection(target, { prefetch: false });
    // On desktop the IntersectionObserver or wheelNavigate safety net may have
    // already started the video cleanly. Guard against calling playVisibleSection
    // (which internally calls play()) on a healthy playing video - that resets
    // the decoder and causes the visible stutter/double-replay.
    const settleVideo = getVideoForSection(target);
    const alreadyPlayingClean = settleVideo && !settleVideo.paused && settleVideo.readyState >= 3 && (settleVideo.currentTime || 0) > 0.03;
    if (!alreadyPlayingClean) {
      playVisibleSection(target).catch(() => {});
    }
    warmNextVideoFrom(target);

    document.querySelectorAll('.post').forEach((post) => {
      if (post !== target) {
        stopSectionPlayback(post);
      }
    });
  }, scrollSettleDelay);
}, { passive: true });

// Mobile early-prime: fire as soon as a directional swipe ends so the
// destination video gets a head start while the scroll animation plays.
if (isMobileLikeDevice()) {
  let mTouchStartY = 0;
  feed.addEventListener('touchstart', (e) => {
    if (e.touches.length > 0) mTouchStartY = e.touches[0].clientY;
  }, { passive: true });
  feed.addEventListener('touchmove', (e) => {
    if (!playbackUnlocked) return;
    const currentY = e.touches.length > 0 ? e.touches[0].clientY : mTouchStartY;
    const dy = mTouchStartY - currentY;
    if (Math.abs(dy) < 16) return;
    const direction = dy > 0 ? 1 : -1;
    const posts = Array.from(feed.querySelectorAll('.post'));
    if (!posts.length) return;
    const base = chooseMostVisibleSection() || pickSectionByScrollPosition();
    if (!base) return;
    const baseIndex = posts.indexOf(base);
    if (baseIndex < 0) return;
    const targetIndex = Math.max(0, Math.min(posts.length - 1, baseIndex + direction));
    const target = posts[targetIndex];
    if (!target || target === currentVisibleSection) return;
    startMobileEarlyPrime(target);
  }, { passive: true });
  feed.addEventListener('touchend', (e) => {
    if (!playbackUnlocked) return;
    const endY = e.changedTouches.length > 0 ? e.changedTouches[0].clientY : mTouchStartY;
    const dy = mTouchStartY - endY;
    if (Math.abs(dy) < 40) return; // ignore taps and micro-swipes
    const direction = dy > 0 ? 1 : -1; // swipe up (dy>0) → next post
    const posts = Array.from(feed.querySelectorAll('.post'));
    if (!posts.length) return;
    const base = chooseMostVisibleSection() || pickSectionByScrollPosition();
    if (!base) return;
    const baseIndex = posts.indexOf(base);
    if (baseIndex < 0) return;
    const targetIndex = Math.max(0, Math.min(posts.length - 1, baseIndex + direction));
    const target = posts[targetIndex];
    if (!target || target === currentVisibleSection) return;
    startMobileEarlyPrime(target);
    currentVisibleSection = target;
    playVisibleSection(target).catch(() => {});
  }, { passive: true });
}

// sentinel for loading more pages
let loading = false;
const sentinel = document.createElement('div');
sentinel.id = 'sentinel';
feed.appendChild(sentinel);
const sentinelObserver = new IntersectionObserver((entries)=>{
  entries.forEach(e=>{ if(e.isIntersecting) loadNext(); });
}, {root: feed, threshold: 0});
sentinelObserver.observe(sentinel);

async function loadNext(){
  if(loading) return;
  const requestedFeedVersion = feedVersion;
  loading = true;
  try{
    const payload = lastDecision ? { ...lastDecision } : {};
    if (activeCategoryFilter) {
      payload.categoryFilter = activeCategoryFilter;
    }
    lastDecision = null;
    const res = await withTimeout(fetch('/api/next', { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(payload) }), 5000, null);
    if (!res || !res.ok) {
      throw new Error(`Failed to load next post (${res ? res.status : 'timeout'})`);
    }
    const data = await res.json();
    if (requestedFeedVersion !== feedVersion) {
      return;
    }
    const post = data && data.post ? data.post : null;
    if(!post){
      if (data && data.initializing) {
        // Server is still scanning the video folder — bootstrapFeed will retry.
        if (startupOverlay && startupOverlay.isConnected) {
          startupOverlay.textContent = 'Starting up…';
        }
        return;
      }
      const msg = activeCategoryFilter
        ? `No videos found in category: ${activeCategoryFilter}`
        : 'No videos found. Please configure VIDEO_SOURCE_DIR to point to your categorized videos folder. See README.md for setup instructions.';
      feed.innerHTML = `<div style="padding:20px;color:#ddd">${msg}</div>`;
      feed.appendChild(sentinel);
      return;
    }

    appendPostToFeed(post);

  }catch(err){
    console.error('Failed to load posts', err);
    // Update overlay text while bootstrapFeed retries; don't show permanent error here.
    if (startupOverlay && startupOverlay.isConnected) {
      startupOverlay.textContent = 'Connecting to server…';
    }
  } finally { loading = false; }
}

async function primeInitialFeed(){
  for(let i = 0; i < INITIAL_PRELOAD_POSTS; i++){
    await loadNext();
  }

  const backgroundWarm = isMobileLikeDevice() ? 1 : 2;
  for (let i = 0; i < backgroundWarm; i++) {
    loadNext().catch(() => {});
  }

  if (isMobileLikeDevice()) {
    const first = feed.querySelector('.post');
    if (first) {
      attachVideoToSection(first, { prefetch: true });
      warmNextVideoFrom(first);
    }
  }
}

// Retry-with-backoff bootstrap so a slow/late server start doesn't leave the
// overlay stuck at "Loading videos…" forever.
async function bootstrapFeed() {
  // Delays between attempts: immediate, then 1 s, 2 s, 3.5 s, 6 s, 10 s (~22 s total)
  const RETRY_DELAYS_MS = [0, 1000, 2000, 3500, 6000, 10000];
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    if (RETRY_DELAYS_MS[attempt] > 0) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
    // Another code path already loaded posts or replaced the feed — stop.
    if (!startupOverlay || !startupOverlay.isConnected) return;
    if (feed.querySelector('.post')) return;
    await primeInitialFeed();
    if (!startupOverlay || !startupOverlay.isConnected) return;
    if (feed.querySelector('.post')) return;
  }
  // All attempts exhausted — show an actionable error with a Retry button.
  if (startupOverlay && startupOverlay.isConnected) {
    startupOverlay.style.flexDirection = 'column';
    startupOverlay.style.gap = '12px';
    startupOverlay.innerHTML =
      '<span style="font-size:24px">⚠️</span>' +
      '<span>Could not load videos.</span>' +
      '<span style="font-size:12px;opacity:0.6;max-width:280px;text-align:center">Make sure the Arcinity server is running in the launcher, then try again.</span>' +
      '<button onclick="location.reload()" style="margin-top:4px;padding:7px 20px;border:1px solid #555;border-radius:6px;background:#1a1a2e;color:#ddd;cursor:pointer;font-size:13px;letter-spacing:0.2px">Retry</button>';
  }
}

// kick off and warm first posts before user scrolls
refreshStreamPlaybackConfig().catch(() => {});
refreshRecommendationMode().catch(() => {});
bootstrapFeed().catch(() => {});

// Desktop wheel navigation: move exactly one post per wheel gesture
let wheelLocked = false;
let wheelDeltaAccumulator = 0;
let wheelAccumulatorTimer = null;
const WHEEL_LOCK_MS = 300;
const WHEEL_TRIGGER_DELTA = 40;
const TOUCH_TRIGGER_DELTA = 10;
const TOUCH_LOCK_MS = 220;

let touchStartY = 0;
let touchActive = false;
let suppressWheelUntil = 0;

async function wheelNavigate(deltaY, lockMs = WHEEL_LOCK_MS) {
  if (!playbackUnlocked) return;
  if (wheelLocked) return;
  if (Math.abs(deltaY) < 2) return;

  const direction = deltaY > 0 ? 1 : -1;
  const posts = Array.from(feed.querySelectorAll('.post'));
  if (!posts.length) return;

  const vh = feed.clientHeight || window.innerHeight || 1;
  const currentIndex = Math.max(0, Math.min(posts.length - 1, Math.round((feed.scrollTop || 0) / vh)));
  let targetIndex = currentIndex + direction;

  if (targetIndex < 0) targetIndex = 0;

  if (targetIndex >= posts.length && direction > 0) {
    await loadNext();
  }

  const updatedPosts = Array.from(feed.querySelectorAll('.post'));
  if (!updatedPosts.length) return;
  if (targetIndex >= updatedPosts.length) targetIndex = updatedPosts.length - 1;

  const target = updatedPosts[targetIndex];
  if (!target) return;

  if (isLocalDesktopHostPlayback()) {
    revealThumbnailsAround(target, 1);
  }

  primeSectionForIncomingPlayback(target);
  if (isMobileLikeDevice()) {
    startMobileEarlyPrime(target);
    currentVisibleSection = target;
    playVisibleSection(target).catch(() => {});
  }

  wheelLocked = true;
  // Use scrollTo with exact pixel position for reliable mobile behaviour
  const targetScrollTop = targetIndex * feed.clientHeight;
  feed.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
  setTimeout(() => {
    if (!isMobileLikeDevice()) {
      snapFeedToNearestPost();
    }
    wheelLocked = false;
    // Safety net: play the visible section if the IntersectionObserver hasn't already.
    // Guard against calling play() on an already-playing video which causes a restart.
    if (playbackUnlocked && currentVisibleSection) {
      const v = getVideoForSection(currentVisibleSection);
      const alreadyRunning = v && !v.paused && v.readyState >= 2;
      if (v && !alreadyRunning) {
        playVisibleSection(currentVisibleSection).catch(() => {});
      }
    }
  }, lockMs);
}

window.addEventListener('wheel', (e) => {
  if (!playbackUnlocked) {
    e.preventDefault();
    return;
  }

  if (Date.now() < suppressWheelUntil) {
    e.preventDefault();
    return;
  }

  // ignore pinch-zoom gestures and keep normal behavior for modifier-key scroll
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  const openComments = e.target && e.target.closest && e.target.closest('.comments-panel.open');
  if (openComments) {
    // allow native scroll inside comments drawer without switching videos
    return;
  }

  e.preventDefault();

  // Touchpads often emit many tiny wheel deltas; accumulate and trigger one post move.
  wheelDeltaAccumulator += e.deltaY;
  if (wheelAccumulatorTimer) clearTimeout(wheelAccumulatorTimer);
  wheelAccumulatorTimer = setTimeout(() => {
    wheelDeltaAccumulator = 0;
    wheelAccumulatorTimer = null;
  }, 120);

  if (Math.abs(wheelDeltaAccumulator) < WHEEL_TRIGGER_DELTA) return;

  const directionDelta = wheelDeltaAccumulator > 0 ? 120 : -120;
  wheelDeltaAccumulator = 0;
  wheelNavigate(directionDelta).catch(() => {});
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (!playbackUnlocked) {
    e.preventDefault();
    return;
  }

  if (e.defaultPrevented) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  let deltaY = 0;
  if (e.key === 'ArrowDown') deltaY = 120;
  if (e.key === 'ArrowUp') deltaY = -120;
  if (!deltaY) return;

  const openComments = e.target && e.target.closest && e.target.closest('.comments-panel.open');
  if (openComments) {
    return;
  }

  e.preventDefault();
  wheelNavigate(deltaY).catch(() => {});
});

feed.addEventListener('touchstart', (e) => {
  if (!playbackUnlocked) {
    e.preventDefault();
    touchActive = false;
    return;
  }

  const interactiveTarget = e.target && e.target.closest && e.target.closest('button, .action, .comments-panel, .comments-list, .comment-row, .comment-text, .comment-user, input, textarea, a');
  if (interactiveTarget) {
    touchActive = false;
    return;
  }

  if (!e.touches || e.touches.length !== 1) {
    touchActive = false;
    return;
  }

  const openComments = e.target && e.target.closest && e.target.closest('.comments-panel.open');
  if (openComments) {
    touchActive = false;
    return;
  }

  touchStartY = e.touches[0].clientY;
  touchActive = true;
}, { passive: false });

feed.addEventListener('touchmove', (e) => {
  if (!touchActive) return;
  const interactiveTarget = e.target && e.target.closest && e.target.closest('button, .action, .comments-panel, .comments-list, .comment-row, .comment-text, .comment-user, input, textarea, a');
  if (interactiveTarget) return;
  const openComments = e.target && e.target.closest && e.target.closest('.comments-panel.open');
  if (openComments) return;
  // Prevent momentum scrolling so one swipe maps to one post.
  e.preventDefault();
}, { passive: false });

feed.addEventListener('touchend', (e) => {
  if (!touchActive) return;
  touchActive = false;

  const changed = e.changedTouches && e.changedTouches[0];
  if (!changed) return;

  const delta = touchStartY - changed.clientY;
  if (Math.abs(delta) < TOUCH_TRIGGER_DELTA) return;

  suppressWheelUntil = Date.now() + 380;
  const directionDelta = delta > 0 ? 120 : -120;
  wheelNavigate(directionDelta, TOUCH_LOCK_MS).catch(() => {});
}, { passive: true });

