const { app, BrowserWindow, dialog, ipcMain, shell, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

let mainWindow = null;
let serverProcess = null;
let serverUrls = { localUrl: '', lanUrl: '' };

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'launcher-settings.json');
}

function defaultSettings() {
  const fallbackVideoRoot = path.join(require('os').homedir(), 'Videos', 'categorized_videos');
  return {
    videoSourceDir: fallbackVideoRoot,
    port: 3000
  };
}

function readSettings() {
  const settingsPath = getSettingsPath();
  try {
    if (!fs.existsSync(settingsPath)) {
      return defaultSettings();
    }
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...defaultSettings(),
      ...parsed
    };
  } catch {
    return defaultSettings();
  }
}

function writeSettings(settings) {
  const settingsPath = getSettingsPath();
  const payload = {
    ...defaultSettings(),
    ...settings
  };
  fs.writeFileSync(settingsPath, JSON.stringify(payload, null, 2), 'utf8');
}

function getServerEntry() {
  const candidates = [
    path.resolve(__dirname, '..', 'server.js')
  ];

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar', 'server.js'));
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'server.js'));
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Continue trying other candidates.
    }
  }

  return candidates[0];
}

function getServerCwd() {
  // In packaged Electron apps, __dirname may be inside app.asar (not a real cwd).
  // Use resourcesPath to avoid spawn ENOENT caused by invalid cwd.
  if (!app.isPackaged) {
    return path.resolve(__dirname, '..');
  }
  return process.resourcesPath || path.dirname(process.execPath);
}

function getRuntimeDataDir() {
  return path.join(app.getPath('userData'), 'data');
}

function isPrivateIPv4(ip) {
  if (!ip || typeof ip !== 'string') {
    return false;
  }

  if (ip.startsWith('10.')) {
    return true;
  }

  if (ip.startsWith('192.168.')) {
    return true;
  }

  const match = ip.match(/^172\.(\d+)\./);
  if (!match) {
    return false;
  }

  const second = Number(match[1]);
  return second >= 16 && second <= 31;
}

function getPrimaryLanIp() {
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!Array.isArray(addrs)) {
      continue;
    }

    const loweredName = String(name || '').toLowerCase();
    const isWifiAdapter = /wi-?fi|wlan|wireless|802\.11/.test(loweredName);
    const isVpnOrVirtual = /vpn|tap|tun|ppp|virtual|vbox|vmware|hyper-v|wsl|docker|zerotier|tailscale|loopback/.test(loweredName);

    for (const addr of addrs) {
      if (!addr || addr.internal || addr.family !== 'IPv4') {
        continue;
      }

      const ip = String(addr.address || '').trim();
      if (!ip) {
        continue;
      }

      let score = 0;
      if (isPrivateIPv4(ip)) {
        score += 100;
      }
      if (isWifiAdapter) {
        score += 80;
      }
      if (isVpnOrVirtual) {
        score -= 120;
      }

      candidates.push({ ip, score });
    }
  }

  if (!candidates.length) {
    return null;
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].ip;
}

function resolveLauncherFfmpegPath() {
  const candidates = [];

  if (!app.isPackaged) {
    candidates.push(path.resolve(__dirname, '..', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'));
  }

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'));
    candidates.push(path.join(process.resourcesPath, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'));
  }

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Keep checking fallbacks.
    }
  }

  return null;
}

// ─── Python & Deep Learning helpers ──────────────────────────────────────────

function resolvePythonPath() {
  // Allow override via env or settings — most reliable way to use correct Python
  const envPy = process.env.PYTHON_PATH || process.env.PYTHON;
  if (envPy) {
    try {
      execFileSync(envPy, ['--version'], { stdio: 'ignore', timeout: 4000, windowsHide: true });
      return envPy;
    } catch {}
  }

  // Try to find Python in standard locations
  const candidates = process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];

  for (const cmd of candidates) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'ignore', timeout: 4000, windowsHide: true });
      return cmd;
    } catch {}
  }

  // Try common installation paths on Windows
  if (process.platform === 'win32') {
    const commonPaths = [
      path.join(process.env.LOCALAPPDATA || '', 'Programs\\Python\\Python312\\python.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs\\Python\\Python311\\python.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs\\Python\\Python310\\python.exe'),
      'C:\\Python312\\python.exe',
      'C:\\Python311\\python.exe',
      'C:\\Python310\\python.exe',
    ];
    for (const p of commonPaths) {
      try {
        if (fs.existsSync(p)) {
          execFileSync(p, ['--version'], { stdio: 'ignore', timeout: 4000, windowsHide: true });
          return p;
        }
      } catch {}
    }
  }

  return null;
}

