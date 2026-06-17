/* ══════════════════════════════════════════════════════════
   Constants
═══════════════════════════════════════════════════════════ */
const API_BASE = 'https://oboukhov.com';
const ERROR_TIMEOUT_MS = 60000;
const NETWORK_RETRY_ATTEMPTS = 3;
const PLAYBACK_BUFFER_MIN_MS = 500;
const SUPPORTED_VIDEO_CODECS = ['h264', 'vp9', 'hevc', 'av1'];
const SUPPORTED_AUDIO_CODECS = ['aac', 'opus', 'mp3', 'vorbis'];

/* ══════════════════════════════════════════════════════════
   Error Handling & Logging System
═══════════════════════════════════════════════════════════ */
const ErrorHandler = {
  logs: [],
  maxLogs: 1000,

  log(level, source, message, error = null) {
    const timestamp = new Date().toISOString();
    const entry = {
      timestamp,
      level,
      source,
      message,
      error: error ? error.toString() : null,
      stack: error && error.stack ? error.stack : null
    };

    // Keep logs in memory
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Console output
    const prefix = `[${level.toUpperCase()}] ${source}:`;
    if (level === 'error') console.error(prefix, message, error);
    else if (level === 'warn') console.warn(prefix, message, error);
    else console.log(prefix, message);
  },

  exportLogs() {
    return this.logs;
  },

  clearLogs() {
    this.logs = [];
  }
};

/* ══════════════════════════════════════════════════════════
   Playback Health Monitoring
═══════════════════════════════════════════════════════════ */
const PlaybackMonitor = {
  metrics: {
    bufferEvents: 0,
    stallCount: 0,
    fps: 0,
    renderLatency: 0,
    networkQuality: 'unknown',
    cpuUsage: 0,
    lastCheck: null
  },

  init() {
    try {
      // Monitor performance
      if (window.performance && window.performance.memory) {
        this.monitorMemory();
      }
      ErrorHandler.log('info', 'PlaybackMonitor', 'Playback monitoring initialized');
    } catch (e) {
      ErrorHandler.log('warn', 'PlaybackMonitor', 'Performance monitoring unavailable', e);
    }
  },

  monitorMemory() {
    setInterval(() => {
      try {
        if (window.performance && window.performance.memory) {
          const used = window.performance.memory.usedJSHeapSize;
          const limit = window.performance.memory.jsHeapSizeLimit;
          this.metrics.cpuUsage = (used / limit) * 100;
        }
      } catch (e) {
        ErrorHandler.log('warn', 'PlaybackMonitor', 'Memory check failed', e);
      }
    }, 5000);
  },

  checkCodecSupport(videoCodec, audioCodec) {
    try {
      const videoEl = document.createElement('video');
      const videoSupport = videoEl.canPlayType(`video/mp4; codecs="${videoCodec}"`);
      const audioSupport = videoEl.canPlayType(`audio/mpeg; codecs="${audioCodec}"`);
      
      const isSupported = videoSupport && videoSupport !== '' && audioSupport && audioSupport !== '';
      return {
        supported: isSupported,
        videoCodec,
        audioCodec,
        videoType: videoSupport,
        audioType: audioSupport
      };
    } catch (e) {
      ErrorHandler.log('warn', 'PlaybackMonitor', 'Codec check failed', e);
      return { supported: false, error: e.message };
    }
  },

  validateStreamSettings(resolution, fragmentSize) {
    const issues = [];

    if (!resolution || parseInt(resolution) < 144) {
      issues.push('Resolution too low for smooth playback');
    }
    if (parseInt(resolution) > 4320) {
      issues.push('Resolution exceeds recommended limits');
    }
    if (!fragmentSize || fragmentSize < 1 || fragmentSize > 12) {
      issues.push('Fragment duration out of valid range (1-12 seconds)');
    }

    return {
      valid: issues.length === 0,
      issues,
      resolution,
      fragmentSize
    };
  },

  getMetrics() {
    return {
      ...this.metrics,
      timestamp: new Date().toISOString()
    };
  }
};

PlaybackMonitor.init();

/* ══════════════════════════════════════════════════════════
   DOM – Server panel
═══════════════════════════════════════════════════════════ */
const videoFolderInput = document.getElementById('video-folder');
const portInput        = document.getElementById('port');
const browseFolderBtn  = document.getElementById('browse-folder');
const startBtn         = document.getElementById('start-btn');
const stopBtn          = document.getElementById('stop-btn');
const openAppBtn       = document.getElementById('open-app-btn');
const clearLogsBtn     = document.getElementById('clear-logs');
const statusPill       = document.getElementById('status-pill');
const algoModePill     = document.getElementById('algo-mode-pill');
const logsEl           = document.getElementById('logs');
const messageEl        = document.getElementById('message');

const windowMinBtn = document.getElementById('window-minimize');
const windowMaxBtn = document.getElementById('window-maximize');
const windowCloseBtn = document.getElementById('window-close');

function setWindowMaxButtonState(isMaximized) {
  if (!windowMaxBtn) return;
  windowMaxBtn.textContent = isMaximized ? '❐' : '□';
  windowMaxBtn.title = isMaximized ? 'Restore' : 'Maximize';
  windowMaxBtn.setAttribute('aria-label', isMaximized ? 'Restore' : 'Maximize');
}

async function refreshWindowMaxButtonState() {
  if (!window.arcinityAPI || !window.arcinityAPI.windowIsMaximized) return;
  try {
    const isMaximized = await window.arcinityAPI.windowIsMaximized();
    setWindowMaxButtonState(Boolean(isMaximized));
  } catch {
    setWindowMaxButtonState(false);
  }
}

if (windowMinBtn) {
  windowMinBtn.addEventListener('click', () => {
    window.arcinityAPI.windowMinimize().catch(() => {});
  });
}

if (windowMaxBtn) {
  windowMaxBtn.addEventListener('click', async () => {
    try {
      const result = await window.arcinityAPI.windowToggleMaximize();
      setWindowMaxButtonState(Boolean(result && result.maximized));
    } catch {
      refreshWindowMaxButtonState().catch(() => {});
    }
  });
}

if (windowCloseBtn) {
  windowCloseBtn.addEventListener('click', () => {
    window.arcinityAPI.windowClose().catch(() => {});
  });
}

window.addEventListener('resize', () => {
  refreshWindowMaxButtonState().catch(() => {});
});

refreshWindowMaxButtonState().catch(() => {});

/* ══════════════════════════════════════════════════════════
   DOM – Auth
═══════════════════════════════════════════════════════════ */
const signinBtn      = document.getElementById('signin-btn');
const signoutBtn     = document.getElementById('signout-btn');
const authSignedOut  = document.getElementById('auth-signed-out');
const authSignedIn   = document.getElementById('auth-signed-in');
const authEmailLabel = document.getElementById('auth-email-label');
const authModal      = document.getElementById('auth-modal');
const modalCloseBtn  = document.getElementById('modal-close-btn');
const signinForm     = document.getElementById('signin-form');
const signupForm     = document.getElementById('signup-form');
const signinError    = document.getElementById('signin-error');
const signupError    = document.getElementById('signup-error');
const modalTabs      = document.querySelectorAll('.modal-tab');

/* ══════════════════════════════════════════════════════════
   DOM – Tabs
═══════════════════════════════════════════════════════════ */
const tabBtns       = document.querySelectorAll('.tab-btn');
const tabBtnAccount = document.getElementById('tab-btn-account');
const tabBtnPro     = document.getElementById('tab-btn-pro');
const tabPanels     = {
  home:    document.getElementById('tab-home'),
  account: document.getElementById('tab-account'),
  pro:     document.getElementById('tab-pro'),
};

/* ══════════════════════════════════════════════════════════
   DOM – Account panel
═══════════════════════════════════════════════════════════ */
const accountEmailDisplay = document.getElementById('account-email-display');
const newEmailInput       = document.getElementById('new-email');
const updateEmailBtn      = document.getElementById('update-email-btn');
const emailUpdateMsg      = document.getElementById('email-update-msg');
const currentPasswordInput = document.getElementById('current-password');
const newPasswordInput    = document.getElementById('new-password');
const updatePasswordBtn   = document.getElementById('update-password-btn');
const passwordUpdateMsg   = document.getElementById('password-update-msg');
const accountSubscriptionCard = document.getElementById('account-subscription-card');
const accountSubscriptionStatus = document.getElementById('account-subscription-status');
const accountMonthsLeft = document.getElementById('account-months-left');
const accountNextPayment = document.getElementById('account-next-payment');
const accountSubscriptionNote = document.getElementById('account-subscription-note');
const accountStartTrialBtn = document.getElementById('account-start-trial-btn');
const accountCancelSubBtn = document.getElementById('account-cancel-sub-btn');

/* ══════════════════════════════════════════════════════════
  DOM – Pro panel
═══════════════════════════════════════════════════════════ */
const proTitle = document.getElementById('pro-title');
const proSubtitle = document.getElementById('pro-subtitle');
const proCoursesContainer = document.getElementById('pro-courses-container');
const proTrialWall = document.getElementById('pro-trial-wall');
const proFeaturePreview = document.getElementById('pro-feature-preview');
const proPaymentScreen = document.getElementById('pro-payment-screen');
const proBeginTrialBtn = document.getElementById('pro-begin-trial-btn');
const proBackToFeaturesBtn = document.getElementById('pro-back-to-features-btn');
const proTrialForm = document.getElementById('pro-trial-form');
const proTrialMsg = document.getElementById('pro-trial-msg');
const trialNameInput = document.getElementById('trial-name');
const trialEmailInput = document.getElementById('trial-email');
const trialCardInput = document.getElementById('trial-card');
const trialExpInput = document.getElementById('trial-exp');
const trialCvcInput = document.getElementById('trial-cvc');
const trialHeroBanner = document.getElementById('trial-hero-banner');
const trialHeroCta = document.getElementById('trial-hero-cta');

/* ══════════════════════════════════════════════════════════
  DOM – Deep Learning panel
═══════════════════════════════════════════════════════════ */
const proSignedOutMsg     = document.getElementById('pro-signed-out-msg');
const proDeepLearnSection = document.getElementById('pro-deeplearn-section');
const dlStatusPill        = document.getElementById('dl-status-pill');
const dlStats             = document.getElementById('dl-stats');
const dlTotalEl           = document.getElementById('dl-total');
const dlIndexedEl         = document.getElementById('dl-indexed');
const dlPendingEl         = document.getElementById('dl-pending');
const dlDepPanel          = document.getElementById('dl-dep-panel');
const dlProgressWrap      = document.getElementById('dl-progress-wrap');
const dlProgressBar       = document.getElementById('dl-progress-bar');
const dlProgressText      = document.getElementById('dl-progress-text');
const dlStageText         = document.getElementById('dl-stage-text');
const dlRunBtn            = document.getElementById('dl-run-btn');
const dlCancelBtn         = document.getElementById('dl-cancel-btn');
const dlCheckDepsBtn      = document.getElementById('dl-check-deps-btn');
const dlInstallBtn        = document.getElementById('dl-install-btn');
const dlReindexBtn        = document.getElementById('dl-reindex-btn');
const dlMessageEl         = document.getElementById('dl-message');
const dlInstallLog        = document.getElementById('dl-install-log');
const dlDepWhisperIcon    = document.getElementById('dl-dep-whisper-icon');
const dlDepWhisperLabel   = document.getElementById('dl-dep-whisper-label');
const dlDepVisualIcon     = document.getElementById('dl-dep-visual-icon');
const dlDepVisualLabel    = document.getElementById('dl-dep-visual-label');
const dlDepAudioIcon      = document.getElementById('dl-dep-audio-icon');
const dlDepAudioLabel     = document.getElementById('dl-dep-audio-label');
const dlQualityFastBtn    = document.getElementById('dl-quality-fast');
const dlQualityBalancedBtn = document.getElementById('dl-quality-balanced');
const dlQualityQualityBtn = document.getElementById('dl-quality-quality');
const dlDepPythonIcon     = document.getElementById('dl-dep-python-icon');
const dlDepPythonLabel    = document.getElementById('dl-dep-python-label');
const dlEnhancedModeWrap  = document.getElementById('dl-enhanced-mode-wrap');
const dlEnhancedModeToggle = document.getElementById('dl-enhanced-mode-toggle');
const dlEnhancedModeNote  = document.getElementById('dl-enhanced-mode-note');
const streamMaxResolutionSelect = document.getElementById('stream-max-resolution');
const streamFragmentSecondsInput = document.getElementById('stream-fragment-seconds');
const streamApplyBtn = document.getElementById('stream-apply-btn');
const streamSettingsMessage = document.getElementById('stream-settings-message');

/* ══════════════════════════════════════════════════════════
  DOM – Thumbnails panel
═══════════════════════════════════════════════════════════ */
const generateThumbsBtn  = document.getElementById('generate-thumbs-btn');
const cancelThumbsBtn    = document.getElementById('cancel-thumbs-btn');
const thumbsStatusPill   = document.getElementById('thumbs-status-pill');
const thumbsStats        = document.getElementById('thumbs-stats');
const thumbsTotalEl      = document.getElementById('thumbs-total');
const thumbsExistingEl   = document.getElementById('thumbs-existing');
const thumbsMissingEl    = document.getElementById('thumbs-missing');
const thumbsProgressWrap = document.getElementById('thumbs-progress-wrap');
const thumbsProgressBar  = document.getElementById('thumbs-progress-bar');
const thumbsProgressText = document.getElementById('thumbs-progress-text');
const thumbsMessageEl    = document.getElementById('thumbs-message');

/* ══════════════════════════════════════════════════════════
   State
═══════════════════════════════════════════════════════════ */
let currentUrl = '';
let currentLanUrl = '';
let authState  = { loggedIn: false, email: null, userId: null };
let activeTab  = 'home';
let serverIsRunning = false;
let thumbState = { scanned: false, total: 0, existing: 0, missing: 0, failed: 0, generating: false, ready: false };
let proState = { active: false, monthsLeft: 0, nextPaymentDue: null, checked: false };
let proTrialStep = 'features';
let dlState = {
  scanned: false, total: 0, indexed: 0, pending: 0,
  running: false, depsChecked: false, depsOk: false,
  outputPath: null, hasMissingDeps: false,
  selectedQuality: 'balanced',
};
let enhancedAlgorithmPreference = false;
let effectiveEnhancedMode = false;
let streamSettingsState = {
  maxResolution: '540',
  fragmentSeconds: 1,
};
const AUTH_CACHE_KEY = 'arcinity-auth-cache-v1';
const PRO_CACHE_KEY = 'arcinity-pro-cache-v1';

try {
  enhancedAlgorithmPreference = localStorage.getItem('arcinity-enhanced-algo') === '1';
} catch {
  enhancedAlgorithmPreference = false;
}

/* ══════════════════════════════════════════════════════════
   Safe DOM Access Utilities
═══════════════════════════════════════════════════════════ */
function safeGetElement(id) {
  try {
    const el = document.getElementById(id);
    if (!el) {
      ErrorHandler.log('warn', 'safeGetElement', `Element not found: #${id}`);
    }
    return el;
  } catch (e) {
    ErrorHandler.log('error', 'safeGetElement', `Error accessing element #${id}`, e);
    return null;
  }
}

function safeSetText(element, text) {
  try {
    if (element && typeof element.textContent === 'string') {
      element.textContent = text || '';
      return true;
    }
  } catch (e) {
    ErrorHandler.log('warn', 'safeSetText', 'Failed to set text content', e);
  }
  return false;
}

function safeSetProperty(element, property, value) {
  try {
    if (element && property in element) {
      element[property] = value;
      return true;
    }
  } catch (e) {
    ErrorHandler.log('warn', 'safeSetProperty', `Failed to set ${property}`, e);
  }
  return false;
}

/* ══════════════════════════════════════════════════════════
   Utilities – server panel
═══════════════════════════════════════════════════════════ */
function setMessage(text, kind = 'info') {
  try {
    if (!messageEl) return;
    messageEl.textContent = text || '';
    if (kind === 'error')   { messageEl.style.color = '#fca5a5'; return; }
    if (kind === 'success') { messageEl.style.color = '#6ee7b7'; return; }
    messageEl.style.color = '#f7c15a';
  } catch (e) {
    ErrorHandler.log('error', 'setMessage', 'Failed to set message', e);
  }
}

function updateAlgorithmModePill(mode) {
  if (!algoModePill) return;
  const next = String(mode || 'regular').toLowerCase();
  algoModePill.classList.remove('regular', 'enhanced', 'restarting');
  if (next === 'enhanced') {
    algoModePill.classList.add('enhanced');
    algoModePill.textContent = serverIsRunning
      ? 'Enhanced AI (Index Features)'
      : 'Enhanced AI Selected (Server Stopped)';
    return;
  }
  if (next === 'restarting') {
    algoModePill.classList.add('restarting');
    algoModePill.textContent = 'Applying Mode… Restarting Server';
    return;
  }
  algoModePill.classList.add('regular');
  algoModePill.textContent = serverIsRunning
    ? 'Basic'
    : 'Basic (Server Stopped)';
}

function appendLog(line) {
  if (!line) return;
  const now = new Date().toLocaleTimeString();
  logsEl.textContent += `[${now}] ${line}\n`;
  logsEl.scrollTop = logsEl.scrollHeight;
}

function setStreamSettingsMessage(text, kind) {
  if (!streamSettingsMessage) return;
  streamSettingsMessage.textContent = text || '';
  streamSettingsMessage.style.color =
    kind === 'error' ? '#fca5a5' :
    kind === 'success' ? '#6ee7b7' : '#f7c15a';
}

function normalizeFragmentSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 2;
  return Math.max(1, Math.min(12, Math.round(n)));
}

function getDesiredStreamSettings() {
  const isPro = Boolean(authState.loggedIn && proState.active);
  const maxResolution = isPro
    ? (streamMaxResolutionSelect ? String(streamMaxResolutionSelect.value || '540') : '540')
    : '540';
  const fragmentSeconds = streamFragmentSecondsInput
    ? normalizeFragmentSeconds(streamFragmentSecondsInput.value)
    : 2;
  return { maxResolution, fragmentSeconds };
}

function renderStreamSettingsUI() {
  const isPro = Boolean(authState.loggedIn && proState.active);
  if (streamMaxResolutionSelect) {
    if (!isPro) streamMaxResolutionSelect.value = '540';
    streamMaxResolutionSelect.disabled = !isPro;
  }
  if (streamApplyBtn) {
    streamApplyBtn.disabled = !authState.loggedIn;
  }
}

async function syncStreamSettingsToServer(showStatus = false) {
  if (!serverIsRunning) {
    ErrorHandler.log('info', 'syncStreamSettings', 'Server not running, skipping sync');
    return;
  }

  const before = { ...streamSettingsState };
  const desired = getDesiredStreamSettings();

  // Validate settings before applying
  const validation = PlaybackMonitor.validateStreamSettings(desired.maxResolution, desired.fragmentSeconds);
  if (!validation.valid) {
    const msg = `Invalid stream settings: ${validation.issues.join(', ')}`;
    ErrorHandler.log('warn', 'syncStreamSettings', msg);
    if (showStatus) {
      setStreamSettingsMessage(msg, 'error');
    }
    return;
  }

  try {
    const result = await window.arcinityAPI.setServerStreamSettings(desired);
    if (result && result.ok && result.data && result.data.settings) {
      streamSettingsState = { ...streamSettingsState, ...result.data.settings };
      ErrorHandler.log('info', 'syncStreamSettings', `Stream settings synced: ${JSON.stringify(streamSettingsState)}`);
    } else {
      streamSettingsState = { ...streamSettingsState, ...desired };
    }

    if (showStatus) {
      setStreamSettingsMessage('Streaming settings applied to server.', 'success');
    }
  } catch (e) {
    ErrorHandler.log('error', 'syncStreamSettings', 'Failed to sync stream settings', e);
    if (showStatus) {
      setStreamSettingsMessage(`Could not apply streaming settings: ${e.message}`, 'error');
    }
    return;
  }

  const next = streamSettingsState || desired;
  const resolutionChanged = String(before.maxResolution || '') !== String(next.maxResolution || '');
  
  if (!resolutionChanged) {
    if (showStatus) {
      setStreamSettingsMessage('Streaming settings applied to server.', 'success');
    }
    return;
  }

  try {
    const payload = {
      videoSourceDir: videoFolderInput.value,
      port: Number(portInput.value),
    };

    if (!payload.videoSourceDir) {
      throw new Error('Video source directory not set');
    }

    setMessage('Resolution changed. Restarting server to apply playback-safe streams…', 'info');
    ErrorHandler.log('info', 'syncStreamSettings', `Resolution change detected: ${before.maxResolution} → ${next.maxResolution}`);

    await window.arcinityAPI.stopServer();
    currentUrl = '';
    currentLanUrl = '';
    setRunningUI(false);

    const restartResult = await window.arcinityAPI.startServer(payload);
    if (!restartResult || !restartResult.ok) {
      const errMsg = (restartResult && restartResult.error) || 'Failed to restart server after resolution change';
      setMessage(errMsg, 'error');
      ErrorHandler.log('error', 'syncStreamSettings', errMsg);
      if (showStatus) {
        setStreamSettingsMessage('Applied settings but failed to restart server.', 'error');
      }
      return;
    }

    currentUrl = restartResult.url;
    currentLanUrl = restartResult.lanUrl || '';
    setRunningUI(true);
    
    await syncEnhancedModeToServer();
    await syncStreamSettingsToServer(false);

    if (showStatus) {
      setStreamSettingsMessage('Resolution applied. Server restarted successfully.', 'success');
    }
    ErrorHandler.log('info', 'syncStreamSettings', 'Server restarted successfully with new resolution');
  } catch (e) {
    const errMsg = `Resolution change failed: ${e.message}`;
    ErrorHandler.log('error', 'syncStreamSettings', errMsg, e);
    if (showStatus) {
      setStreamSettingsMessage(errMsg, 'error');
    }
  }
}

function updateStartButtonVisibility() {
  if (!startBtn) return;
  startBtn.style.display = thumbState.scanned ? '' : 'none';
}