function resolveDeepLearnScriptPath() {
  const candidates = [];
  if (!app.isPackaged) {
    candidates.push(path.resolve(__dirname, '..', 'scripts', 'deep_learning_processor.py'));
  }
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'scripts', 'deep_learning_processor.py'));
    candidates.push(path.join(process.resourcesPath, 'app.asar', 'scripts', 'deep_learning_processor.py'));
  }
  candidates.push(path.resolve(__dirname, '..', 'scripts', 'deep_learning_processor.py'));
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch {}
  }
  return candidates[0];
}

// ─── Thumbnail scanning & generation ─────────────────────────────────────────
const VIDEO_EXT_RE = /\.(mp4|mov|webm|mkv|avi)$/i;
let thumbGenAborted = false;

function getThumbnailFailuresPath() {
  return path.join(getRuntimeDataDir(), 'thumbnail-failures.json');
}

function normalizeRootId(dir) {
  const resolved = path.resolve(String(dir || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function makeFailureId(rootId, key) {
  return `${rootId}::${String(key || '').replace(/\\/g, '/')}`;
}

function readThumbnailFailures() {
  const filePath = getThumbnailFailuresPath();
  try {
    if (!fs.existsSync(filePath)) {
      return new Set();
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8') || '{}');
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    return new Set(entries.filter(Boolean));
  } catch {
    return new Set();
  }
}

function writeThumbnailFailures(failures) {
  const filePath = getThumbnailFailuresPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ entries: Array.from(failures).sort() }, null, 2), 'utf8');
}

function scanVideoFolder(dir) {
  const rootId = normalizeRootId(dir);
  const failureSet = readThumbnailFailures();
  let failureSetChanged = false;
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { ok: false, error: `Cannot read folder: ${e.message}`, total: 0, existing: 0, missing: 0, videos: [] };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const catDir = path.join(dir, entry.name);
    let files;
    try { files = fs.readdirSync(catDir); } catch { continue; }
    for (const file of files) {
      if (!VIDEO_EXT_RE.test(file)) continue;
      const videoPath = path.join(catDir, file);
      const base = file.replace(/\.[^/.]+$/, '');
      const thumbPath = path.join(catDir, base + '.webp');
      const key = `${entry.name}/${file}`;
      const failureId = makeFailureId(rootId, key);
      let hasThumb = false;
      try { fs.accessSync(thumbPath); hasThumb = true; } catch { /* missing */ }

      // Clear stale failure records if the thumbnail now exists again.
      if (hasThumb && failureSet.has(failureId)) {
        failureSet.delete(failureId);
        failureSetChanged = true;
      }

      results.push({
        videoPath,
        thumbPath,
        hasThumb,
        isFailed: failureSet.has(failureId),
        key,
        category: entry.name,
        file
      });
    }
  }
  if (failureSetChanged) {
    writeThumbnailFailures(failureSet);
  }
  const existing = results.filter(r => r.hasThumb).length;
  const failed = results.filter(r => !r.hasThumb && r.isFailed).length;
  const missing = results.filter(r => !r.hasThumb && !r.isFailed).length;
  return { ok: true, total: results.length, existing, failed, missing, videos: results };
}