function setRunningUI(running) {
  serverIsRunning = running;
  if (running) {
    statusPill.classList.remove('stopped');
    statusPill.classList.add('running');
    statusPill.textContent = 'Running';
  } else {
    statusPill.classList.remove('running');
    statusPill.classList.add('stopped');
    statusPill.textContent = 'Stopped';
  }
  startBtn.disabled  = running || !thumbState.ready || thumbState.generating;
  stopBtn.disabled   = !running;
  openAppBtn.disabled = !running || !currentUrl;
  updateStartButtonVisibility();
  updateAlgorithmModePill(effectiveEnhancedMode ? 'enhanced' : 'regular');
}

/* ══════════════════════════════════════════════════════════
   API helper – all requests go to oboukhov.com with
   credentials so the session cookie is included
═══════════════════════════════════════════════════════════ */
async function apiCall(method, path, body, retryCount = 0) {
  const MAX_RETRIES = NETWORK_RETRY_ATTEMPTS;
  const TIMEOUT = ERROR_TIMEOUT_MS;

  const makeRequest = async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT);

    try {
      const options = {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal
      };

      if (body !== undefined) {
        options.body = JSON.stringify(body);
      }

      const res = await fetch(`${API_BASE}${path}`, options);
      clearTimeout(timeoutId);

      let data = null;
      try {
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          data = await res.json();
        }
      } catch (parseError) {
        ErrorHandler.log('warn', 'apiCall', `JSON parse error for ${path}`, parseError);
      }

      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      clearTimeout(timeoutId);
      
      if (err.name === 'AbortError') {
        throw new Error(`Request timeout (${TIMEOUT}ms) for ${method} ${path}`);
      }
      throw err;
    }
  };

  try {
    const result = await makeRequest();
    ErrorHandler.log('info', 'apiCall', `${method} ${path} - Status ${result.status}`);
    return result;
  } catch (error) {
    const errorMessage = error.message || error.toString();
    ErrorHandler.log('error', 'apiCall', `${method} ${path} failed`, error);

    // Network/connection errors - retry
    const isNetworkError = errorMessage.includes('timeout') || 
                          errorMessage.includes('fetch') || 
                          errorMessage.includes('Failed to fetch');

    if (isNetworkError && retryCount < MAX_RETRIES) {
      ErrorHandler.log('warn', 'apiCall', `Retry attempt ${retryCount + 1}/${MAX_RETRIES} for ${path}`);
      await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1))); // Exponential backoff
      return apiCall(method, path, body, retryCount + 1);
    }

    return { ok: false, status: 0, data: { message: errorMessage }, error: error.message };
  }
}

// Validate response structure
function validateApiResponse(response, requiredFields = []) {
  if (!response || typeof response !== 'object') {
    ErrorHandler.log('warn', 'validateApiResponse', 'Response is not an object');
    return false;
  }

  for (const field of requiredFields) {
    if (!(field in response)) {
      ErrorHandler.log('warn', 'validateApiResponse', `Missing required field: ${field}`);
      return false;
    }
  }

  return true;
}

function persistAuthCache() {
  try {
    if (authState && authState.loggedIn) {
      const payload = {
        loggedIn: true,
        email: authState.email || null,
        userId: authState.userId || null,
        updatedAt: Date.now(),
      };
      localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(payload));
    } else {
      localStorage.removeItem(AUTH_CACHE_KEY);
    }
  } catch (e) {
    ErrorHandler.log('warn', 'persistAuthCache', 'Failed to persist auth cache', e);
  }
}

function restoreAuthStateFromCache() {
  try {
    const raw = localStorage.getItem(AUTH_CACHE_KEY);
    if (!raw) return false;
    const cached = JSON.parse(raw);
    if (!cached || !cached.loggedIn) return false;

    applyAuthState(true, cached.email || null, cached.userId || null, { persist: false });
    ErrorHandler.log('info', 'restoreAuthStateFromCache', `Restored cached auth for ${cached.email || 'user'}`);
    return true;
  } catch (e) {
    ErrorHandler.log('warn', 'restoreAuthStateFromCache', 'Failed to restore cached auth', e);
    return false;
  }
}

function persistProCache() {
  try {
    if (!authState || !authState.loggedIn) {
      localStorage.removeItem(PRO_CACHE_KEY);
      return;
    }
    const payload = {
      active: !!proState.active,
      monthsLeft: Math.max(0, Number(proState.monthsLeft || 0)),
      nextPaymentDue: proState.nextPaymentDue || null,
      checked: !!proState.checked,
      updatedAt: Date.now(),
    };
    localStorage.setItem(PRO_CACHE_KEY, JSON.stringify(payload));
  } catch (e) {
    ErrorHandler.log('warn', 'persistProCache', 'Failed to persist pro cache', e);
  }
}

function syncProStatusToServer() {
  if (!currentUrl || !serverIsRunning) return;
  try {
    fetch(currentUrl + '/api/pro-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !!proState.active }),
    }).catch(() => {});
  } catch {}
}

function restoreProStateFromCache() {
  try {
    const raw = localStorage.getItem(PRO_CACHE_KEY);
    if (!raw) return false;
    const cached = JSON.parse(raw);
    if (!cached || typeof cached !== 'object') return false;

    proState = {
      active: !!cached.active,
      monthsLeft: Math.max(0, Number(cached.monthsLeft || 0)),
      nextPaymentDue: cached.nextPaymentDue || null,
      checked: true,
    };
    ErrorHandler.log('info', 'restoreProStateFromCache', `Restored cached Pro state: active=${proState.active}`);
    return true;
  } catch (e) {
    ErrorHandler.log('warn', 'restoreProStateFromCache', 'Failed to restore pro cache', e);
    return false;
  }
}

/* ══════════════════════════════════════════════════════════
   Auth state – update UI to reflect signed-in / signed-out
═══════════════════════════════════════════════════════════ */
function applyAuthState(loggedIn, email, userId, options = {}) {
  authState = { loggedIn, email: email || null, userId: userId || null };

  if (loggedIn) {
    authSignedOut.style.display    = 'none';
    authSignedIn.style.display     = 'flex';
    authEmailLabel.textContent     = email || '';
    accountEmailDisplay.textContent = email || '';
    tabBtnAccount.disabled = false;
    tabBtnPro.disabled     = false;
  } else {
    authSignedOut.style.display = '';
    authSignedIn.style.display  = 'none';
    authEmailLabel.textContent  = '';
    tabBtnAccount.disabled = true;
    tabBtnPro.disabled     = false;
    // Redirect away from locked tabs
    if (activeTab === 'account') {
      switchTab('home');
    }
    try { localStorage.removeItem(PRO_CACHE_KEY); } catch {}
  }

  if (trialEmailInput) {
    trialEmailInput.value = email || '';
  }

  updateEnhancedAlgorithmUI();
  renderStreamSettingsUI();
  syncStreamSettingsToServer(false).catch(() => {});
  syncEnhancedModeToServer().catch(() => {});

  if (options.persist !== false) {
    persistAuthCache();
  }
}

async function checkSession(options = {}) {
  const preserveCachedOnFailure = !!options.preserveCachedOnFailure;
  try {
    const { ok, data } = await apiCall('GET', '/api/session');
    if (ok && data && data.loggedIn) {
      applyAuthState(true, data.email, data.userId);
    } else {
      if (preserveCachedOnFailure && authState.loggedIn) {
        ErrorHandler.log('warn', 'checkSession', 'Session not confirmed, preserving cached login state');
      } else {
        applyAuthState(false);
      }
    }
  } catch (e) {
    ErrorHandler.log('error', 'checkSession', 'Session check failed', e);
    if (preserveCachedOnFailure && authState.loggedIn) {
      ErrorHandler.log('warn', 'checkSession', 'Session request failed, keeping cached login state');
    } else {
      applyAuthState(false);
    }
  }

  try {
    await refreshProStatus();
  } catch (e) {
    ErrorHandler.log('error', 'checkSession', 'Pro status refresh failed', e);
  }
}

/* ══════════════════════════════════════════════════════════
   Tab switching
═══════════════════════════════════════════════════════════ */
function switchTab(tabName) {
  if (tabName === 'account' && !authState.loggedIn) return;

  activeTab = tabName;

  tabBtns.forEach(btn => {
    const isActive = btn.dataset.tab === tabName;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });

  Object.entries(tabPanels).forEach(([name, panel]) => {
    panel.style.display = name === tabName ? 'grid' : 'none';
  });

  if (tabName === 'pro') {
    refreshProStatus().finally(() => {
      loadProCourses();
    });
  }
}

function parseSubscriptionFlag(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return false;

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return false;
  if (['1', 'true', 'yes', 'active', 'paid'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'inactive', 'none', 'free'].includes(normalized)) return false;

  return Boolean(value);
}

function parseDateLabel(input) {
  if (!input) return 'N/A';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  return d.toLocaleDateString();
}

function calculateMonthsLeftFromDueDate(dueDateInput) {
  const dueDate = new Date(dueDateInput);
  if (Number.isNaN(dueDate.getTime())) return 0;

  const now = new Date();
  if (dueDate <= now) return 0;

  let months = (dueDate.getFullYear() - now.getFullYear()) * 12 + (dueDate.getMonth() - now.getMonth());

  // If there is any remaining partial month, count it as one month left.
  const anchor = new Date(now.getTime());
  anchor.setMonth(anchor.getMonth() + months);
  if (anchor < dueDate) {
    months += 1;
  }

  return Math.max(0, months);
}

function setProPromoVisibility() {
  const showPromo = !proState.active;
  if (trialHeroBanner) {
    trialHeroBanner.style.display = showPromo ? '' : 'none';
  }
}

function updateAccountSubscriptionUI() {
  if (!accountSubscriptionCard) return;

  const isActive = !!proState.active;
  accountSubscriptionCard.classList.toggle('active', isActive);
  accountSubscriptionCard.classList.toggle('inactive', !isActive);

  if (accountSubscriptionStatus) {
    accountSubscriptionStatus.textContent = isActive ? 'Active' : 'Inactive';
  }
  if (accountMonthsLeft) {
    accountMonthsLeft.textContent = String(isActive ? Math.max(0, Number(proState.monthsLeft || 0)) : 0);
  }
  if (accountNextPayment) {
    accountNextPayment.textContent = isActive ? parseDateLabel(proState.nextPaymentDue) : 'N/A';
  }
  if (accountSubscriptionNote) {
    accountSubscriptionNote.textContent = isActive
      ? 'Your Pro subscription is active.'
      : 'Subscription inactive. Start your 7-day free trial to unlock Pro features.';
  }
  if (accountCancelSubBtn) {
    accountCancelSubBtn.style.display = isActive && authState.loggedIn ? '' : 'none';
  }
  if (accountStartTrialBtn) {
    accountStartTrialBtn.style.display = isActive ? 'none' : '';
  }
}