async function generateThumbnailsBatch(videoSourceDir, sender) {
  const ffmpegPath = resolveLauncherFfmpegPath();
  if (!ffmpegPath) {
    return { ok: false, error: 'ffmpeg binary not found. Cannot generate thumbnails.' };
  }
  thumbGenAborted = false;
  const scan = scanVideoFolder(videoSourceDir);
  if (!scan.ok) return { ok: false, error: scan.error };
  const rootId = normalizeRootId(videoSourceDir);
  const failureSet = readThumbnailFailures();

  const missing = scan.videos.filter(v => !v.hasThumb && !v.isFailed);
  const total = missing.length;

  const sendProgress = (done, current, errors, phase = 'running') => {
    try {
      if (sender && !sender.isDestroyed()) {
        sender.send('thumbs:progress', { done, total, current, errors, phase });
      }
    } catch { /* window closed */ }
  };

  if (total === 0) {
    sendProgress(0, '', 0, 'done');
    return { ok: true, total: 0, done: 0, errors: 0 };
  }

  let done = 0;
  let errors = 0;
  let failed = 0;

  const processOne = (v) => new Promise((resolve) => {
    if (thumbGenAborted) { resolve(); return; }
    // -ss before -i = fast demuxer seek; single frame; scale to 640px wide
    const args = ['-y', '-ss', '0.1', '-i', v.videoPath, '-frames:v', '1', '-vf', 'scale=640:-2', v.thumbPath];
    const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { } }, 20000);
    ff.on('error', () => {
      clearTimeout(timer);
      errors++;
      failed++;
      failureSet.add(makeFailureId(rootId, v.key));
      writeThumbnailFailures(failureSet);
      done++;
      sendProgress(done, v.file, errors);
      resolve();
    });
    ff.on('exit', (code) => {
      clearTimeout(timer);
      done++;
      if (code !== 0) {
        errors++;
        failed++;
        failureSet.add(makeFailureId(rootId, v.key));
        writeThumbnailFailures(failureSet);
        // Remove incomplete/corrupt output so it isn't served
        try { if (fs.existsSync(v.thumbPath)) fs.unlinkSync(v.thumbPath); } catch { }
      } else {
        failureSet.delete(makeFailureId(rootId, v.key));
        writeThumbnailFailures(failureSet);
      }
      sendProgress(done, v.file, errors);
      resolve();
    });
  });

  const CONCURRENCY = 4;
  const queue = [...missing];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      if (thumbGenAborted) break;
      const item = queue.shift();
      if (item) await processOne(item);
    }
  });
  await Promise.all(workers);

  const phase = thumbGenAborted ? 'cancelled' : 'done';
  sendProgress(done, '', errors, phase);
  return { ok: true, total, done, errors, failed, cancelled: thumbGenAborted };
}

function emitServerState(extra) {
  if (!mainWindow) {
    return;
  }

  const payload = {
    running: Boolean(serverProcess),
    url: serverUrls.localUrl || '',
    lanUrl: serverUrls.lanUrl || '',
    ...extra
  };

  mainWindow.webContents.send('server:state', payload);
}

function appendLog(line) {
  if (!mainWindow) {
    return;
  }
  mainWindow.webContents.send('server:log', line);
}

function stopServer() {
  return new Promise((resolve) => {
    if (!serverProcess) {
      serverUrls = { localUrl: '', lanUrl: '' };
      resolve({ ok: true, alreadyStopped: true });
      return;
    }

    const proc = serverProcess;
    serverProcess = null;

    const timeout = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // No-op
      }
    }, 2500);

    proc.once('exit', () => {
      clearTimeout(timeout);
      serverUrls = { localUrl: '', lanUrl: '' };
      emitServerState({ running: false });
      appendLog('[launcher] Server stopped');
      resolve({ ok: true });
    });

    try {
      proc.kill('SIGINT');
    } catch {
      clearTimeout(timeout);
      serverUrls = { localUrl: '', lanUrl: '' };
      emitServerState({ running: false });
      resolve({ ok: true });
    }
  });
}