function updateProTabUI() {
  if (proTitle) {
    proTitle.textContent = proState.active ? 'Pro Subscription Features' : 'Try Pro Free For 7 Days';
  }
  if (proSubtitle) {
    proSubtitle.textContent = proState.active
      ? 'You are subscribed. Enjoy all premium content and tools.'
      : 'Enter payment details to begin your free trial. Billing starts after 7 days unless cancelled.';
  }

  if (proTrialWall) {
    proTrialWall.style.display = proState.active ? 'none' : '';
  }

  if (proFeaturePreview) {
    proFeaturePreview.style.display = (!proState.active && proTrialStep === 'features') ? '' : 'none';
  }
  if (proPaymentScreen) {
    proPaymentScreen.style.display = (!proState.active && proTrialStep === 'payment') ? '' : 'none';
  }
  syncProStatusToServer();
}

function normalizeProStatus(data) {
  if (!data || typeof data !== 'object') {
    return { active: false };
  }

  const nested =
    (data.data && typeof data.data === 'object' ? data.data : null) ||
    (data.user && typeof data.user === 'object' ? data.user : null) ||
    (data.subscription && typeof data.subscription === 'object' ? data.subscription : null) ||
    null;

  const activeRaw =
    data.arcinitypro ??
    data.active ??
    data.pro ??
    data.status ??
    data.subscriptionActive ??
    (nested && (nested.arcinitypro ?? nested.active ?? nested.pro ?? nested.status ?? nested.subscriptionActive));
  const active = parseSubscriptionFlag(activeRaw);
  return { active };
}

function normalizeDueDate(data) {
  if (!data || typeof data !== 'object') return null;
  const due = data.due_date ?? data.dueDate ?? null;
  if (!due) return null;
  const parsed = new Date(due);
  if (Number.isNaN(parsed.getTime())) return null;
  return due;
}

async function refreshProStatus() {
  if (!authState.loggedIn) {
    proTrialStep = 'features';
    proState = { active: false, monthsLeft: 0, nextPaymentDue: null, checked: true };
    setProPromoVisibility();
    updateAccountSubscriptionUI();
    updateProTabUI();
    persistProCache();
    return;
  }

  try {
    const [statusRes, dueRes] = await Promise.all([
      apiCall('GET', '/api/arcinitypro-status').catch(e => {
        ErrorHandler.log('error', 'refreshProStatus', 'Status fetch failed', e);
        return { ok: false };
      }),
      apiCall('GET', '/api/due-date').catch(e => {
        ErrorHandler.log('error', 'refreshProStatus', 'Due date fetch failed', e);
        return { ok: false };
      })
    ]);

    const bothUnavailable = !(statusRes && statusRes.ok) && !(dueRes && dueRes.ok);
    if (bothUnavailable) {
      const restored = restoreProStateFromCache();
      if (restored) {
        ErrorHandler.log('warn', 'refreshProStatus', 'Using cached Pro state because status endpoints were unavailable');
        setProPromoVisibility();
        updateAccountSubscriptionUI();
        updateProTabUI();
        updateEnhancedAlgorithmUI();
        renderStreamSettingsUI();
        syncStreamSettingsToServer(false).catch(e => {
          ErrorHandler.log('warn', 'refreshProStatus', 'Stream settings sync failed', e);
        });
        syncEnhancedModeToServer().catch(e => {
          ErrorHandler.log('warn', 'refreshProStatus', 'Enhanced mode sync failed', e);
        });
        return;
      }
    }

    const statusNormalized = statusRes && statusRes.ok
      ? normalizeProStatus(statusRes.data)
      : { active: false };

    const nextPaymentDue = dueRes && dueRes.ok ? normalizeDueDate(dueRes.data) : null;
    const derivedFromDueDate = !!nextPaymentDue;
    const active = statusNormalized.active || derivedFromDueDate;
    const monthsLeft = nextPaymentDue ? calculateMonthsLeftFromDueDate(nextPaymentDue) : 0;

    proState = { active, monthsLeft, nextPaymentDue, checked: true };
    if (proState.active) {
      proTrialStep = 'features';
    }

    ErrorHandler.log('info', 'refreshProStatus', `Pro status: active=${active}, months=${monthsLeft}`);

    persistProCache();
  } catch (e) {
    ErrorHandler.log('error', 'refreshProStatus', 'Status refresh failed', e);
    const restored = restoreProStateFromCache();
    if (!restored) {
      proState = { active: false, monthsLeft: 0, nextPaymentDue: null, checked: true };
    }
  }

  setProPromoVisibility();
  updateAccountSubscriptionUI();
  updateProTabUI();
  updateEnhancedAlgorithmUI();
  renderStreamSettingsUI();
  syncStreamSettingsToServer(false).catch(e => {
    ErrorHandler.log('warn', 'refreshProStatus', 'Stream settings sync failed', e);
  });
  syncEnhancedModeToServer().catch(e => {
    ErrorHandler.log('warn', 'refreshProStatus', 'Enhanced mode sync failed', e);
  });
}

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    if (!btn.disabled) switchTab(btn.dataset.tab);
  });
});

/* ══════════════════════════════════════════════════════════
   Modal – open / close / mode
═══════════════════════════════════════════════════════════ */
function openModal(mode = 'signin') {
  authModal.style.display = 'flex';
  setModalMode(mode);
  signinError.textContent = '';
  signupError.textContent = '';
}

function closeModal() {
  authModal.style.display = 'none';
}

function setModalMode(mode) {
  modalTabs.forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  signinForm.style.display = mode === 'signin' ? '' : 'none';
  signupForm.style.display = mode === 'signup' ? '' : 'none';
}

signinBtn.addEventListener('click', () => openModal('signin'));
modalCloseBtn.addEventListener('click', closeModal);
authModal.addEventListener('click', e => { if (e.target === authModal) closeModal(); });
modalTabs.forEach(tab => tab.addEventListener('click', () => setModalMode(tab.dataset.mode)));

// Close modal on Escape key
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && authModal.style.display !== 'none') closeModal();
});

/* ══════════════════════════════════════════════════════════
   Sign In
═══════════════════════════════════════════════════════════ */
signinForm.addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const email    = document.getElementById('signin-email').value.trim();
    const password = document.getElementById('signin-password').value;
    
    if (!email || !password) {
      signinError.textContent = 'Please enter your email and password.';
      return;
    }

    if (!email.includes('@')) {
      signinError.textContent = 'Please enter a valid email address.';
      ErrorHandler.log('warn', 'signin', 'Invalid email format');
      return;
    }

    signinError.textContent = '';
    const btn = document.getElementById('signin-submit-btn');
    btn.disabled = true;
    btn.textContent = 'Signing in…';

    try {
      const { ok, data } = await apiCall('POST', '/api/signin', { email, password });
      if (ok) {
        await checkSession();
        closeModal();
        switchTab('pro');
        await loadProCourses();
        ErrorHandler.log('info', 'signin', `Signed in successfully: ${email}`);
      } else {
        const msg = (data && data.message) || 'Sign in failed - please check your credentials';
        signinError.textContent = msg;
        ErrorHandler.log('warn', 'signin', `Sign in failed: ${msg}`);
      }
    } catch (netErr) {
      signinError.textContent = 'Network error – please check your connection and try again.';
      ErrorHandler.log('error', 'signin', 'Network error during sign in', netErr);
    }
  } catch (e) {
    signinError.textContent = `Sign in error: ${e.message}`;
    ErrorHandler.log('error', 'signin', 'Sign in error', e);
  } finally {
    const btn = document.getElementById('signin-submit-btn');
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
});

/* ══════════════════════════════════════════════════════════
   Sign Up
═══════════════════════════════════════════════════════════ */
signupForm.addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const signupEmail    = document.getElementById('signup-email').value.trim();
    const signupPassword = document.getElementById('signup-password').value;
    
    if (!signupEmail || !signupPassword) {
      signupError.textContent = 'Please fill in all fields.';
      return;
    }

    if (!signupEmail.includes('@')) {
      signupError.textContent = 'Please enter a valid email address.';
      ErrorHandler.log('warn', 'signup', 'Invalid email format');
      return;
    }

    if (signupPassword.length < 6) {
      signupError.textContent = 'Password must be at least 6 characters.';
      return;
    }

    signupError.textContent = '';
    const btn = document.getElementById('signup-submit-btn');
    btn.disabled = true;
    btn.textContent = 'Creating account…';

    try {
      const { ok, data } = await apiCall('POST', '/api/signup', { signupEmail, signupPassword });
      if (ok) {
        await checkSession();
        closeModal();
        switchTab('pro');
        await loadProCourses();
        ErrorHandler.log('info', 'signup', `Account created successfully: ${signupEmail}`);
      } else {
        const msg = (data && data.message) || 'Sign up failed - please try a different email';
        signupError.textContent = msg;
        ErrorHandler.log('warn', 'signup', `Sign up failed: ${msg}`);
      }
    } catch (netErr) {
      signupError.textContent = 'Network error – please check your connection and try again.';
      ErrorHandler.log('error', 'signup', 'Network error during sign up', netErr);
    }
  } catch (e) {
    signupError.textContent = `Sign up error: ${e.message}`;
    ErrorHandler.log('error', 'signup', 'Sign up error', e);
  } finally {
    const btn = document.getElementById('signup-submit-btn');
    btn.disabled = false;
    btn.textContent = 'Create Account';
  }
});

/* ══════════════════════════════════════════════════════════
   Sign Out
═══════════════════════════════════════════════════════════ */
signoutBtn.addEventListener('click', async () => {
  try { await apiCall('POST', '/api/logout'); } catch { /* ignore */ }
  applyAuthState(false);
  await refreshProStatus();
});

if (trialHeroCta) {
  trialHeroCta.addEventListener('click', async () => {
    if (!authState.loggedIn) {
      openModal('signin');
      return;
    }
    switchTab('pro');
  });
}

if (accountStartTrialBtn) {
  accountStartTrialBtn.addEventListener('click', async () => {
    switchTab('pro');
    proTrialStep = 'payment';
    updateProTabUI();
  });
}

if (proBeginTrialBtn) {
  proBeginTrialBtn.addEventListener('click', () => {
    if (!authState.loggedIn) {
      openModal('signin');
      return;
    }
    proTrialStep = 'payment';
    updateProTabUI();
  });
}

if (proBackToFeaturesBtn) {
  proBackToFeaturesBtn.addEventListener('click', () => {
    proTrialStep = 'features';
    updateProTabUI();
  });
}

if (accountCancelSubBtn) {
  accountCancelSubBtn.addEventListener('click', async () => {
    await cancelSubscriptionFromUI(accountSubscriptionNote);
  });
}

if (proTrialForm) {
  proTrialForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('pro-start-trial-btn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Starting Trial…';
    }
    await startFreeTrialFromUI(proTrialMsg);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Start Free Trial';
    }
  });
}

/* ══════════════════════════════════════════════════════════
   Deep Learning Indexer – logic
═══════════════════════════════════════════════════════════ */

const DL_STAGE_LABELS = {
  extracting_audio:  'Extracting audio track…',
  extracting_frame:  'Extracting keyframe…',
  transcribing:      'Running speech-to-text (Whisper)…',
  visual_embedding:  'Computing visual embedding…',
  audio_features:    'Analysing audio features…',
  starting:          'Starting…',
  complete:          'Done',
};