function validateStartInput(input) {
  const errors = [];
  const folder = String(input.videoSourceDir || '').trim();
  const port = Number(input.port);

  if (!folder) {
    errors.push('Please choose a video folder.');
  } else {
    try {
      const stat = fs.statSync(folder);
      if (!stat.isDirectory()) {
        errors.push('Selected video path is not a directory.');
      }
    } catch {
      errors.push('Selected video folder does not exist.');
    }
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.push('Port must be a number between 1 and 65535.');
  }

  return {
    errors,
    normalized: {
      videoSourceDir: folder,
      port
    }
  };
}

async function startServer(input) {
  if (serverProcess) {
    return { ok: false, error: 'Server is already running.' };
  }

  const { errors, normalized } = validateStartInput(input || {});
  if (errors.length) {
    return { ok: false, error: errors.join(' ') };
  }

  writeSettings(normalized);

  const serverEntry = getServerEntry();
  const runtimeDataDir = getRuntimeDataDir();
  try {
    fs.mkdirSync(runtimeDataDir, { recursive: true });
  } catch {
    // Let server handle fallback errors if this creation fails.
  }

  const ffmpegPath = resolveLauncherFfmpegPath();
  const childEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    VIDEO_SOURCE_DIR: normalized.videoSourceDir,
    PORT: String(normalized.port),
    ARCINITY_DATA_DIR: runtimeDataDir,
    ARCINITY_THUMB_FAILURES_PATH: getThumbnailFailuresPath()
  };
  if (ffmpegPath) {
    childEnv.FFMPEG_PATH = ffmpegPath;
  }

  const serverCwd = getServerCwd();

  try {
    serverProcess = spawn(process.execPath, [serverEntry], {
      cwd: serverCwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
  } catch (error) {
    serverProcess = null;
    return { ok: false, error: `Failed to start server: ${error.message}` };
  }

  serverProcess.stdout.on('data', (chunk) => appendLog(String(chunk).trimEnd()));
  serverProcess.stderr.on('data', (chunk) => appendLog(String(chunk).trimEnd()));
  serverProcess.on('error', (error) => {
    appendLog(`[server error] ${error.message}`);
    serverProcess = null;
    serverUrls = { localUrl: '', lanUrl: '' };
    emitServerState({ running: false });
  });
  serverProcess.on('exit', (code, signal) => {
    const detail = `code=${String(code)} signal=${String(signal)}`;
    appendLog(`[launcher] Server exited (${detail})`);
    serverProcess = null;
    serverUrls = { localUrl: '', lanUrl: '' };
    emitServerState({ running: false });
  });

  const url = `http://localhost:${normalized.port}`;
  const lanIp = getPrimaryLanIp();
  const lanUrl = lanIp ? `http://${lanIp}:${normalized.port}` : '';
  serverUrls = { localUrl: url, lanUrl };
  emitServerState({ running: true, url, lanUrl });
  appendLog(`[launcher] Server started at ${url}`);
  if (lanUrl) {
    appendLog(`[launcher] Phone / LAN URL: ${lanUrl}`);
  }
  return { ok: true, url, lanUrl };
}

function setServerRecommendationMode(enhancedEnabled) {
  if (!serverProcess || !serverUrls.localUrl) {
    return Promise.resolve({ ok: false, error: 'Server is not running.' });
  }

  return new Promise((resolve) => {
    let target;
    try {
      target = new URL('/api/recommendation-mode', serverUrls.localUrl);
    } catch {
      resolve({ ok: false, error: 'Invalid server URL.' });
      return;
    }

    const body = JSON.stringify({ enhancedEnabled: !!enhancedEnabled });
    const req = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += String(chunk); });
      res.on('end', () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, data });
        } else {
          resolve({ ok: false, error: (data && data.error) || `Server responded ${res.statusCode}` });
        }
      });
    });

    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.setTimeout(3000, () => {
      req.destroy(new Error('Request timed out'));
    });
    req.write(body);
    req.end();
  });
}