function setDlMessage(text, kind) {
  if (!dlMessageEl) return;
  dlMessageEl.textContent = text || '';
  dlMessageEl.style.color =
    kind === 'error'   ? '#fca5a5' :
    kind === 'success' ? '#6ee7b7' : '#f7c15a';
}

function persistEnhancedAlgoPreference(enabled) {
  enhancedAlgorithmPreference = !!enabled;
  try {
    localStorage.setItem('arcinity-enhanced-algo', enhancedAlgorithmPreference ? '1' : '0');
  } catch {}
}

function canUseEnhancedAlgorithm() {
  return Boolean(
    authState.loggedIn &&
    proState.active &&
    dlState.scanned &&
    dlState.total > 0 &&
    dlState.pending === 0
  );
}

function getDesiredEnhancedMode() {
  return canUseEnhancedAlgorithm() && enhancedAlgorithmPreference;
}

async function syncEnhancedModeToServer() {
  if (!serverIsRunning) {
    effectiveEnhancedMode = getDesiredEnhancedMode();
    updateAlgorithmModePill(effectiveEnhancedMode ? 'enhanced' : 'regular');
    return effectiveEnhancedMode;
  }

  const desired = getDesiredEnhancedMode();
  try {
    const result = await window.arcinityAPI.setServerRecommendationMode({
      enhancedEnabled: desired,
    });

    const rawEnabled =
      result && result.ok && result.data && typeof result.data.enhancedEnabled === 'boolean'
        ? result.data.enhancedEnabled
        : result && result.ok && result.data && result.data.data && typeof result.data.data.enhancedEnabled === 'boolean'
          ? result.data.data.enhancedEnabled
          : desired;
    const enabled = !!rawEnabled;
    effectiveEnhancedMode = enabled;
    updateAlgorithmModePill(enabled ? 'enhanced' : 'regular');
    return enabled;
  } catch {
    effectiveEnhancedMode = desired;
    updateAlgorithmModePill(effectiveEnhancedMode ? 'enhanced' : 'regular');
    return effectiveEnhancedMode;
  }
}

async function restartServerForModeChange() {
  if (!serverIsRunning) {
    await syncEnhancedModeToServer();
    return;
  }

  const payload = {
    videoSourceDir: videoFolderInput.value,
    port: Number(portInput.value),
  };

  updateAlgorithmModePill('restarting');
  setMessage('Applying algorithm change… restarting server.', 'info');

  await window.arcinityAPI.stopServer();
  currentUrl = '';
  currentLanUrl = '';
  setRunningUI(false);

  const restartResult = await window.arcinityAPI.startServer(payload);
  if (!restartResult || !restartResult.ok) {
    effectiveEnhancedMode = false;
    updateAlgorithmModePill('regular');
    setMessage((restartResult && restartResult.error) || 'Failed to restart server after algorithm change.', 'error');
    return;
  }

  currentUrl = restartResult.url;
  currentLanUrl = restartResult.lanUrl || '';
  setRunningUI(true);
  await syncEnhancedModeToServer();

  const modeLabel = effectiveEnhancedMode ? 'Enhanced AI' : 'Regular';
  const phoneHint = currentLanUrl ? ` | Phone: ${currentLanUrl}` : '';
  setMessage(`Server restarted in ${modeLabel} mode.${phoneHint}`, 'success');
}

function updateEnhancedAlgorithmUI() {
  if (!dlEnhancedModeWrap || !dlEnhancedModeToggle) return;

  const isVisible = authState.loggedIn && proState.active;
  dlEnhancedModeWrap.style.display = isVisible ? '' : 'none';
  if (!isVisible) return;

  const eligible = canUseEnhancedAlgorithm();
  const checked = eligible && enhancedAlgorithmPreference;
  dlEnhancedModeToggle.disabled = !eligible;
  dlEnhancedModeToggle.checked = checked;

  if (!dlEnhancedModeNote) return;
  if (!authState.loggedIn) {
    dlEnhancedModeNote.textContent = 'Sign in to enable enhanced recommendations.';
  } else if (!proState.active) {
    dlEnhancedModeNote.textContent = 'Requires an active Pro subscription.';
  } else if (!dlState.scanned || dlState.total === 0) {
    dlEnhancedModeNote.textContent = 'Scan and index your catalog first.';
  } else if (dlState.pending > 0) {
    dlEnhancedModeNote.textContent = `Finish indexing all videos first (${dlState.pending} pending).`;
  } else {
    dlEnhancedModeNote.textContent = 'Uses indexed Deep Learning data instead of pseudo features for recommendations.';
  }
}

function updateDlUI() {
  const { scanned, total, indexed, pending, running } = dlState;

  // Status pill
  if (dlStatusPill) {
    dlStatusPill.className = 'dl-pill';
    if (!scanned) {
      dlStatusPill.textContent = 'Not Indexed';
      dlStatusPill.classList.add('dl-pill-unknown');
    } else if (running) {
      dlStatusPill.textContent = 'Indexing…';
      dlStatusPill.classList.add('dl-pill-running');
    } else if (pending === 0) {
      dlStatusPill.textContent = 'Fully Indexed ✓';
      dlStatusPill.classList.add('dl-pill-ready');
    } else {
      dlStatusPill.textContent = `${pending} Pending`;
      dlStatusPill.classList.add('dl-pill-warn');
    }
  }

  // Stats strip
  if (dlStats) dlStats.style.display = scanned ? '' : 'none';
  if (dlTotalEl)   dlTotalEl.textContent   = String(total);
  if (dlIndexedEl) dlIndexedEl.textContent = String(indexed);
  if (dlPendingEl) dlPendingEl.textContent = String(pending);

  // Progress wrap
  if (dlProgressWrap) dlProgressWrap.style.display = running ? '' : 'none';
  if (dlCancelBtn) dlCancelBtn.style.display = running ? '' : 'none';

  // Run button
  if (dlRunBtn) {
    if (running) {
      dlRunBtn.disabled = true;
      dlRunBtn.textContent = 'Indexing…';
    } else if (!scanned) {
      dlRunBtn.disabled = true;
      dlRunBtn.textContent = 'Scan Folder First';
    } else if (pending === 0) {
      dlRunBtn.disabled = false;
      dlRunBtn.textContent = 'All Videos Indexed ✓';
    } else {
      dlRunBtn.disabled = false;
      dlRunBtn.textContent = `Index ${pending} Video${pending !== 1 ? 's' : ''}`;
    }
  }

  // Re-index button (only useful when something is indexed)
  if (dlReindexBtn) {
    dlReindexBtn.style.display = (scanned && indexed > 0 && !running) ? '' : 'none';
  }

  updateEnhancedAlgorithmUI();
}

async function deeplearnScan() {
  try {
    const folder = videoFolderInput.value.trim();
    if (!folder || !dlState.outputPath) {
      dlState = { ...dlState, scanned: false, total: 0, indexed: 0, pending: 0 };
      setDlMessage('📁 Select a video folder in the Home tab to begin indexing.', 'info');
      updateDlUI();
      return;
    }

    setDlMessage('⏳ Scanning your video folder…');
    ErrorHandler.log('info', 'deeplearnScan', `Starting scan for folder: ${folder}`);

    let result;
    try {
      result = await window.arcinityAPI.deepLearnScan({
        videoSourceDir: folder,
        outputPath: dlState.outputPath,
      });
    } catch (e) {
      throw new Error(`Scan API error: ${e.message}`);
    }

    if (!result || !result.ok) {
      const errMsg = (result && result.error) || 'Scan failed - please check folder path and permissions';
      setDlMessage(errMsg, 'error');
      ErrorHandler.log('error', 'deeplearnScan', errMsg);
      dlState = { ...dlState, scanned: false };
      updateDlUI();
      return;
    }

    dlState = { ...dlState, scanned: true, total: result.total, indexed: result.indexed, pending: result.pending };
    
    if (result.total === 0) {
      setDlMessage('📁 No videos found in the selected folder.', 'error');
      ErrorHandler.log('warn', 'deeplearnScan', 'No videos found in folder');
    } else if (result.pending === 0) {
      setDlMessage(`✅ All ${result.total} video${result.total !== 1 ? 's' : ''} indexed! Smart recommendations enabled.`, 'success');
      ErrorHandler.log('info', 'deeplearnScan', `Scan complete: ${result.total} videos, all indexed`);
    } else {
      const pctDone = ((result.indexed / result.total) * 100).toFixed(0);
      setDlMessage(`📊 Found ${result.total} video${result.total !== 1 ? 's' : ''}. ${result.indexed} indexed (${pctDone}%). ${result.pending} ready to process.`);
      ErrorHandler.log('info', 'deeplearnScan', `Scan complete: ${result.total} total, ${result.indexed} indexed, ${result.pending} pending`);
    }

    updateDlUI();
    await syncEnhancedModeToServer();
  } catch (e) {
    const errMsg = `Deep learning scan error: ${e.message}`;
    setDlMessage(errMsg, 'error');
    ErrorHandler.log('error', 'deeplearnScan', errMsg, e);
    dlState = { ...dlState, scanned: false };
    updateDlUI();
  }
}

function applyDepStatus(deps, python) {
  if (!dlDepPanel) return;
  dlDepPanel.style.display = '';

  const setDep = (icon, label, ok, detail) => {
    if (icon) {
      icon.textContent = ok ? '✓' : '✗';
      icon.className = `dl-dep-icon ${ok ? 'dl-dep-ok' : 'dl-dep-missing'}`;
    }
    if (label) label.textContent = detail;
  };

  const hasWhisper  = deps.faster_whisper || deps.whisper;
  const hasVisual   = deps.torch && (deps.transformers || deps.PIL);
  const hasAudio    = deps.librosa || (deps.numpy && deps.scipy);

  setDep(dlDepPythonIcon,  dlDepPythonLabel,  !!python, python ? `${python}` : 'Not found — install Python 3.8+');
  setDep(dlDepWhisperIcon, dlDepWhisperLabel, hasWhisper,
         deps.faster_whisper ? 'faster-whisper ✔' : deps.whisper ? 'openai-whisper ✔' : 'Not installed');
  setDep(dlDepVisualIcon,  dlDepVisualLabel,  hasVisual,
         deps.transformers && deps.torch ? 'CLIP + torch ✔' : deps.torch ? 'torch (MobileNetV3) ✔' : 'Not installed — histogram fallback');
  setDep(dlDepAudioIcon,   dlDepAudioLabel,   hasAudio,
         deps.librosa ? 'librosa ✔' : deps.numpy ? 'numpy fallback ✔' : 'Not installed');

  dlState.hasMissingDeps = !(hasWhisper && hasVisual && hasAudio);
  if (dlInstallBtn) dlInstallBtn.style.display = dlState.hasMissingDeps ? '' : 'none';
  dlState.depsChecked = true;
  dlState.depsOk = !!python;
}

if (dlCheckDepsBtn) {
  dlCheckDepsBtn.addEventListener('click', async () => {
    dlCheckDepsBtn.disabled = true;
    dlCheckDepsBtn.textContent = '⏳ Checking…';
    setDlMessage('');
    if (dlDepPanel) dlDepPanel.style.display = '';
    // Reset icons to spinning state
    for (const el of [dlDepPythonIcon, dlDepWhisperIcon, dlDepVisualIcon, dlDepAudioIcon]) {
      if (el) { el.textContent = '⋯'; el.className = 'dl-dep-icon dl-dep-unknown'; }
    }
    try {
      const result = await window.arcinityAPI.deepLearnCheckDeps();
      if (!result.ok && !result.deps) {
        setDlMessage('❌ ' + (result.error || 'Could not check dependencies. Make sure Python 3.8+ is installed.'), 'error');
        if (dlDepPythonIcon) { dlDepPythonIcon.textContent = '✗'; dlDepPythonIcon.className = 'dl-dep-icon dl-dep-missing'; }
        if (dlDepPythonLabel) dlDepPythonLabel.textContent = result.error || 'Python 3.8+ not found';
      } else {
        applyDepStatus(result.deps || {}, result.python || null);
        if (dlState.hasMissingDeps) {
          setDlMessage('⚙️  Some ML packages missing. Click "Install ML Packages" to auto-download (~2-5 min with GPU, ~10-15 min on CPU).');
        } else {
          let msg = '✅ Ready to index! All dependencies installed.';
          if (result.deps && result.deps.gpu_available && result.deps.gpu_device) {
            msg += ` 🚀 GPU detected (${result.deps.gpu_device}) — processing will be ~5-10× faster!`;
          } else if (result.deps && !result.deps.gpu_available) {
            msg += ' 💡 No GPU detected, using CPU mode (works fine, just slower).';
          }
          setDlMessage(msg, 'success');
        }
      }
    } catch (e) {
      setDlMessage('⚠️  Dependency check failed: ' + e.message, 'error');
    } finally {
      dlCheckDepsBtn.disabled = false;
      dlCheckDepsBtn.textContent = 'Check Dependencies';
    }
  });
}

if (dlInstallBtn) {
  dlInstallBtn.addEventListener('click', async () => {
    dlInstallBtn.disabled = true;
    dlInstallBtn.textContent = '⏳ Installing…';
    if (dlInstallLog) dlInstallLog.style.display = 'none';
    setDlMessage('📦 Downloading ML packages (faster-whisper, torch, transformers, librosa)…\nThis takes 2-5 min with GPU access, ~10-15 min on slower connections. Please wait…');
    try {
      const result = await window.arcinityAPI.deepLearnInstallDeps();
      if (dlInstallLog) {
        dlInstallLog.style.display = '';
        dlInstallLog.textContent = result.log || result.message || 'Installation output not available';
      }
      if (result.ok) {
        setDlMessage('✅ ML packages installed! Click "Check Dependencies" to verify and see your system specs.', 'success');
      } else {
        setDlMessage('⚠️  Installation finished with some errors. Check the log above. You may still be able to index videos.', 'error');
      }
    } catch (e) {
      setDlMessage('❌ Install error: ' + e.message, 'error');
    } finally {
      dlInstallBtn.disabled = false;
      dlInstallBtn.textContent = 'Install ML Packages';
    }
  });
}

async function runDeepLearning(reindex = false) {
  try {
    const folder = videoFolderInput.value.trim();
    if (!folder) {
      setDlMessage('📁 Select a video folder first in the Home tab.', 'error');
      ErrorHandler.log('warn', 'runDeepLearning', 'No video folder selected');
      return;
    }
    if (!dlState.outputPath) {
      setDlMessage('Output path not resolved.', 'error');
      ErrorHandler.log('error', 'runDeepLearning', 'Output path not resolved');
      return;
    }

    dlState.running = true;
    if (dlProgressBar)  dlProgressBar.style.width  = '0%';
    if (dlProgressText) dlProgressText.textContent  = '⏳ Initializing AI models…';
    const qualityText = {'fast': 'Fast (5-10s/video)', 'balanced': 'Balanced (30-50s/video)', 'quality': 'Highest Quality (50+s/video)'}[dlState.selectedQuality] || dlState.selectedQuality;
    if (dlStageText)    dlStageText.textContent      = `Quality: ${qualityText} — First run loads ML models (~30-60s), then processes videos. You can cancel anytime.`;
    setDlMessage('');
    updateDlUI();

    ErrorHandler.log('info', 'runDeepLearning', `Starting deep learn indexing: quality=${dlState.selectedQuality}, reindex=${reindex}`);

    let result;
    try {
      result = await window.arcinityAPI.deepLearnRun({
        videoSourceDir: folder,
        outputPath: dlState.outputPath,
        reindex,
        quality: dlState.selectedQuality,
        skipSpeech: false,
        visualMode: null,
      });
    } catch (e) {
      result = { ok: false, error: `API call failed: ${e.message}` };
      ErrorHandler.log('error', 'runDeepLearning', `Deep learn run API error`, e);
    }

    dlState.running = false;
    if (dlProgressWrap) dlProgressWrap.style.display = 'none';

    if (result && result.cancelled) {
      setDlMessage('⏹️  Indexing cancelled. Your progress was saved — you can resume later.');
      ErrorHandler.log('info', 'runDeepLearning', 'Indexing was cancelled by user');
    } else if (!result || !result.ok) {
      const errMsg = (result && result.error) || 'Indexing failed - please check logs';
      ErrorHandler.log('error', 'runDeepLearning', `Indexing failed: ${errMsg}`);

      if (errMsg.toLowerCase().includes('python')) {
        setDlMessage('❌ ' + errMsg + ' — Please install Python 3.8+ from python.org and restart the launcher.', 'error');
      } else if (errMsg.toLowerCase().includes('out of memory') || errMsg.toLowerCase().includes('cuda')) {
        setDlMessage('⚠️  GPU memory issue. Try the "Fast" preset or run on a computer with more VRAM. Details: ' + errMsg, 'error');
      } else if (errMsg.toLowerCase().includes('codec') || errMsg.toLowerCase().includes('format')) {
        setDlMessage('⚠️  Video format issue: ' + errMsg + ' Check that your videos are in MP4 or WebM format.', 'error');
      } else {
        setDlMessage('❌ ' + errMsg, 'error');
      }
    } else {
      const d = result.data || {};
      const errNote = d.errors > 0 ? ` (⚠️  ${d.errors} skipped)` : '';
      setDlMessage(`✅ Indexed ${d.done} video${d.done !== 1 ? 's' : ''}${errNote}. Smart recommendations now enabled!`, 'success');
      ErrorHandler.log('info', 'runDeepLearning', `Indexing complete: ${d.done} indexed, ${d.errors} errors`);
    }

    await deeplearnScan();
  } catch (e) {
    dlState.running = false;
    if (dlProgressWrap) dlProgressWrap.style.display = 'none';
    const errMsg = `Deep learning error: ${e.message}`;
    setDlMessage(errMsg, 'error');
    ErrorHandler.log('error', 'runDeepLearning', errMsg, e);
    updateDlUI();
  }
}

if (dlRunBtn) {
  dlRunBtn.addEventListener('click', () => runDeepLearning(false));
}

if (dlReindexBtn) {
  dlReindexBtn.addEventListener('click', () => runDeepLearning(true));
}

if (dlCancelBtn) {
  dlCancelBtn.addEventListener('click', async () => {
    dlCancelBtn.disabled = true;
    try { await window.arcinityAPI.deepLearnCancel(); } catch {}
    dlCancelBtn.disabled = false;
  });
}

if (dlEnhancedModeToggle) {
  dlEnhancedModeToggle.addEventListener('change', async () => {
    persistEnhancedAlgoPreference(dlEnhancedModeToggle.checked);
    effectiveEnhancedMode = getDesiredEnhancedMode();
    updateAlgorithmModePill(effectiveEnhancedMode ? 'enhanced' : 'regular');
    updateEnhancedAlgorithmUI();
    await restartServerForModeChange();
  });
}

if (streamApplyBtn) {
  streamApplyBtn.addEventListener('click', async () => {
    renderStreamSettingsUI();
    await syncStreamSettingsToServer(true);
  });
}

// Quality selector buttons
if (dlQualityFastBtn) {
  dlQualityFastBtn.addEventListener('click', () => {
    dlState.selectedQuality = 'fast';
    updateQualityButtons();
  });
}

if (dlQualityBalancedBtn) {
  dlQualityBalancedBtn.addEventListener('click', () => {
    dlState.selectedQuality = 'balanced';
    updateQualityButtons();
  });
}

if (dlQualityQualityBtn) {
  dlQualityQualityBtn.addEventListener('click', () => {
    dlState.selectedQuality = 'quality';
    updateQualityButtons();
  });
}

function updateQualityButtons() {
  const buttons = [dlQualityFastBtn, dlQualityBalancedBtn, dlQualityQualityBtn];
  buttons.forEach(btn => {
    if (btn) {
      const isActive = btn.dataset.quality === dlState.selectedQuality;
      btn.classList.toggle('btn-quality-active', isActive);
    }
  });
}

window.arcinityAPI.onDeepLearnProgress((data) => {
  if (!dlState.running) return;
  const { type, done, total, current, stage, errors = 0 } = data;

  const stageEmoji = {
    'extracting_audio': '🎵 ',
    'extracting_frame': '🖼️  ',
    'transcribing': '💬 ',
    'visual_embedding': '🎨 ',
    'audio_features': '📊 ',
    'complete': '✅ '
  };

  if (type === 'scan_result') {
    if (dlProgressText) dlProgressText.textContent = `📁 Preparing ${data.to_process} videos…`;
    return;
  }
  if (type === 'status') {
    if (dlProgressText) dlProgressText.textContent = data.message || '';
    return;
  }
  if (type === 'stage') {
    const emoji = stageEmoji[data.stage] || '⚙️  ';
    if (dlStageText) dlStageText.textContent = emoji + (DL_STAGE_LABELS[data.stage] || data.stage);
    return;
  }
  if (type === 'log') {
    // stderr lines from Python – ignore silently
    return;
  }
  if (type === 'progress' && total > 0) {
    const pct = Math.round((done / total) * 100);
    if (dlProgressBar)  dlProgressBar.style.width  = `${pct}%`;
    const errText = errors > 0 ? ` ⚠️  (${errors} error${errors !== 1 ? 's' : ''})` : '';
    if (dlProgressText) dlProgressText.textContent = `${done} / ${total}${errText}`;
    if (dlStageText && current) {
      const emoji = stageEmoji[stage] || '⚙️  ';
      dlStageText.textContent = `${emoji}${DL_STAGE_LABELS[stage] || stage} — ${current.split('/').pop()}`;
    }
    // Live-update indexed counter
    if (dlIndexedEl) {
      dlIndexedEl.textContent = String(Math.min(dlState.total, dlState.indexed + done - errors));
    }
    return;
  }
  if (type === 'done') {
    if (dlProgressBar)  dlProgressBar.style.width  = '100%';
    if (dlProgressText) dlProgressText.textContent = `✅ Done (${data.done}/${data.total})`;
    if (dlStageText)    dlStageText.textContent     = '🎉 Processing complete!';
  }
});

window.arcinityAPI.onDeepLearnInstallLog((data) => {
  if (!dlInstallLog) return;
  dlInstallLog.textContent += data.line + '\n';
  dlInstallLog.scrollTop = dlInstallLog.scrollHeight;
});