function setServerStreamSettings(payload = {}) {
  if (!serverProcess || !serverUrls.localUrl) {
    return Promise.resolve({ ok: false, error: 'Server is not running.' });
  }

  return new Promise((resolve) => {
    let target;
    try {
      target = new URL('/api/stream-settings', serverUrls.localUrl);
    } catch {
      resolve({ ok: false, error: 'Invalid server URL.' });
      return;
    }

    const body = JSON.stringify(payload || {});
    const req = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += String(chunk); });
      res.on('end', () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, data });
        } else {
          resolve({ ok: false, error: (data && data.error) || `Server responded ${res.statusCode}` });
        }
      });
    });

    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.setTimeout(4000, () => {
      req.destroy(new Error('Request timed out'));
    });
    req.write(body);
    req.end();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 700,
    minWidth: 840,
    minHeight: 620,
    backgroundColor: '#0f1727',
    title: 'Arcinity Launcher',
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  try {
    mainWindow.setMenuBarVisibility(false);
  } catch {}

  // Keep remote auth cookies/session data persisted across launcher restarts.
  try {
    const flushCookiesResult = session.defaultSession.cookies.flushStore();
    if (flushCookiesResult && typeof flushCookiesResult.catch === 'function') {
      flushCookiesResult.catch(() => {});
    }
  } catch {}
  try {
    const flushStorageResult = session.defaultSession.flushStorageData();
    if (flushStorageResult && typeof flushStorageResult.catch === 'function') {
      flushStorageResult.catch(() => {});
    }
  } catch {}

  mainWindow.on('close', () => {
    try {
      const flushCookiesResult = session.defaultSession.cookies.flushStore();
      if (flushCookiesResult && typeof flushCookiesResult.catch === 'function') {
        flushCookiesResult.catch(() => {});
      }
    } catch {}
    try {
      const flushStorageResult = session.defaultSession.flushStorageData();
      if (flushStorageResult && typeof flushStorageResult.catch === 'function') {
        flushStorageResult.catch(() => {});
      }
    } catch {}
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer.html'));
}

app.whenReady().then(() => {
  try {
    Menu.setApplicationMenu(null);
  } catch {}

  ipcMain.handle('window:minimize', (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow || targetWindow.isDestroyed()) return { ok: false };
    targetWindow.minimize();
    return { ok: true };
  });

  ipcMain.handle('window:toggleMaximize', (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow || targetWindow.isDestroyed()) return { ok: false, maximized: false };
    if (targetWindow.isMaximized()) {
      targetWindow.unmaximize();
    } else {
      targetWindow.maximize();
    }
    return { ok: true, maximized: targetWindow.isMaximized() };
  });

  ipcMain.handle('window:close', (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow || targetWindow.isDestroyed()) return { ok: false };
    targetWindow.close();
    return { ok: true };
  });

  ipcMain.handle('window:isMaximized', (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender);
    if (!targetWindow || targetWindow.isDestroyed()) return false;
    return targetWindow.isMaximized();
  });

  ipcMain.handle('settings:load', () => readSettings());

  ipcMain.handle('settings:pickFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Select Arcinity Video Folder',
      properties: ['openDirectory']
    });

    if (result.canceled || !result.filePaths.length) {
      return { ok: false };
    }

    return { ok: true, path: result.filePaths[0] };
  });

  ipcMain.handle('server:start', async (_event, input) => startServer(input));
  ipcMain.handle('server:stop', async () => stopServer());
  ipcMain.handle('server:setRecommendationMode', async (_event, input) => {
    const enhancedEnabled = !!(input && input.enhancedEnabled);
    return setServerRecommendationMode(enhancedEnabled);
  });
  ipcMain.handle('server:setStreamSettings', async (_event, input) => {
    return setServerStreamSettings(input || {});
  });
  ipcMain.handle('server:status', async () => ({
    running: Boolean(serverProcess),
    url: serverUrls.localUrl || '',
    lanUrl: serverUrls.lanUrl || ''
  }));
  ipcMain.handle('server:openBrowser', async (_event, url) => {
    if (!url) {
      return { ok: false };
    }
    await shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('thumbs:scan', async (_event, { videoSourceDir } = {}) => {
    if (!videoSourceDir) {
      return { ok: false, error: 'No folder specified.' };
    }
    return scanVideoFolder(videoSourceDir);
  });

  ipcMain.handle('thumbs:generate', async (_event, { videoSourceDir } = {}) => {
    if (!videoSourceDir) {
      return { ok: false, error: 'No folder specified.' };
    }
    return generateThumbnailsBatch(videoSourceDir, mainWindow ? mainWindow.webContents : null);
  });

  ipcMain.handle('thumbs:cancel', async () => {
    thumbGenAborted = true;
    return { ok: true };
  });

  // ─── Deep Learning Indexer ─────────────────────────────────────────────────

  ipcMain.handle('deeplearn:getDataPath', async () => {
    return {
      outputPath: path.join(getRuntimeDataDir(), 'deep-learning-index.json'),
    };
  });

  ipcMain.handle('deeplearn:checkDeps', async () => {
    const python = resolvePythonPath();
    if (!python) {
      return { ok: false, error: 'Python not found. Install Python 3.8+ and restart.', deps: null };
    }
    const scriptPath = resolveDeepLearnScriptPath();
    return new Promise((resolve) => {
      let output = '';
      const proc = spawn(python, [scriptPath, '--check-deps'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      proc.stdout.on('data', (chunk) => { output += chunk.toString(); });
      proc.stderr.on('data', () => {});
      const timer = setTimeout(() => { try { proc.kill(); } catch {} }, 12000);
      proc.on('close', () => {
        clearTimeout(timer);
        for (const line of output.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            if (obj.type === 'deps') {
              resolve({ ok: true, deps: obj, python });
              return;
            }
          } catch {}
        }
        resolve({ ok: false, error: 'Could not parse dependency output.', deps: null });
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, error: err.message, deps: null });
      });
    });
  });

  ipcMain.handle('deeplearn:scan', async (_event, { videoSourceDir, outputPath } = {}) => {
    if (!videoSourceDir) return { ok: false, error: 'No video folder specified.' };
    if (!outputPath)     return { ok: false, error: 'No output path specified.' };

    let index = { videos: {} };
    try {
      if (fs.existsSync(outputPath)) {
        const raw = fs.readFileSync(outputPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.videos === 'object') index = parsed;
      }
    } catch {}

    const VIDEO_EXT_RE_DL = /\.(mp4|mov|webm|mkv|avi)$/i;
    let total = 0, indexed = 0;
    try {
      for (const cat of fs.readdirSync(videoSourceDir)) {
        const catDir = path.join(videoSourceDir, cat);
        let stat;
        try { stat = fs.statSync(catDir); } catch { continue; }
        if (!stat.isDirectory()) continue;
        for (const file of fs.readdirSync(catDir)) {
          if (!VIDEO_EXT_RE_DL.test(file)) continue;
          total++;
          const key = `${cat}/${file}`;
          if (index.videos[key]) indexed++;
        }
      }
    } catch (e) {
      return { ok: false, error: `Cannot read folder: ${e.message}` };
    }
    return { ok: true, total, indexed, pending: total - indexed };
  });

  let deepLearnProcess = null;
  let deepLearnAborted = false;

  ipcMain.handle('deeplearn:run', async (_event, { videoSourceDir, outputPath, reindex, quality, skipSpeech, visualMode } = {}) => {
    if (!videoSourceDir) return { ok: false, error: 'No video folder specified.' };
    if (!outputPath)     return { ok: false, error: 'No output path specified.' };

    if (deepLearnProcess) return { ok: false, error: 'Deep learning indexer is already running.' };

    const python = resolvePythonPath();
    if (!python) return { ok: false, error: 'Python not found. Install Python 3.8+ and restart.' };

    const scriptPath = resolveDeepLearnScriptPath();
    const ffmpegPath = resolveLauncherFfmpegPath() || 'ffmpeg';

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    deepLearnAborted = false;

    const args = [
      scriptPath,
      '--video-dir', videoSourceDir,
      '--output',    outputPath,
      '--ffmpeg',    ffmpegPath,
      '--quality',   quality || 'balanced',
    ];
    if (reindex) args.push('--reindex');
    if (skipSpeech) args.push('--skip-speech');
    if (visualMode) {
      args.push('--visual-mode', visualMode);
    }

    return new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(python, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (spawnErr) {
        resolve({ ok: false, error: spawnErr.message });
        return;
      }

      deepLearnProcess = proc;

      const sender = mainWindow ? mainWindow.webContents : null;

      const sendDLProgress = (data) => {
        try {
          if (sender && !sender.isDestroyed()) {
            sender.send('deeplearn:progress', data);
          }
        } catch {}
      };

      let buffer = '';
      proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed);
            sendDLProgress(obj);
            if (obj.type === 'done' || obj.type === 'error') {
              deepLearnProcess = null;
              resolve({ ok: obj.type !== 'error', data: obj });
            }
          } catch {}
        }
      });

      proc.stderr.on('data', (chunk) => {
        // Forward non-empty stderr lines as status messages
        const lines = chunk.toString().split('\n');
        for (const l of lines) {
          if (l.trim()) sendDLProgress({ type: 'log', message: l.trim() });
        }
      });

      proc.on('error', (err) => {
        deepLearnProcess = null;
        resolve({ ok: false, error: err.message });
      });

      proc.on('close', (code) => {
        deepLearnProcess = null;
        if (deepLearnAborted) {
          sendDLProgress({ type: 'cancelled' });
          resolve({ ok: true, cancelled: true });
        } else if (code !== 0) {
          resolve({ ok: false, error: `Process exited with code ${code}` });
        }
        // If already resolved via 'done' event, this no-ops
      });
    });
  });

  ipcMain.handle('deeplearn:cancel', async () => {
    deepLearnAborted = true;
    if (deepLearnProcess) {
      try { deepLearnProcess.kill('SIGTERM'); } catch {}
      // Force-kill after 3 s if still alive
      setTimeout(() => {
        try { if (deepLearnProcess) deepLearnProcess.kill('SIGKILL'); } catch {}
      }, 3000);
    }
    return { ok: true };
  });

  ipcMain.handle('deeplearn:installDeps', async () => {
    const python = resolvePythonPath();
    if (!python) return { ok: false, error: 'Python not found.' };

    const sender = mainWindow ? mainWindow.webContents : null;
    const sendLog = (line) => {
      try {
        if (sender && !sender.isDestroyed()) {
          sender.send('deeplearn:install-log', { line });
        }
      } catch {}
    };

    const packages = [
      'faster-whisper',
      'torch',
      'torchvision',
      'transformers',
      'librosa',
      'Pillow',
      'numpy',
      'scipy',
    ];

    return new Promise((resolve) => {
      const proc = spawn(
        python, ['-m', 'pip', 'install', '--upgrade', ...packages],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
      );
      const onData = (chunk) => {
        for (const l of chunk.toString().split('\n')) {
          if (l.trim()) sendLog(l.trim());
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('close',  (code) => resolve({ ok: code === 0, exitCode: code }));
      proc.on('error',  (err)  => resolve({ ok: false, error: err.message }));
    });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', async (event) => {
  if (!serverProcess) {
    return;
  }
  event.preventDefault();
  await stopServer();
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