/* ══════════════════════════════════════════════════════════
   Account – helper
═══════════════════════════════════════════════════════════ */
function setAccountMsg(el, text, kind) {
  el.textContent = text;
  el.className   = 'account-msg' + (kind ? ' ' + kind : '');
  if (text) {
    setTimeout(() => {
      el.textContent = '';
      el.className   = 'account-msg';
    }, 5000);
  }
}

/* ══════════════════════════════════════════════════════════
   Account – Update Email
═══════════════════════════════════════════════════════════ */
updateEmailBtn.addEventListener('click', async () => {
  const newEmail = newEmailInput.value.trim();
  if (!newEmail) {
    setAccountMsg(emailUpdateMsg, 'Please enter a new email address.', 'error');
    return;
  }
  updateEmailBtn.disabled = true;
  updateEmailBtn.textContent = 'Saving…';
  try {
    const { ok, data } = await apiCall('POST', '/api/update-account', { newEmail });
    if (ok) {
      setAccountMsg(emailUpdateMsg, (data && data.message) || 'Email updated successfully.', 'success');
      authEmailLabel.textContent     = newEmail;
      accountEmailDisplay.textContent = newEmail;
      authState.email = newEmail;
      newEmailInput.value = '';
    } else {
      setAccountMsg(emailUpdateMsg, (data && data.message) || 'Failed to update email.', 'error');
    }
  } catch {
    setAccountMsg(emailUpdateMsg, 'Network error – please try again.', 'error');
  } finally {
    updateEmailBtn.disabled = false;
    updateEmailBtn.textContent = 'Save Email';
  }
});

/* ══════════════════════════════════════════════════════════
   Account – Change Password
═══════════════════════════════════════════════════════════ */
updatePasswordBtn.addEventListener('click', async () => {
  const currentPassword = currentPasswordInput.value;
  const newPassword     = newPasswordInput.value;
  if (!currentPassword || !newPassword) {
    setAccountMsg(passwordUpdateMsg, 'Both password fields are required.', 'error');
    return;
  }
  updatePasswordBtn.disabled = true;
  updatePasswordBtn.textContent = 'Saving…';
  try {
    const { ok, data } = await apiCall('POST', '/api/update-account', { currentPassword, newPassword });
    if (ok) {
      setAccountMsg(passwordUpdateMsg, (data && data.message) || 'Password updated successfully.', 'success');
      currentPasswordInput.value = '';
      newPasswordInput.value     = '';
    } else {
      setAccountMsg(passwordUpdateMsg, (data && data.message) || 'Failed to update password.', 'error');
    }
  } catch {
    setAccountMsg(passwordUpdateMsg, 'Network error – please try again.', 'error');
  } finally {
    updatePasswordBtn.disabled = false;
    updatePasswordBtn.textContent = 'Change Password';
  }
});

/* ══════════════════════════════════════════════════════════
   PRO – Load owned courses
═══════════════════════════════════════════════════════════ */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadProCourses() {
  updateProTabUI();
  renderStreamSettingsUI();

  if (!authState.loggedIn) {
    if (proSignedOutMsg)     proSignedOutMsg.style.display     = '';
    if (proDeepLearnSection) proDeepLearnSection.style.display = 'none';
    updateEnhancedAlgorithmUI();
    return;
  }

  if (!proState.active) {
    if (proSignedOutMsg)     proSignedOutMsg.style.display     = 'none';
    if (proDeepLearnSection) proDeepLearnSection.style.display = 'none';
    updateEnhancedAlgorithmUI();
    return;
  }

  if (proSignedOutMsg)     proSignedOutMsg.style.display     = 'none';
  if (proDeepLearnSection) proDeepLearnSection.style.display = '';

  // Resolve output path once
  if (!dlState.outputPath) {
    try {
      const { outputPath } = await window.arcinityAPI.deepLearnGetDataPath();
      dlState.outputPath = outputPath || null;
    } catch {}
  }

  // Auto-scan if we have a folder
  await deeplearnScan();
  updateEnhancedAlgorithmUI();
  renderStreamSettingsUI();
  await syncStreamSettingsToServer(false);
}

async function startFreeTrialFromUI(messageTarget) {
  if (!authState.loggedIn) {
    if (messageTarget) setAccountMsg(messageTarget, 'Sign in first to start your free trial.', 'error');
    openModal('signin');
    return;
  }

  const payload = {
    name: (trialNameInput && trialNameInput.value.trim()) || '',
    email: (trialEmailInput && trialEmailInput.value.trim()) || authState.email || '',
    cardNumber: (trialCardInput && trialCardInput.value.trim()) || '',
    exp: (trialExpInput && trialExpInput.value.trim()) || '',
    cvc: (trialCvcInput && trialCvcInput.value.trim()) || ''
  };

  try {
    const { ok, data } = await apiCall('POST', '/api/arcinitypro-start-trial', payload);
    if (!ok) {
      setAccountMsg(messageTarget, (data && data.message) || 'Unable to start trial. Please try again.', 'error');
      return;
    }

    if (data && data.checkoutUrl) {
      await window.arcinityAPI.openBrowser(data.checkoutUrl);
      setAccountMsg(messageTarget, 'Secure Stripe checkout opened in your browser.', 'success');
    } else {
      setAccountMsg(messageTarget, 'Trial started successfully.', 'success');
    }

    await refreshProStatus();
    if (activeTab === 'pro') loadProCourses();
  } catch {
    setAccountMsg(messageTarget, 'Network error while starting trial.', 'error');
  }
}

async function cancelSubscriptionFromUI(messageTarget) {
  try {
    const { ok, data } = await apiCall('POST', '/api/arcinitypro-cancel');
    if (!ok) {
      setAccountMsg(messageTarget, (data && data.message) || 'Could not cancel subscription.', 'error');
      return;
    }
    setAccountMsg(messageTarget, 'Subscription canceled. Access remains until the end of billing period.', 'success');
    await refreshProStatus();
    if (activeTab === 'pro') loadProCourses();
  } catch {
    setAccountMsg(messageTarget, 'Network error while cancelling subscription.', 'error');
  }
}

/* ══════════════════════════════════════════════════════════
  Thumbnails – logic
═══════════════════════════════════════════════════════════ */
  function setThumbsMessage(text, kind) {
    if (!thumbsMessageEl) return;
    thumbsMessageEl.textContent = text || '';
    thumbsMessageEl.style.color =
      kind === 'error'   ? '#fca5a5' :
      kind === 'success' ? '#6ee7b7' : '#f7c15a';
  }

  function updateThumbsUI() {
    const { scanned, total, existing, missing, failed, generating, ready } = thumbState;
    if (scanned && thumbsStats) {
      thumbsStats.style.display = '';
      if (thumbsTotalEl)    thumbsTotalEl.textContent    = String(total);
      if (thumbsExistingEl) thumbsExistingEl.textContent = String(existing);
      if (thumbsMissingEl)  thumbsMissingEl.textContent  = String(missing);
    } else if (thumbsStats) {
      thumbsStats.style.display = 'none';
    }
    if (thumbsStatusPill) {
      thumbsStatusPill.className = 'thumbs-pill';
      if (!scanned) {
        thumbsStatusPill.textContent = 'Not Scanned';
        thumbsStatusPill.classList.add('thumbs-unknown');
      } else if (generating) {
        thumbsStatusPill.textContent = 'Generating\u2026';
        thumbsStatusPill.classList.add('thumbs-generating');
      } else if (ready || missing === 0) {
        thumbsStatusPill.textContent = 'Ready \u2713';
        thumbsStatusPill.classList.add('thumbs-ready');
      } else {
        thumbsStatusPill.textContent = `${missing} Missing`;
        thumbsStatusPill.classList.add('thumbs-warn');
      }
    }
    if (cancelThumbsBtn)    cancelThumbsBtn.style.display = generating ? '' : 'none';
    if (generateThumbsBtn) {
      if (generating) {
        generateThumbsBtn.disabled    = true;
        generateThumbsBtn.textContent = 'Generating\u2026';
      } else if (!scanned) {
        generateThumbsBtn.disabled    = true;
        generateThumbsBtn.textContent = 'Scan Folder First';
      } else if (missing === 0) {
        generateThumbsBtn.disabled    = true;
        generateThumbsBtn.textContent = 'All Thumbnails Ready \u2713';
      } else {
        generateThumbsBtn.disabled    = false;
        generateThumbsBtn.textContent = `Generate ${missing} Thumbnail${missing !== 1 ? 's' : ''}`;
      }
    }
    // Gate Start Server on thumb readiness (don't override running state)
    startBtn.disabled = serverIsRunning || !thumbState.ready || thumbState.generating;
    updateStartButtonVisibility();
  }

  async function scanThumbs() {
    try {
      const folder = videoFolderInput.value.trim();
      if (!folder) {
        thumbState = { scanned: false, total: 0, existing: 0, missing: 0, failed: 0, generating: false, ready: false };
        updateThumbsUI();
        return;
      }

      setThumbsMessage('Scanning…');
      ErrorHandler.log('info', 'scanThumbs', `Starting thumbnail scan for: ${folder}`);

      let result;
      try {
        result = await window.arcinityAPI.scanThumbs({ videoSourceDir: folder });
      } catch (e) {
        result = null;
        ErrorHandler.log('error', 'scanThumbs', `Scan API error`, e);
      }

      if (!result || !result.ok) {
        const errMsg = (result && result.error) || 'Scan failed - please check folder access';
        setThumbsMessage(errMsg, 'error');
        ErrorHandler.log('error', 'scanThumbs', errMsg);
        thumbState = { scanned: false, total: 0, existing: 0, missing: 0, failed: 0, generating: false, ready: false };
        updateThumbsUI();
        return;
      }

      thumbState = {
        scanned: true, total: result.total, existing: result.existing,
        missing: result.missing, failed: result.failed || 0, generating: false, ready: result.missing === 0,
      };

      if (result.total === 0) {
        setThumbsMessage('No videos found in the selected folder.', 'error');
        ErrorHandler.log('warn', 'scanThumbs', 'No videos found');
      } else if (result.missing === 0) {
        if ((result.failed || 0) > 0) {
          setThumbsMessage(`Ready to start. ${result.failed} video${result.failed !== 1 ? 's were' : ' was'} skipped because thumbnail generation failed, and those videos will be hidden from the feed.`, 'success');
        } else {
          setThumbsMessage(`All ${result.total} thumbnails are ready.`, 'success');
        }
        ErrorHandler.log('info', 'scanThumbs', `Scan complete: ${result.total} videos, all ready`);
      } else {
        const failedNote = (result.failed || 0) > 0
          ? ` ${result.failed} already-failed video${result.failed !== 1 ? 's are' : ' is'} excluded from the feed.`
          : '';
        setThumbsMessage(`Found ${result.total} video${result.total !== 1 ? 's' : ''}. ${result.missing} thumbnail${result.missing !== 1 ? 's' : ''} need to be generated.${failedNote}`);
        ErrorHandler.log('info', 'scanThumbs', `Scan complete: ${result.total} total, ${result.missing} missing`);
      }

      updateThumbsUI();
    } catch (e) {
      const errMsg = `Thumbnail scan error: ${e.message}`;
      setThumbsMessage(errMsg, 'error');
      ErrorHandler.log('error', 'scanThumbs', errMsg, e);
      thumbState = { scanned: false, total: 0, existing: 0, missing: 0, failed: 0, generating: false, ready: false };
      updateThumbsUI();
    }
  }

  if (generateThumbsBtn) {
    generateThumbsBtn.addEventListener('click', async () => {
      try {
        const folder = videoFolderInput.value.trim();
        if (!folder) {
          setThumbsMessage('Select a video folder first.', 'error');
          ErrorHandler.log('warn', 'generateThumbs', 'No video folder selected');
          return;
        }

        thumbState.generating = true;
        if (thumbsProgressWrap) thumbsProgressWrap.style.display = '';
        if (thumbsProgressBar)  thumbsProgressBar.style.width    = '0%';
        if (thumbsProgressText) thumbsProgressText.textContent   = 'Starting…';
        setThumbsMessage('');
        updateThumbsUI();

        ErrorHandler.log('info', 'generateThumbs', `Starting thumbnail generation for: ${folder}`);

        let result;
        try {
          result = await window.arcinityAPI.generateThumbs({ videoSourceDir: folder });
        } catch (e) {
          result = null;
          ErrorHandler.log('error', 'generateThumbs', `Generation API error`, e);
        }

        thumbState.generating = false;
        if (thumbsProgressWrap) thumbsProgressWrap.style.display = 'none';

        if (!result || !result.ok) {
          const errMsg = (result && result.error) || 'Generation failed - disk space or permissions issue';
          setThumbsMessage(errMsg, 'error');
          ErrorHandler.log('error', 'generateThumbs', errMsg);
          updateThumbsUI();
          return;
        }

        if (result.cancelled) {
          setThumbsMessage('Generation cancelled.');
          ErrorHandler.log('info', 'generateThumbs', 'Generation was cancelled');
          await scanThumbs();
          return;
        }

        const errNote = result.errors > 0 ? ` (${result.errors} error${result.errors !== 1 ? 's' : ''})` : '';
        const skippedNote = result.failed > 0
          ? ` ${result.failed} failed video${result.failed !== 1 ? 's were' : ' was'} delisted from the feed.`
          : '';
        setThumbsMessage(`Generated ${result.done} thumbnail${result.done !== 1 ? 's' : ''}${errNote}.${skippedNote}`, 'success');
        ErrorHandler.log('info', 'generateThumbs', `Generation complete: ${result.done} generated, ${result.errors} errors`);

        await scanThumbs();
      } catch (e) {
        thumbState.generating = false;
        if (thumbsProgressWrap) thumbsProgressWrap.style.display = 'none';
        const errMsg = `Thumbnail generation error: ${e.message}`;
        setThumbsMessage(errMsg, 'error');
        ErrorHandler.log('error', 'generateThumbs', errMsg, e);
        updateThumbsUI();
      }
    });
  }

  if (cancelThumbsBtn) {
    cancelThumbsBtn.addEventListener('click', async () => {
      cancelThumbsBtn.disabled = true;
      try { await window.arcinityAPI.cancelThumbs(); } catch { /* ignore */ }
      cancelThumbsBtn.disabled = false;
    });
  }

  window.arcinityAPI.onThumbsProgress((data) => {
    if (!thumbState.generating) return;
    const { done, total, current, errors = 0, phase } = data;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    if (thumbsProgressBar)  thumbsProgressBar.style.width = `${pct}%`;
    if (thumbsProgressText) {
      if (phase === 'done') {
        thumbsProgressText.textContent = `Done! (${done}/${total})`;
      } else if (phase === 'cancelled') {
        thumbsProgressText.textContent = 'Cancelled.';
      } else {
        const errText = errors > 0 ? ` \u2014 ${errors} error${errors !== 1 ? 's' : ''}` : '';
        thumbsProgressText.textContent = `${done} / ${total}${errText}${current ? ' \u2014 ' + current : ''}`;
      }
    }
    // Live-update "Already Ready" counter
    if (thumbsExistingEl) {
      const nowReady = Math.min(thumbState.total, thumbState.existing + (done - errors));
      thumbsExistingEl.textContent = String(Math.max(thumbState.existing, nowReady));
    }
  });

  /* ══════════════════════════════════════════════════════════
     Server panel – event listeners
  ═══════════════════════════════════════════════════════════ */
  browseFolderBtn.addEventListener('click', async () => {
    const result = await window.arcinityAPI.pickVideoFolder();
    if (result && result.ok && result.path) {
      videoFolderInput.value = result.path;
      setMessage('Video folder selected.', 'success');
      await scanThumbs();
    }
  });

startBtn.addEventListener('click', async () => {
  try {
    setMessage('Starting server…');
    
    // Validate inputs
    const videoFolder = videoFolderInput.value.trim();
    const port = Number(portInput.value);
    
    if (!videoFolder) {
      setMessage('Please select a video folder first.', 'error');
      ErrorHandler.log('warn', 'startServer', 'No video folder selected');
      return;
    }

    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      setMessage('Invalid port number (must be 1-65535).', 'error');
      ErrorHandler.log('warn', 'startServer', `Invalid port: ${port}`);
      return;
    }

    // Validate stream settings
    const streamSettings = getDesiredStreamSettings();
    const validation = PlaybackMonitor.validateStreamSettings(streamSettings.maxResolution, streamSettings.fragmentSeconds);
    
    if (!validation.valid) {
      setMessage(`Stream settings invalid: ${validation.issues.join(', ')}`, 'error');
      ErrorHandler.log('warn', 'startServer', `Invalid stream settings: ${validation.issues.join(', ')}`);
      return;
    }

    const payload = {
      videoSourceDir: videoFolder,
      port: port
    };

    const result = await window.arcinityAPI.startServer(payload);
    if (!result || !result.ok) {
      const errMsg = (result && result.error) || 'Failed to start server';
      setMessage(errMsg, 'error');
      ErrorHandler.log('error', 'startServer', errMsg);
      return;
    }

    currentUrl = result.url;
    currentLanUrl = result.lanUrl || '';
    setRunningUI(true);
    
    await syncStreamSettingsToServer(false);
    await syncEnhancedModeToServer();
    
    const phoneHint = currentLanUrl ? ` | Phone: ${currentLanUrl}` : '';
    const successMsg = `Server started at ${result.url}${phoneHint}`;
    setMessage(successMsg, 'success');
    ErrorHandler.log('info', 'startServer', 'Server started successfully');
  } catch (e) {
    const msg = `Server startup error: ${e.message}`;
    setMessage(msg, 'error');
    ErrorHandler.log('error', 'startServer', msg, e);
  }
});

stopBtn.addEventListener('click', async () => {
  try {
    setMessage('Stopping server…');
    await window.arcinityAPI.stopServer();
    currentUrl = '';
    currentLanUrl = '';
    setRunningUI(false);
    setMessage('Server stopped.', 'success');
    ErrorHandler.log('info', 'stopServer', 'Server stopped successfully');
  } catch (e) {
    const msg = `Server stop error: ${e.message}`;
    setMessage(msg, 'error');
    ErrorHandler.log('error', 'stopServer', msg, e);
    setRunningUI(false);
  }
});

openAppBtn.addEventListener('click', async () => {
  if (!currentUrl) return;
  await window.arcinityAPI.openBrowser(currentUrl);
});

clearLogsBtn.addEventListener('click', () => {
  logsEl.textContent = '';
});

window.arcinityAPI.onServerLog((line) => {
  appendLog(line);
});

window.arcinityAPI.onServerState((payload) => {
  if (payload && payload.url) currentUrl = payload.url;
  if (payload && payload.lanUrl) currentLanUrl = payload.lanUrl;
  if (payload && payload.running && currentLanUrl) {
    setMessage(`Server running. Phone URL: ${currentLanUrl}`, 'success');
  }
  setRunningUI(Boolean(payload && payload.running));
  if (payload && payload.running) {
    syncStreamSettingsToServer(false).catch(() => {});
    syncEnhancedModeToServer().catch(() => {});
  }
});

/* ══════════════════════════════════════════════════════════
   Init
═══════════════════════════════════════════════════════════ */
async function loadInitialState() {
  try {
    ErrorHandler.log('info', 'loadInitialState', 'Starting application initialization');

    let settings = null;
    try {
      settings = await window.arcinityAPI.loadSettings();
      if (!settings || typeof settings !== 'object') {
        throw new Error('Invalid settings object returned');
      }
    } catch (e) {
      ErrorHandler.log('error', 'loadInitialState', 'Failed to load settings', e);
      settings = { videoSourceDir: '', port: 3000 };
    }

    if (videoFolderInput && settings.videoSourceDir) {
      videoFolderInput.value = settings.videoSourceDir;
    }
    if (portInput) {
      const port = Number(settings.port) || 3000;
      if (Number.isFinite(port) && port >= 1 && port <= 65535) {
        portInput.value = port;
      } else {
        portInput.value = 3000;
      }
    }

    let status = null;
    try {
      status = await window.arcinityAPI.getServerStatus();
    } catch (e) {
      ErrorHandler.log('error', 'loadInitialState', 'Failed to get server status', e);
    }

    if (status && typeof status === 'object') {
      if (status.url) currentUrl = status.url;
      if (status.lanUrl) currentLanUrl = status.lanUrl;
      setRunningUI(Boolean(status.running));
    } else {
      setRunningUI(false);
    }

    // Auto-scan thumbnails for the already-configured folder
    if (videoFolderInput.value) {
      try {
        await scanThumbs();
      } catch (e) {
        ErrorHandler.log('warn', 'loadInitialState', 'Initial thumbnail scan failed', e);
      }
    } else {
      updateThumbsUI();
    }

    renderStreamSettingsUI();
    ErrorHandler.log('info', 'loadInitialState', 'Application initialization complete');
  } catch (err) {
    const msg = `Failed to load launcher state: ${err.message}`;
    setMessage(msg, 'error');
    ErrorHandler.log('error', 'loadInitialState', msg, err);
  }
}

// When the video folder changes, re-scan the DL index
videoFolderInput.addEventListener('change', () => {
  try {
    if (proState.active && proDeepLearnSection && proDeepLearnSection.style.display !== 'none') {
      deeplearnScan().catch(e => {
        ErrorHandler.log('error', 'videoFolderChange', 'Failed to rescan deep learn index', e);
      });
    }
  } catch (e) {
    ErrorHandler.log('error', 'videoFolderChange', 'Video folder change handler error', e);
  }
});

// Initialize everything
loadInitialState().catch(err => {
  const msg = `Initialization error: ${err.message}`;
  setMessage(msg, 'error');
  ErrorHandler.log('error', 'startup', msg, err);
});

try {
  restoreAuthStateFromCache();
  restoreProStateFromCache();
  updateProTabUI();
  updateEnhancedAlgorithmUI();
  renderStreamSettingsUI();
  checkSession({ preserveCachedOnFailure: true }).catch(e => {
    ErrorHandler.log('warn', 'startup', 'Session check failed during startup', e);
  });
} catch (e) {
  ErrorHandler.log('error', 'startup', 'Error checking session', e);
}


