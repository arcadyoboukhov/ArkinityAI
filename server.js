const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
const config = require('./config');

function resolveFfmpegBinary() {
  const candidates = [];

  if (process.env.FFMPEG_PATH) {
    candidates.push(process.env.FFMPEG_PATH);
  }

  try {
    const bundledFfmpeg = require('ffmpeg-static');
    if (bundledFfmpeg) {
      candidates.push(bundledFfmpeg);
      // In packaged Electron apps, native binaries are typically unpacked here.
      if (bundledFfmpeg.includes('app.asar')) {
        candidates.push(bundledFfmpeg.replace('app.asar', 'app.asar.unpacked'));
      }
    }
  } catch (e) {
    // ffmpeg-static not available; fallback to system ffmpeg below.
  }

  for (const candidate of candidates) {
    try {
      if (candidate && fsSync.existsSync(candidate)) {
        return candidate;
      }
    } catch (e) { }
  }

  return 'ffmpeg';
}

const ffmpegBin = resolveFfmpegBinary();
let ffmpegDisabled = false;
let ffmpegErrorLogged = false;

/**
 * =============================================================================
 * Arcinity - SERVER
 * =============================================================================
 * 
 * This is the main Express.js server for Arcinity.
 * 
 * Key Responsibilities:
 * 1. Serves static frontend files (HTML, CSS, JS)
 * 2. Exposes video files via /videos/ endpoint
 * 3. Manages user behavior tracking (watch time, likes)
 * 4. Generates personalized video recommendations
 * 5. Maintains persistent state (recent videos, user behavior)
 * 
 * All paths are configured via config.js for cross-platform compatibility.
 */

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

let serverProStatus = false;

const MOBILE_VARIANTS_DIR = path.join(config.dataDir, 'mobile-variants');
const mobileVariantJobs = new Map();
const MOBILE_VARIANT_WAIT_MS = 7000;
const MOBILE_VARIANT_NON_MP4_WAIT_MS = 26000;
const MIN_VALID_MOBILE_VARIANT_BYTES = 48 * 1024;
const MIN_VALID_MOBILE_VARIANT_BYTES_SHORT = 8 * 1024;
const MIN_VALID_MOBILE_VARIANT_BYTES_MEDIUM = 20 * 1024;
const MOBILE_VARIANT_DURATION_TOLERANCE_SEC = 0.45;
const MOBILE_VARIANT_DURATION_TOLERANCE_SHORT_SEC = 0.25;
const HLS_VARIANTS_DIR = path.join(config.dataDir, 'hls-variants');
const hlsVariantJobs = new Map();
const HLS_PREPARE_WAIT_MS = 1200;
const STREAM_SETTINGS_PATH = path.join(config.dataDir, 'stream-settings.json');

const DEFAULT_STREAM_SETTINGS = {
  maxResolution: '540', // free-tier default
  fragmentSeconds: 1,
};

let streamSettings = { ...DEFAULT_STREAM_SETTINGS };

const VIDEO_EXT_RE = /\.(mp4|mov|webm|mkv|avi)$/i;
const MIME_BY_EXT = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png'
};

function contentTypeForFile(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function isLikelyMobileRequest(req) {
  const q = String((req.query && req.query.mobile) || '').toLowerCase();
  if (q === '1' || q === 'true') return true;

  const chMobile = String(req.headers['sec-ch-ua-mobile'] || '').toLowerCase();
  if (chMobile.includes('?1') || chMobile === '1') return true;

  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  return /android|iphone|ipad|ipod|mobile|blackberry|iemobile|opera mini/i.test(ua);
}

function resolveSafeVideoPath(category, filename) {
  if (!category || !filename) return null;
  const fullPath = path.resolve(videosRoot, category, filename);
  const rootPath = path.resolve(videosRoot) + path.sep;
  if (!fullPath.startsWith(rootPath)) return null;
  return fullPath;
}

function getMobileVariantPath(category, filename) {
  const parsed = path.parse(filename);
  return path.join(MOBILE_VARIANTS_DIR, category, `${parsed.name}.mobile.mp4`);
}

/**
 * Get video duration in seconds using ffprobe or ffmpeg.
 * Returns null if duration cannot be determined.
 */
async function getVideoDuration(videoPath) {
  return new Promise((resolve) => {
    try {
      let output = '';
      let settled = false;
      const finish = (duration) => {
        if (settled) return;
        settled = true;
        resolve(duration);
      };

      // Try ffprobe first if available
      const probeArgs = [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1:noprint_wrappers=1',
        videoPath
      ];

      const probe = spawn('ffprobe', probeArgs);
      probe.stdout.on('data', (data) => {
        output += data.toString();
      });
      probe.on('close', (code) => {
        if (code === 0 && output) {
          const duration = parseFloat(output.trim());
          if (!Number.isNaN(duration) && duration > 0) {
            return finish(duration);
          }
        }
        // Fallback to ffmpeg if ffprobe fails
        const ffArgs = ['-i', videoPath];
        const ff = spawn(ffmpegBin, ffArgs);
        let errorOutput = '';
        ff.stderr.on('data', (data) => {
          errorOutput += data.toString();
        });
        ff.on('close', () => {
          const match = errorOutput.match(/Duration: (\d+):(\d+):(\d+\.?\d*)/);
          if (match) {
            const hours = parseInt(match[1], 10);
            const minutes = parseInt(match[2], 10);
            const seconds = parseFloat(match[3]);
            const total = hours * 3600 + minutes * 60 + seconds;
            return finish(total);
          }
          finish(null);
        });
        ff.on('error', () => finish(null));
      });
      probe.on('error', () => {
        // ffprobe not available, will use ffmpeg fallback above
      });

      // Timeout after 3 seconds
      setTimeout(() => finish(null), 3000);
    } catch (err) {
      resolve(null);
    }
  });
}

function sanitizeSegmentSeconds(input) {
  const n = Number(input);
  if (!Number.isFinite(n)) return DEFAULT_STREAM_SETTINGS.fragmentSeconds;
  return Math.min(12, Math.max(1, Math.round(n)));
}

function sanitizeMaxResolution(input) {
  if (input == null) return DEFAULT_STREAM_SETTINGS.maxResolution;
  const normalized = String(input).trim().toLowerCase();
  if (normalized === 'none' || normalized === 'max' || normalized === 'nomax') return 'none';
  if (normalized === '540' || normalized === '540p') return '540';
  if (normalized === '720' || normalized === '720p') return '720';
  if (normalized === '1080' || normalized === '1080p') return '1080';
  return DEFAULT_STREAM_SETTINGS.maxResolution;
}

function sanitizeStreamSettings(input = {}) {
  const next = {
    maxResolution: sanitizeMaxResolution(input.maxResolution),
    fragmentSeconds: sanitizeSegmentSeconds(input.fragmentSeconds),
  };
  return next;
}

async function loadStreamSettings() {
  try {
    await ensureDataDir();
    if (!fsSync.existsSync(STREAM_SETTINGS_PATH)) {
      streamSettings = { ...DEFAULT_STREAM_SETTINGS };
      await fs.writeFile(STREAM_SETTINGS_PATH, JSON.stringify(streamSettings, null, 2), 'utf8');
      return;
    }
    const raw = await fs.readFile(STREAM_SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    streamSettings = sanitizeStreamSettings(parsed || {});
  } catch {
    streamSettings = { ...DEFAULT_STREAM_SETTINGS };
  }
}

async function saveStreamSettings(next) {
  streamSettings = sanitizeStreamSettings(next || {});
  try {
    await ensureDataDir();
    await fs.writeFile(STREAM_SETTINGS_PATH, JSON.stringify(streamSettings, null, 2), 'utf8');
  } catch (e) {
    console.warn('Failed to save stream settings:', e && e.message);
  }
}

function getEffectiveStreamSettings() {
  return sanitizeStreamSettings(streamSettings);
}

function shouldUseHlsStreaming() {
  return true;
}

function getHlsVariantSignature(settings = {}) {
  return `${settings.maxResolution || '720'}-${sanitizeSegmentSeconds(settings.fragmentSeconds || 1)}`;
}

function getHlsVariantDir(category, filename, settings = {}) {
  const parsed = path.parse(filename);
  const hash = crypto.createHash('md5').update(String(filename || '')).digest('hex').slice(0, 8);
  const sig = getHlsVariantSignature(settings);
  return path.join(HLS_VARIANTS_DIR, category, `${parsed.name}_${hash}_${sig}`);
}

function getHlsPlaylistPath(category, filename, settings = {}) {
  return path.join(getHlsVariantDir(category, filename, settings), 'index.m3u8');
}

function buildHlsUrl(category, file) {
  return `/hls/${encodeURIComponent(category)}/${encodeURIComponent(file)}/index.m3u8`;
}

function getHlsScaleArg(settings = {}) {
  if (settings.maxResolution === 'none') return null;
  if (settings.maxResolution === '1080') return 'scale=-2:1080';
  if (settings.maxResolution === '720') return 'scale=-2:720';
  return 'scale=-2:540';
}

function getHlsRateProfile(settings = {}) {
  const level = settings.maxResolution;
  if (level === 'none') {
    return { b: '3000k', maxrate: '4200k', bufsize: '6000k' };
  }
  if (level === '1080') {
    return { b: '2800k', maxrate: '4000k', bufsize: '5600k' };
  }
  if (level === '720') {
    return { b: '1800k', maxrate: '2500k', bufsize: '3500k' };
  }
  return { b: '1100k', maxrate: '1600k', bufsize: '2400k' };
}

async function ensureHlsVariant(category, filename, settings = getEffectiveStreamSettings()) {
  if (ffmpegDisabled) return null;
  const sourcePath = resolveSafeVideoPath(category, filename);
  if (!sourcePath || !fsSync.existsSync(sourcePath)) return null;

  const safeSettings = sanitizeStreamSettings(settings);
  const playlistPath = getHlsPlaylistPath(category, filename, safeSettings);
  const key = `${category}/${filename}::${getHlsVariantSignature(safeSettings)}`;
  if (hlsVariantJobs.has(key)) return hlsVariantJobs.get(key);

  const job = (async () => {
    try {
      await fs.access(playlistPath);
      return playlistPath;
    } catch {}

    await ensureDir(path.dirname(playlistPath));
    const segPattern = path.join(path.dirname(playlistPath), 'seg_%05d.ts');

    // Detect video duration to optimize HLS for short videos
    let duration = null;
    try {
      duration = await getVideoDuration(sourcePath);
    } catch (e) {
      console.warn('Failed to detect duration for HLS variant:', filename);
    }

    // For videos < 2 seconds, use minimum fragment duration to ensure proper playback
    let fragmentSeconds = Math.max(1, safeSettings.fragmentSeconds);
    let keyframeExpr = fragmentSeconds;
    
    if (duration !== null && duration < 2.0) {
      // For short videos, use minimum 1-second fragments to ensure complete playlist
      fragmentSeconds = 1;
      // Always generate at least one keyframe for the entire video
      keyframeExpr = Math.max(0.5, Math.ceil(duration) / 2);
    }

    const args = ['-i', sourcePath];
    const scaleArg = getHlsScaleArg(safeSettings);
    const rateProfile = getHlsRateProfile(safeSettings);
    if (scaleArg) args.push('-vf', scaleArg);

    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-profile:v', 'main',
      '-level', '4.0',
      '-pix_fmt', 'yuv420p',
      '-b:v', rateProfile.b,
      '-maxrate', rateProfile.maxrate,
      '-bufsize', rateProfile.bufsize,
      '-c:a', 'aac',
      '-b:a', '96k',
      '-ac', '2',
      '-g', '60',
      '-keyint_min', '60',
      '-sc_threshold', '0',
      '-force_key_frames', `expr:gte(t,n_forced*${keyframeExpr})`,
      '-hls_time', String(fragmentSeconds),
      '-hls_list_size', '0',
      '-hls_playlist_type', 'vod',
      '-hls_flags', 'independent_segments+temp_file',
      '-hls_segment_filename', segPattern,
      '-f', 'hls',
      '-y', playlistPath
    );

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const ff = spawn(ffmpegBin, args, { stdio: 'ignore' });
      ff.on('error', (err) => {
        if (!ffmpegErrorLogged) {
          console.warn('ffmpeg spawn error:', err.message, '| binary:', ffmpegBin);
          ffmpegErrorLogged = true;
        }
        if (err && err.code === 'ENOENT') {
          ffmpegDisabled = true;
        }
        finish();
      });
      ff.on('exit', (code) => {
        if (code !== 0) {
          console.warn('ffmpeg exited with code', code, 'for HLS variant:', filename);
        }
        finish();
      });
    });

    try {
      await fs.access(playlistPath);
      return playlistPath;
    } catch {
      console.warn('HLS variant failed for', filename, '- file not created');
      return null;
    }
  })().finally(() => {
    hlsVariantJobs.delete(key);
  });

  hlsVariantJobs.set(key, job);
  return job;
}

async function ensureHlsVariantWithTimeout(category, filename, timeoutMs = HLS_PREPARE_WAIT_MS, settings = getEffectiveStreamSettings()) {
  try {
    return await Promise.race([
      ensureHlsVariant(category, filename, settings),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch {
    return null;
  }
}

async function ensureMobileVariant(category, filename) {
  if (ffmpegDisabled) return null;

  const key = `${category}/${filename}`;
  if (mobileVariantJobs.has(key)) return mobileVariantJobs.get(key);

  const job = (async () => {
    const sourcePath = resolveSafeVideoPath(category, filename);
    if (!sourcePath || !fsSync.existsSync(sourcePath)) return null;

    const outPath = getMobileVariantPath(category, filename);
    try {
      await fs.access(outPath);
      const usable = await isMobileVariantUsable(sourcePath, outPath);
      if (usable) {
        return outPath;
      }

      try { await fs.unlink(outPath); } catch (e) { }
      console.warn('Rebuilding invalid mobile variant for', filename);
    } catch (e) { }

    await ensureDir(path.dirname(outPath));

    // Detect video duration to optimize encoding for short videos
    let duration = null;
    try {
      duration = await getVideoDuration(sourcePath);
    } catch (e) {
      console.warn('Failed to detect duration for', filename, '- proceeding with defaults');
    }

    const isShortVideo = duration !== null && duration < 1.0;

    // For videos < 1 second, use more lenient keyframe settings to avoid encoding issues
    let keyframeInterval = '48';
    let minKeyframeInterval = '48';
    
    if (isShortVideo) {
      // For very short videos, allow more flexible keyframe placement
      keyframeInterval = '12';
      minKeyframeInterval = '1';
    }

    const args = [
      '-i', sourcePath,
      '-vf', 'scale=-2:720,unsharp=3:3:1.2:3:3:0.0',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast',
      '-profile:v', 'main',
      '-level', '4.0',
      '-b:v', '1600k',
      '-maxrate', '2200k',
      '-bufsize', '3200k',
      '-g', keyframeInterval,
      '-keyint_min', minKeyframeInterval,
      '-sc_threshold', '0',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-ac', '2',
      '-movflags', '+faststart',  // Use standard faststart for VOD playback
      '-y', outPath
    ];

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const ff = spawn(ffmpegBin, args, { stdio: 'pipe' });
      
      // Capture stderr to detect encoding issues
      let errorOutput = '';
      ff.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      ff.on('error', (err) => {
        if (!ffmpegErrorLogged) {
          console.warn('ffmpeg spawn error:', err.message, '| binary:', ffmpegBin);
          ffmpegErrorLogged = true;
        }
        if (err && err.code === 'ENOENT') {
          ffmpegDisabled = true;
        }
        finish();
      });

      ff.on('exit', (code) => {
        if (code !== 0) {
          console.warn('ffmpeg exited with code', code, 'for mobile variant:', filename);
          if (errorOutput) {
            console.warn('ffmpeg stderr:', errorOutput.substring(0, 500));
          }
        }
        finish();
      });
    });

    try {
      await fs.access(outPath);
      const usable = await isMobileVariantUsable(sourcePath, outPath);
      if (!usable) {
        try { await fs.unlink(outPath); } catch (e) { }
        console.warn('Mobile variant validation failed for', filename, '- deleted broken output');
        return null;
      }
      return outPath;
    } catch (e) {
      console.warn('Mobile variant failed for', filename, '- file not created');
      return null;
    }
  })().finally(() => {
    mobileVariantJobs.delete(key);
  });

  mobileVariantJobs.set(key, job);
  return job;
}

async function isMobileVariantUsable(sourcePath, variantPath) {
  try {
    const [sourceStat, variantStat] = await Promise.all([
      fs.stat(sourcePath),
      fs.stat(variantPath),
    ]);

    const isFresh = variantStat.mtimeMs >= sourceStat.mtimeMs;
    const [srcDuration, outDuration] = await Promise.all([
      getVideoDuration(sourcePath),
      getVideoDuration(variantPath),
    ]);

    let minBytes = MIN_VALID_MOBILE_VARIANT_BYTES;
    if (Number.isFinite(srcDuration) && srcDuration > 0) {
      if (srcDuration < 1.0) {
        minBytes = MIN_VALID_MOBILE_VARIANT_BYTES_SHORT;
      } else if (srcDuration < 2.0) {
        minBytes = MIN_VALID_MOBILE_VARIANT_BYTES_MEDIUM;
      }
    }

    const isLargeEnough = Number(variantStat.size || 0) >= minBytes;
    if (!isFresh || !isLargeEnough) {
      return false;
    }

    if (!Number.isFinite(srcDuration) || srcDuration <= 0) {
      return true;
    }
    if (!Number.isFinite(outDuration) || outDuration <= 0) {
      return false;
    }

    if (srcDuration < 1.0) {
      const minExpectedDuration = Math.max(0.08, srcDuration - MOBILE_VARIANT_DURATION_TOLERANCE_SHORT_SEC);
      const nearEnough = Math.abs(outDuration - srcDuration) <= 0.4;
      return outDuration >= minExpectedDuration || nearEnough;
    }

    const minExpectedDuration = Math.max(0.25, srcDuration - MOBILE_VARIANT_DURATION_TOLERANCE_SEC);
    return outDuration >= minExpectedDuration;
  } catch (e) {
    return false;
  }
}

async function ensureMobileVariantWithTimeout(category, filename, timeoutMs = MOBILE_VARIANT_WAIT_MS) {
  try {
    return await Promise.race([
      ensureMobileVariant(category, filename),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
    ]);
  } catch (e) {
    return null;
  }
}

function streamFileWithRange(req, res, filePath) {
  if (!fsSync.existsSync(filePath)) {
    res.status(404).end();
    return;
  }

  const stat = fsSync.statSync(filePath);
  const size = stat.size;
  const range = req.headers.range;
  const contentType = contentTypeForFile(filePath);
  const wantsDownload = String((req.query && req.query.download) || '').toLowerCase();

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  if (wantsDownload === '1' || wantsDownload === 'true') {
    const safeName = path.basename(filePath).replace(/"/g, '');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  }

  if (!range) {
    res.status(200);
    res.setHeader('Content-Length', size);
    const stream = fsSync.createReadStream(filePath);
    stream.on('error', (err) => {
      console.warn('stream error (full):', filePath, err && err.message);
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        try { res.destroy(); } catch (e) { }
      }
    });
    req.on('aborted', () => { try { stream.destroy(); } catch (e) { } });
    res.on('close', () => {
      if (!res.writableEnded) {
        try { stream.destroy(); } catch (e) { }
      }
    });
    stream.pipe(res);
    return;
  }

  const match = /bytes=(\d*)-(\d*)/.exec(String(range));
  if (!match) {
    res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
    return;
  }

  let start = match[1] ? parseInt(match[1], 10) : 0;
  let end = match[2] ? parseInt(match[2], 10) : size - 1;

  if (!Number.isFinite(start) || start < 0) start = 0;
  if (!Number.isFinite(end) || end >= size) end = size - 1;
  if (start > end || start >= size) {
    res.status(416).setHeader('Content-Range', `bytes */${size}`).end();
    return;
  }

  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', end - start + 1);
  const stream = fsSync.createReadStream(filePath, { start, end });
  stream.on('error', (err) => {
    console.warn('stream error (range):', filePath, err && err.message);
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      try { res.destroy(); } catch (e) { }
    }
  });
  req.on('aborted', () => { try { stream.destroy(); } catch (e) { } });
  res.on('close', () => {
    if (!res.writableEnded) {
      try { stream.destroy(); } catch (e) { }
    }
  });
  stream.pipe(res);
}

// Load configuration - handles cross-platform path setup
const { isValid, errors } = config.validate();
if (!isValid) {
  console.error('Configuration Error:');
  errors.forEach(err => console.error(err));
  console.error('\nPlease configure VIDEO_SOURCE_DIR in config.js or set the VIDEO_SOURCE_DIR environment variable.');
  process.exit(1);
}

const videosRoot = config.videoRoot;

// Serve the front-end static files from project root
app.use(express.static(path.join(__dirname)));

// Mobile-aware video delivery with range support.
app.get('/videos/:category/:filename', async (req, res, next) => {
  try {
    const category = decodeURIComponent(req.params.category || '');
    const filename = decodeURIComponent(req.params.filename || '');
    const sourcePath = resolveSafeVideoPath(category, filename);
    if (!sourcePath) return res.status(400).end();

    const ext = path.extname(filename || '').toLowerCase();
    const isVideo = VIDEO_EXT_RE.test(filename || '');

    if (!fsSync.existsSync(sourcePath)) {
      return next();
    }

    if (!isVideo) {
      streamFileWithRange(req, res, sourcePath);
      return;
    }

    const wantsMobile = isLikelyMobileRequest(req);
    const mustUseMobileVariant = wantsMobile && ext !== '.mp4';

    if (wantsMobile) {
      const mobilePath = getMobileVariantPath(category, filename);
      if (fsSync.existsSync(mobilePath)) {
        const cachedUsable = await isMobileVariantUsable(sourcePath, mobilePath);
        if (cachedUsable) {
          res.setHeader('X-Video-Variant', 'mobile-cached');
          streamFileWithRange(req, res, mobilePath);
          return;
        }
        try { await fs.unlink(mobilePath); } catch (e) { }
        res.setHeader('X-Video-Variant', 'mobile-cache-invalid-rebuild');
      }

      if (mustUseMobileVariant) {
        const builtNonMp4Path = await ensureMobileVariantWithTimeout(category, filename, MOBILE_VARIANT_NON_MP4_WAIT_MS);
        if (builtNonMp4Path && fsSync.existsSync(builtNonMp4Path)) {
          res.setHeader('X-Video-Variant', 'mobile-generated');
          streamFileWithRange(req, res, builtNonMp4Path);
          return;
        }

        ensureMobileVariant(category, filename).catch(() => {});
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Retry-After', '1');
        return res.status(503).json({ ok: false, error: 'Preparing mobile-compatible stream, retry in 1s.' });
      }

      const builtMp4Path = await ensureMobileVariantWithTimeout(category, filename, 2800);
      if (builtMp4Path && fsSync.existsSync(builtMp4Path)) {
        res.setHeader('X-Video-Variant', 'mobile-generated-from-mp4');
        streamFileWithRange(req, res, builtMp4Path);
        return;
      }

      ensureMobileVariant(category, filename).catch(() => {});
    }

    if (ext === '.mp4') {
      res.setHeader('X-Video-Variant', wantsMobile ? 'origin-fallback-building-mobile' : 'origin');
    } else {
      res.setHeader('X-Video-Variant', 'origin-nonmobile');
    }
    streamFileWithRange(req, res, sourcePath);
  } catch (err) {
    console.warn('video route error:', err && err.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'video streaming failed' });
    }
    try { res.end(); } catch (e) { }
  }
});

app.get('/hls/:category/:filename/:asset', async (req, res) => {
  try {
    const category = decodeURIComponent(req.params.category || '');
    const filename = decodeURIComponent(req.params.filename || '');
    const asset = decodeURIComponent(req.params.asset || '');
    if (!category || !filename || !asset) {
      return res.status(400).json({ ok: false, error: 'invalid hls path' });
    }

    const settings = getEffectiveStreamSettings();
    const variantDir = getHlsVariantDir(category, filename, settings);
    const playlistPath = getHlsPlaylistPath(category, filename, settings);
    const safeRoot = path.resolve(variantDir) + path.sep;
    const assetPath = path.resolve(variantDir, asset);
    if (!assetPath.startsWith(safeRoot)) {
      return res.status(400).json({ ok: false, error: 'invalid asset path' });
    }

    const sourcePath = resolveSafeVideoPath(category, filename);
    if (!sourcePath || !fsSync.existsSync(sourcePath)) {
      return res.status(404).json({ ok: false, error: 'source video missing' });
    }

    const isPlaylistRequest = asset.toLowerCase() === 'index.m3u8';
    if (isPlaylistRequest && !fsSync.existsSync(playlistPath)) {
      const built = await ensureHlsVariantWithTimeout(category, filename, HLS_PREPARE_WAIT_MS, settings);
      if (!built || !fsSync.existsSync(playlistPath)) {
        ensureHlsVariant(category, filename, settings).catch(() => {});
        return res.status(503).setHeader('Retry-After', '2').json({ ok: false, error: 'hls not ready' });
      }
    }

    if (!fsSync.existsSync(assetPath)) {
      return res.status(404).json({ ok: false, error: 'hls asset missing' });
    }

    const ext = path.extname(assetPath).toLowerCase();
    if (ext === '.m3u8') {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'public, max-age=2, stale-while-revalidate=20');
    } else if (ext === '.ts') {
      res.setHeader('Content-Type', 'video/mp2t');
      res.setHeader('Cache-Control', 'public, max-age=900, immutable');
    }

    streamFileWithRange(req, res, assetPath);
  } catch (err) {
    console.warn('hls route error:', err && err.message);
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, error: 'hls streaming failed' });
    }
    try { res.end(); } catch {}
  }
});

// Fallback static middleware for nested assets, if present.
app.use('/videos', express.static(videosRoot, { extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi'] }));

async function ensureDir(dir) {
  try { await fs.mkdir(dir, { recursive: true }); } catch (e) { }
}

// Fire-and-forget thumbnail generator using ffmpeg. Logs errors but doesn't block.
// Thumbnails are cached as WebP images for faster loading
async function generateThumbnailIfMissing(category, filename) {
  try {
    if (ffmpegDisabled) return;

    const base = filename.replace(/\.[^/.]+$/, '');
    const outDir = path.join(videosRoot, category);
    const outPath = path.join(outDir, base + '.webp');
    try { await fs.access(outPath); return; } catch (e) { /* missing */ }

    await ensureDir(outDir);
    const videoPath = path.join(videosRoot, category, filename);

    // Detect video duration to handle short videos better
    let duration = null;
    try {
      duration = await getVideoDuration(videoPath);
    } catch (e) {
      // Proceed with default seek time if duration detection fails
    }

    // For videos < 0.5 seconds, seek to a fraction of duration or use frame 0
    let seekTime = '0.5';
    if (duration !== null) {
      if (duration < 0.5) {
        // For very short videos, use 20% of the duration, minimum 0
        seekTime = String(Math.max(0, duration * 0.2));
      } else {
        // For normal videos, seek to 0.5 seconds as before
        seekTime = '0.5';
      }
    }

    const args = ['-ss', seekTime, '-i', videoPath, '-frames:v', '1', '-vf', 'scale=640:-1', '-y', outPath];
    
    await new Promise((resolve) => {
      const ff = spawn(ffmpegBin, args, { stdio: 'ignore' });
      ff.on('error', (err) => {
        if (!ffmpegErrorLogged) {
          console.warn('ffmpeg spawn error:', err.message, '| binary:', ffmpegBin);
          ffmpegErrorLogged = true;
        }
        if (err && err.code === 'ENOENT') {
          ffmpegDisabled = true;
        }
        resolve();
      });
      ff.on('exit', (code) => {
        if (code !== 0) {
          console.warn('ffmpeg exited with code', code, 'for thumbnail:', videoPath);
        }
        resolve();
      });
    });
  } catch (err) {
    console.warn('Thumbnail generation failed', category, filename, err && err.message);
  }
}

// Modify this function to generate a thumbnail for the "next" video before it's used in the display
async function generateNextThumbnailIfNeeded(posts) {
  try {
    for (const post of posts) {
      const filePath = post.videoUrl.replace('/videos/', '');
      const category = filePath.split('/')[0];
      const filename = filePath.split('/')[1];
      await generateThumbnailIfMissing(category, filename);
    }
  } catch (err) {
    console.warn('Failed to generate thumbnail for upcoming video(s)', err && err.message);
  }
}

// global seed for deterministic pseudo-random generation (set once at startup)
const GLOBAL_SEED = crypto.randomBytes(4).readUInt32LE(0);

// user behavior: { "category/file.mp4": { watchTime: seconds, likes: 0/1 } }
let userBehavior = {};
let fileMap = {};
let categories = [];
let cacheReady = false;
let catalogKeySet = new Set();
const recentQueue = [];
const recentSet = new Set();
const recommender = require('./recommender');
const DEEP_INDEX_PATH = process.env.ARCINITY_DEEP_INDEX_PATH || path.join(config.dataDir, 'deep-learning-index.json');
let recommendationMode = { enhancedEnabled: false };
let deepIndexCache = createEmptyDeepIndexCache();

function createEmptyDeepIndexCache() {
  return {
    mtimeMs: -1,
    byKey: new Map(),
    featureByKey: new Map(),
    items: [],
    keyToIndex: {},
    labels: [],
    centroids: [],
    valid: false,
  };
}

function hashToSeed(input) {
  const h = crypto.createHash('md5').update(String(input || '')).digest();
  return h.readUInt32LE(0);
}

function tokenizeText(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function sparseHashedTextVector(text, size = 32) {
  const vec = new Array(size).fill(0);
  for (const token of tokenizeText(text)) {
    const seed = hashToSeed(token);
    const idx = seed % size;
    vec[idx] += 1;
  }
  return vec;
}

function normalizeVector(vec) {
  const norm = Math.sqrt((vec || []).reduce((sum, x) => sum + (x || 0) * (x || 0), 0)) || 1;
  return (vec || []).map((x) => (x || 0) / norm);
}

function cosineSimilarity(a = [], b = []) {
  const len = Math.max(a.length, b.length);
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let i = 0; i < len; i++) {
    const av = Number(a[i] || 0);
    const bv = Number(b[i] || 0);
    dot += av * bv;
    an += av * av;
    bn += bv * bv;
  }
  const denom = (Math.sqrt(an) || 1) * (Math.sqrt(bn) || 1);
  return dot / denom;
}

function kmeans(data, k = 8, maxIter = 40) {
  if (!data.length) return { labels: [], centroids: [] };
  const dim = data[0].length;
  const rnd = mulberry32(987654321);
  const centroids = [];
  const used = new Set();

  while (centroids.length < Math.min(k, data.length)) {
    const idx = Math.floor(rnd() * data.length);
    if (used.has(idx)) continue;
    used.add(idx);
    centroids.push(data[idx].slice());
  }

  let labels = new Array(data.length).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = 0;
    for (let i = 0; i < data.length; i++) {
      let best = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        let dist = 0;
        const centroid = centroids[c];
        const vector = data[i];
        for (let j = 0; j < dim; j++) {
          const diff = (vector[j] || 0) - (centroid[j] || 0);
          dist += diff * diff;
        }
        if (dist < bestDistance) {
          bestDistance = dist;
          best = c;
        }
      }
      if (labels[i] !== best) {
        labels[i] = best;
        changed++;
      }
    }

    if (changed === 0) break;

    const counts = new Array(centroids.length).fill(0);
    for (let c = 0; c < centroids.length; c++) centroids[c] = new Array(dim).fill(0);
    for (let i = 0; i < data.length; i++) {
      const label = labels[i];
      counts[label]++;
      for (let j = 0; j < dim; j++) centroids[label][j] += (data[i][j] || 0);
    }
    for (let c = 0; c < centroids.length; c++) {
      if (!counts[c]) continue;
      for (let j = 0; j < dim; j++) centroids[c][j] /= counts[c];
    }
  }

  return { labels, centroids };
}

function flattenAudioFeatures(audioFeatures = {}) {
  const mfcc = Array.isArray(audioFeatures.mfcc) ? audioFeatures.mfcc.slice(0, 13) : [];
  const chroma = Array.isArray(audioFeatures.chroma) ? audioFeatures.chroma.slice(0, 12) : [];
  const scalars = [
    Number(audioFeatures.tempo || 0),
    Number(audioFeatures.spectral_centroid || 0),
    Number(audioFeatures.spectral_rolloff || 0),
    Number(audioFeatures.rms_energy || 0),
    Number(audioFeatures.zcr || 0),
  ];
  return mfcc.concat(chroma).concat(scalars);
}

function buildEnhancedFeature(key, fileName, indexEntry = {}) {
  const parsed = parseCatalogKey(key);
  const categoryVec = normalizeVector(sparseHashedTextVector(parsed ? parsed.category : '', 16)).map((value) => value * 0.45);
  const fileNameVec = normalizeVector(sparseHashedTextVector(fileName || '', 32)).map((value) => value * 0.75);
  const transcriptVec = normalizeVector(sparseHashedTextVector(indexEntry.transcript || '', 64)).map((value) => value * 1.2);
  const visual = normalizeVector(Array.isArray(indexEntry.visual_embedding) ? indexEntry.visual_embedding.slice(0, 128) : []).map((value) => value * 1.15);
  const audio = normalizeVector(flattenAudioFeatures(indexEntry.audio_features || {})).map((value) => value * 0.9);
  const transcriptLengthSignal = [Math.min(1, String(indexEntry.transcript || '').trim().length / 160)];
  const merged = categoryVec
    .concat(fileNameVec)
    .concat(transcriptVec)
    .concat(visual)
    .concat(audio)
    .concat(transcriptLengthSignal);
  return normalizeVector(merged);
}

function loadDeepIndexCache(forceReload = false) {
  let stat;
  try {
    stat = fsSync.statSync(DEEP_INDEX_PATH);
  } catch (e) {
    deepIndexCache = createEmptyDeepIndexCache();
    return deepIndexCache;
  }

  if (!forceReload && deepIndexCache.valid && deepIndexCache.mtimeMs === stat.mtimeMs) {
    return deepIndexCache;
  }

  try {
    const raw = fsSync.readFileSync(DEEP_INDEX_PATH, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    const videos = parsed && typeof parsed.videos === 'object' ? parsed.videos : {};
    const byKey = new Map();
    const featureByKey = new Map();
    const items = [];
    const keyToIndex = {};

    for (const [key, entry] of Object.entries(videos)) {
      if (!entry || typeof entry !== 'object') continue;
      const parsedKey = parseCatalogKey(key);
      if (!parsedKey) continue;
      byKey.set(key, entry);
      const feature = buildEnhancedFeature(key, parsedKey.file, entry);
      featureByKey.set(key, feature);
      keyToIndex[key] = items.length;
      items.push({
        key,
        category: parsedKey.category,
        file: parsedKey.file,
        feature,
        indexEntry: entry,
      });
    }

    const data = items.map((item) => item.feature);
    const k = Math.max(2, Math.min(18, Math.floor(Math.sqrt(Math.max(1, data.length)) + 1)));
    const { labels, centroids } = kmeans(data, k);

    deepIndexCache = {
      mtimeMs: stat.mtimeMs,
      byKey,
      featureByKey,
      items,
      keyToIndex,
      labels,
      centroids,
      valid: true,
    };
  } catch (e) {
    deepIndexCache = createEmptyDeepIndexCache();
  }

  return deepIndexCache;
}

function getDeepIndexCoverageStatus() {
  const cache = loadDeepIndexCache();
  const total = catalogKeySet.size;
  if (!cache.valid || total <= 0) {
    return { total, indexed: 0, pending: Math.max(0, total), fullyIndexed: false };
  }

  let indexed = 0;
  for (const key of catalogKeySet) {
    if (cache.byKey.has(key)) indexed++;
  }
  const pending = Math.max(0, total - indexed);
  return { total, indexed, pending, fullyIndexed: pending === 0 && total > 0 };
}

function setEnhancedRecommendationMode(enabled) {
  if (!enabled) {
    recommendationMode.enhancedEnabled = false;
    return { enabled: false, reason: 'disabled' };
  }

  const coverage = getDeepIndexCoverageStatus();
  if (!coverage.fullyIndexed) {
    recommendationMode.enhancedEnabled = false;
    return { enabled: false, reason: 'index-not-ready', coverage };
  }

  recommendationMode.enhancedEnabled = true;
  return { enabled: true, reason: 'enabled', coverage };
}

function getBehaviorWeight(meta = {}, now = Date.now()) {
  const watchTime = Number(meta.watchTime || 0);
  const likes = Number(meta.likes || 0);
  const lastSeenAt = Number(meta.lastSeenAt || 0);
  const base = watchTime + (likes * 3);
  if (!lastSeenAt) return base;
  const ageMs = Math.max(0, now - lastSeenAt);
  const decay = Math.exp(-ageMs / (7 * 24 * 60 * 60 * 1000));
  return base * decay;
}

function getPopularityBoost(meta = {}) {
  const views = Number(meta.views || 0);
  return Math.log(views + 1) * 0.05;
}

function getSkipPenalty(meta = {}) {
  const skips = Number(meta.skips || 0);
  return skips * 0.08;
}

function getTrendScore(meta = {}, now = Date.now()) {
  const views = Number(meta.views || 0);
  const base = Math.log(views + 1);
  const lastSeenAt = Number(meta.lastSeenAt || 0);
  if (!lastSeenAt) return base;
  const ageMs = Math.max(0, now - lastSeenAt);
  const recency = Math.exp(-ageMs / (7 * 24 * 60 * 60 * 1000));
  return base + recency;
}

function getRecentCategoryCounts(recentKeys = []) {
  const counts = {};
  for (const key of recentKeys || []) {
    const parsed = parseCatalogKey(key);
    if (!parsed) continue;
    counts[parsed.category] = (counts[parsed.category] || 0) + 1;
  }
  return counts;
}

function getEnhancedRecentClusterCounts(cache, recentKeys = []) {
  const counts = {};
  if (!cache || !cache.items.length) return counts;
  for (const key of recentKeys || []) {
    const index = cache.keyToIndex[key];
    if (index === undefined) continue;
    const label = cache.labels[index];
    if (label === undefined || label === null) continue;
    counts[label] = (counts[label] || 0) + 1;
  }
  return counts;
}

function buildEnhancedUserProfile(cache, currentBehavior = {}) {
  if (!cache || !cache.items.length) return null;
  const dim = cache.items[0].feature.length;
  const userKeys = Object.keys(currentBehavior || {}).filter((key) => cache.keyToIndex[key] !== undefined);
  if (!userKeys.length) return null;

  const profile = new Array(dim).fill(0);
  let totalWeight = 0;
  const now = Date.now();
  for (const key of userKeys) {
    const meta = currentBehavior[key] || {};
    const weight = getBehaviorWeight(meta, now);
    const index = cache.keyToIndex[key];
    if (index === undefined || weight <= 0) continue;
    const feature = cache.items[index].feature;
    for (let j = 0; j < dim; j++) profile[j] += (feature[j] || 0) * weight;
    totalWeight += weight;
  }

  if (totalWeight <= 0) return null;
  for (let j = 0; j < dim; j++) profile[j] /= totalWeight;
  return normalizeVector(profile);
}

function buildEnhancedMultiInterestProfiles(cache, currentBehavior = {}, maxInterests = 4) {
  if (!cache || !cache.items.length) return [];
  const dim = cache.items[0].feature.length;
  const now = Date.now();
  const perCluster = new Map();

  for (const key of Object.keys(currentBehavior || {})) {
    const index = cache.keyToIndex[key];
    if (index === undefined) continue;
    const label = cache.labels[index];
    if (label === undefined || label === null) continue;

    const weight = getBehaviorWeight(currentBehavior[key] || {}, now);
    if (weight <= 0) continue;

    if (!perCluster.has(label)) {
      perCluster.set(label, { label, weight: 0, vector: new Array(dim).fill(0) });
    }

    const cluster = perCluster.get(label);
    cluster.weight += weight;
    const feature = cache.items[index].feature;
    for (let j = 0; j < dim; j++) cluster.vector[j] += (feature[j] || 0) * weight;
  }

  const clusters = Array.from(perCluster.values())
    .filter((cluster) => cluster.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, Math.max(1, maxInterests));

  for (const cluster of clusters) {
    for (let j = 0; j < cluster.vector.length; j++) cluster.vector[j] /= cluster.weight;
    cluster.vector = normalizeVector(cluster.vector);
  }

  return clusters;
}

function pickEnhancedClusterExploreCandidate(cache, candidates = []) {
  if (!cache || !Array.isArray(candidates) || !candidates.length) return null;
  const byLabel = new Map();
  for (const candidate of candidates) {
    const index = cache.keyToIndex[candidate.key];
    if (index === undefined) continue;
    const label = cache.labels[index];
    if (label === undefined || label === null) continue;
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(candidate);
  }

  const labels = Array.from(byLabel.keys());
  if (!labels.length) return candidates[Math.floor(Math.random() * candidates.length)] || null;

  const label = labels[Math.floor(Math.random() * labels.length)];
  const pool = byLabel.get(label) || [];
  return pool[Math.floor(Math.random() * pool.length)] || candidates[Math.floor(Math.random() * candidates.length)] || null;
}

function recommendWithEnhancedIndex(limit = 6) {
  const cache = loadDeepIndexCache();
  if (!cache.valid || !cache.items.length) return [];

  const idx = cache.items;
  const profile = buildEnhancedUserProfile(cache, userBehavior);
  const interests = buildEnhancedMultiInterestProfiles(cache, userBehavior, 4);
  const recentClusterCounts = getEnhancedRecentClusterCounts(cache, recentQueue);
  const recentCategoryCounts = getRecentCategoryCounts(recentQueue);

  const scored = [];
  for (let i = 0; i < idx.length; i++) {
    const item = idx[i];
    if (recentSet.has(item.key)) continue;

    const meta = userBehavior[item.key] || {};
    const views = Number(meta.views || 0);
    const label = cache.labels[i];
    const centroid = label !== undefined ? cache.centroids[label] : null;

    let relevance = profile ? cosineSimilarity(profile, item.feature) : 0;
    if (interests.length) {
      let bestInterest = -Infinity;
      let secondBestInterest = -Infinity;
      for (const interest of interests) {
        const similarity = cosineSimilarity(interest.vector, item.feature);
        if (similarity > bestInterest) {
          secondBestInterest = bestInterest;
          bestInterest = similarity;
        } else if (similarity > secondBestInterest) {
          secondBestInterest = similarity;
        }
      }
      if (bestInterest > -Infinity) {
        relevance = Math.max(relevance, bestInterest);
        if (secondBestInterest > -Infinity) {
          relevance += secondBestInterest * 0.12;
        }
      }
    }
    if (!profile && !interests.length) {
      relevance = getTrendScore(meta, Date.now()) * 0.08;
    }

    const centroidBoost = centroid ? cosineSimilarity(centroid, item.feature) * 0.08 : 0;
    const clusterPenalty = (recentClusterCounts[label] || 0) * 0.15;
    const categoryPenalty = (recentCategoryCounts[item.category] || 0) * 0.1;
    const popBoost = getPopularityBoost(meta);
    const skipPenalty = getSkipPenalty(meta);
    const score = relevance + centroidBoost + popBoost - clusterPenalty - categoryPenalty - skipPenalty;
    scored.push({ i, key: item.key, score, item });
  }

  if (!scored.length) return [];

  const selected = [];
  const selectedKeys = new Set();
  if (scored.length && Math.random() < 0.12) {
    const exploreItem = pickEnhancedClusterExploreCandidate(cache, scored.map((entry) => entry.item));
    let pick = null;
    if (exploreItem) {
      const pos = scored.findIndex((entry) => entry.key === exploreItem.key);
      if (pos >= 0) pick = scored.splice(pos, 1)[0];
    }
    if (pick) {
      selected.push(pick);
      selectedKeys.add(pick.key);
    }
  }

  const lambda = 0.6;
  scored.sort((a, b) => b.score - a.score);
  while (selected.length < limit && scored.length) {
    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let p = 0; p < scored.length; p++) {
      const candidate = scored[p];
      if (selectedKeys.has(candidate.key)) continue;
      let maxSim = 0;
      for (const chosen of selected) {
        maxSim = Math.max(maxSim, cosineSimilarity(idx[candidate.i].feature, idx[chosen.i].feature));
      }
      const mmr = lambda * candidate.score - (1 - lambda) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = p;
      }
    }
    if (bestIdx === -1) break;
    const take = scored.splice(bestIdx, 1)[0];
    selected.push(take);
    selectedKeys.add(take.key);
  }

  return selected.slice(0, limit).map((entry) => buildPost(entry.item.category, entry.item.file));
}

function recommendNextWithEnhancedIndex(lastKey, action) {
  const cache = loadDeepIndexCache();
  if (!cache.valid || !cache.items.length) return null;

  const idx = cache.items;
  const profile = buildEnhancedUserProfile(cache, userBehavior);
  const interests = buildEnhancedMultiInterestProfiles(cache, userBehavior, 4);
  const recentClusterCounts = getEnhancedRecentClusterCounts(cache, recentQueue);
  const recentCategoryCounts = getRecentCategoryCounts(recentQueue);
  const hasLast = !!lastKey && cache.keyToIndex[lastKey] !== undefined;
  const lastIndex = hasLast ? cache.keyToIndex[lastKey] : -1;
  const lastItem = hasLast ? idx[lastIndex] : null;
  const lastLabel = hasLast ? cache.labels[lastIndex] : null;
  const isSkip = action === 'skip';
  const isPositive = action === 'like' || action === 'watch' || action === 'complete';

  let candidates = [];
  for (let i = 0; i < idx.length; i++) {
    const item = idx[i];
    if (recentSet.has(item.key)) continue;
    if (lastKey && item.key === lastKey) continue;

    if (hasLast && lastLabel !== null && lastLabel !== undefined) {
      const label = cache.labels[i];
      if (isPositive && label !== lastLabel) continue;
      if (isSkip && label === lastLabel) continue;
    }

    candidates.push(item);
  }

  if (!candidates.length) {
    candidates = idx.filter((item) => !recentSet.has(item.key) && item.key !== lastKey);
  }

  if (!candidates.length) return null;

  if (Math.random() < 0.12) {
    const explore = pickEnhancedClusterExploreCandidate(cache, candidates);
    return explore || candidates[Math.floor(Math.random() * candidates.length)];
  }

  let best = null;
  let bestScore = -Infinity;

  for (const item of candidates) {
    let score = 0;
    if (lastItem) {
      const simLast = cosineSimilarity(lastItem.feature, item.feature);
      score += isSkip ? (1 - simLast) : simLast;
    }
    if (profile) {
      score += 0.4 * cosineSimilarity(profile, item.feature);
    }
    if (interests.length) {
      let bestInterest = -Infinity;
      for (const interest of interests) {
        const similarity = cosineSimilarity(interest.vector, item.feature);
        if (similarity > bestInterest) bestInterest = similarity;
      }
      if (bestInterest > -Infinity) score += 0.3 * bestInterest;
    }

    const itemIndex = cache.keyToIndex[item.key];
    const label = cache.labels[itemIndex];
    const centroid = label !== undefined ? cache.centroids[label] : null;
    score += centroid ? 0.08 * cosineSimilarity(centroid, item.feature) : 0;
    score -= (recentClusterCounts[label] || 0) * 0.15;
    score -= (recentCategoryCounts[item.category] || 0) * 0.1;
    score -= getSkipPenalty(userBehavior[item.key] || {});
    score += getPopularityBoost(userBehavior[item.key] || {});

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return best || candidates[0];
}

// Persistence paths and helpers
const DATA_DIR = config.dataDir;
const RECENT_PATH = config.getRecentPath();
const BEHAVIOR_PATH = config.getBehaviorPath();
const THUMB_FAILURES_PATH = config.getThumbFailuresPath();
let failedThumbKeys = new Set();

function loadThumbFailureRegistry() {
  try {
    if (!fsSync.existsSync(THUMB_FAILURES_PATH)) {
      failedThumbKeys = new Set();
      return;
    }
    const parsed = JSON.parse(fsSync.readFileSync(THUMB_FAILURES_PATH, 'utf8') || '{}');
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    const rootId = (process.platform === 'win32' ? path.resolve(videosRoot).toLowerCase() : path.resolve(videosRoot)) + '::';
    failedThumbKeys = new Set(
      entries
        .filter((entry) => typeof entry === 'string' && entry.startsWith(rootId))
        .map((entry) => entry.slice(rootId.length))
    );
  } catch (e) {
    failedThumbKeys = new Set();
    console.warn('Failed to load thumbnail failure registry', e && e.message);
  }
}

async function ensureDataDir() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch (e) { }
}

async function saveRecent() {
  try {
    await ensureDataDir();
    await fs.writeFile(RECENT_PATH, JSON.stringify({ queue: recentQueue }), 'utf8');
  } catch (e) { console.warn('Failed to save recent.json', e && e.message); }
}

async function saveBehavior() {
  try {
    await ensureDataDir();
    await fs.writeFile(BEHAVIOR_PATH, JSON.stringify(userBehavior), 'utf8');
  } catch (e) { console.warn('Failed to save behavior.json', e && e.message); }
}

async function ensureDataFiles() {
  await ensureDataDir();

  // Create missing data files with safe defaults.
  try {
    await fs.access(RECENT_PATH);
  } catch (e) {
    await fs.writeFile(RECENT_PATH, JSON.stringify({ queue: [] }), 'utf8');
  }

  try {
    await fs.access(BEHAVIOR_PATH);
  } catch (e) {
    await fs.writeFile(BEHAVIOR_PATH, JSON.stringify({}), 'utf8');
  }
}

async function loadPersistent() {
  try {
    await ensureDataFiles();
    try {
      const b = await fs.readFile(RECENT_PATH, 'utf8');
      const parsed = JSON.parse(b || '{}');
      const q = Array.isArray(parsed.queue) ? parsed.queue : [];
      recentQueue.length = 0;
      for (const k of q) { recentQueue.push(k); }
      recentSet.clear();
      for (const k of recentQueue) recentSet.add(k);
    } catch (e) {
      // Recreate/reset invalid file contents so subsequent runs stay healthy.
      await fs.writeFile(RECENT_PATH, JSON.stringify({ queue: [] }), 'utf8');
      recentQueue.length = 0;
      recentSet.clear();
    }

    try {
      const b2 = await fs.readFile(BEHAVIOR_PATH, 'utf8');
      const parsed2 = JSON.parse(b2 || '{}');
      // replace contents of userBehavior
      Object.keys(userBehavior).forEach(k=>delete userBehavior[k]);
      if (parsed2 && typeof parsed2 === 'object') Object.assign(userBehavior, parsed2);
    } catch (e) {
      await fs.writeFile(BEHAVIOR_PATH, JSON.stringify({}), 'utf8');
      Object.keys(userBehavior).forEach(k=>delete userBehavior[k]);
    }

    console.log('Loaded persistent state: recent=', recentQueue.length, 'behavior=', Object.keys(userBehavior).length);
  } catch (e) {
    console.warn('Failed loading persistent state', e && e.message);
  }
}

// Ensure persisted state is flushed on shutdown
process.on('SIGINT', () => {
  try {
    fsSync.writeFileSync(RECENT_PATH, JSON.stringify({ queue: recentQueue }), 'utf8');
    fsSync.writeFileSync(BEHAVIOR_PATH, JSON.stringify(userBehavior), 'utf8');
  } catch (e) { /* best-effort */ }
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection in server process:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception in server process:', err && (err.stack || err.message || err));
});

process.on('warning', (warning) => {
  console.warn('Node warning:', warning && (warning.stack || warning.message || warning));
});

function safeSetInterval(task, ms, label) {
  return setInterval(() => {
    try {
      const maybePromise = task();
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.catch((err) => {
          console.warn(`Interval task failed (${label || 'unnamed'}):`, err && (err.stack || err.message || err));
        });
      }
    } catch (err) {
      console.warn(`Interval task threw (${label || 'unnamed'}):`, err && (err.stack || err.message || err));
    }
  }, ms);
}

function rebuildCatalogKeySet() {
  const next = new Set();
  for (const cat of Object.keys(fileMap || {})) {
    const files = fileMap[cat] || [];
    for (const file of files) next.add(`${cat}/${file}`);
  }
  catalogKeySet = next;
}

function pruneRecentAgainstCatalog() {
  if (!catalogKeySet.size) {
    recentQueue.length = 0;
    recentSet.clear();
    return;
  }

  const deduped = [];
  const seen = new Set();
  for (const key of recentQueue) {
    if (!catalogKeySet.has(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(key);
  }

  recentQueue.length = 0;
  recentSet.clear();
  for (const key of deduped) {
    recentQueue.push(key);
    recentSet.add(key);
  }
}

function resetSeenCycle() {
  recentQueue.length = 0;
  recentSet.clear();
  saveRecent().catch(() => {});
}

function ensureUnseenPool() {
  if (!catalogKeySet.size) return;
  if (recentSet.size >= catalogKeySet.size) {
    // Start a new cycle only after every available video has been shown once.
    resetSeenCycle();
  }
}

function collectUnseenItems() {
  const unseen = [];
  for (const cat of categories) {
    const files = fileMap[cat] || [];
    for (const file of files) {
      const key = `${cat}/${file}`;
      if (!recentSet.has(key)) unseen.push({ key, cat, file });
    }
  }
  return unseen;
}

// random number generator function
function mulberry32(a) {
  return function () {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Populate fileMap by scanning the categories. Called periodically to
// pick up new files added to disk.
async function buildCache() {
  try {
    loadThumbFailureRegistry();
    const entries = await fs.readdir(videosRoot, { withFileTypes: true });
    const cats = entries.filter(e => e.isDirectory()).map(d => d.name).sort();

    const map = {};
    for (const cat of cats) {
      try {
        const files = await fs.readdir(path.join(videosRoot, cat));
        const vids = files
          .filter(f => /\.(mp4|mov|webm|mkv|avi)$/i.test(f))
          .filter(f => !failedThumbKeys.has(`${cat}/${f}`))
          .sort();
        if (vids.length) map[cat] = vids.slice();
      } catch (err) {
        console.warn('Error reading category', cat, err.message);
      }
    }

    fileMap = map;
    categories = Object.keys(fileMap);
    rebuildCatalogKeySet();
    pruneRecentAgainstCatalog();
    ensureUnseenPool();
    if (recommendationMode.enhancedEnabled) {
      const coverage = getDeepIndexCoverageStatus();
      if (!coverage.fullyIndexed) {
        recommendationMode.enhancedEnabled = false;
      }
    }
    if (failedThumbKeys.size) {
      console.log(`Built file map with ${categories.length} categories. Excluding ${failedThumbKeys.size} video(s) with failed thumbnails.`);
    } else {
      console.log(`Built file map with ${categories.length} categories.`);
    }
    // update recommender index in background
    try { recommender.buildIndex(fileMap).catch(()=>{}); } catch (e) { }
  } catch (err) {
    console.error('Error building videos file map', err && err.message);
    fileMap = {};
    categories = [];
  }
}

// Generate posts for a given range [offset, offset+limit).
function generatePostsRange(offset, limit) {
  const out = [];
  if (!categories || categories.length === 0) return out;
  if (limit <= 0) return out;

  ensureUnseenPool();

  const unseen = collectUnseenItems();
  if (!unseen.length) return out;

  const take = Math.min(limit, unseen.length);
  const rnd = mulberry32((GLOBAL_SEED + offset + unseen.length) >>> 0);

  // Partial Fisher-Yates to sample without replacement.
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rnd() * (unseen.length - i));
    const tmp = unseen[i];
    unseen[i] = unseen[j];
    unseen[j] = tmp;
  }

  for (let i = 0; i < take; i++) {
    const { key, cat, file } = unseen[i];
    generateThumbnailIfMissing(cat, file);
    out.push(buildPost(cat, file));
    recordRecentKey(key);
  }

  // Pre-generate thumbnails for upcoming videos (next videos in the queue)
  generateNextThumbnailIfNeeded(out);

  return out;
}

function recordRecentKey(key) {
  if (!key || recentSet.has(key)) return;
  recentQueue.push(key);
  recentSet.add(key);
  saveRecent().catch(() => {});
}

function buildPost(cat, file) {
  const base = file.replace(/\.[^/.]+$/, '') + '.webp';
  const settings = getEffectiveStreamSettings();
  const hlsUrl = buildHlsUrl(cat, file);
  const ext = path.extname(String(file || '')).toLowerCase();
  const forceMobileVariant = ext === '.mov';

  ensureHlsVariant(cat, file, settings).catch(() => {});
  if (forceMobileVariant) {
    ensureMobileVariant(cat, file).catch(() => {});
  }

  return {
    videoUrl: `/videos/${encodeURIComponent(cat)}/${encodeURIComponent(file)}`,
    hlsUrl,
    forceMobileVariant,
    thumbnailUrl: `/videos/${encodeURIComponent(cat)}/${encodeURIComponent(base)}`,
    user: cat,
    caption: file,
    song: ''
  };
}

function pickRandomPost() {
  if (!categories || categories.length === 0) return null;
  ensureUnseenPool();
  const unseen = collectUnseenItems();
  if (!unseen.length) return null;
  const rnd = mulberry32((GLOBAL_SEED + Date.now() + unseen.length) >>> 0);
  const pick = unseen[Math.floor(rnd() * unseen.length)];
  return pick ? { key: pick.key, cat: pick.cat, file: pick.file } : null;
}

function pickNextItem(lastKey, action) {
  ensureUnseenPool();
  let item = null;
  if (recommendationMode.enhancedEnabled) {
    item = recommendNextWithEnhancedIndex(lastKey, action);
  }
  if (!item) {
    item = recommender.recommendNext({ lastKey, action, userBehavior, recentSet, recentKeys: recentQueue });
  }
  if (!item) {
    const fallback = pickRandomPost();
    if (!fallback) return null;
    item = { key: fallback.key, category: fallback.cat, file: fallback.file };
  }

  const key = item.key || `${item.category}/${item.file}`;
  const cat = item.category;
  const file = item.file;
  if (!cat || !file) return null;

  generateThumbnailIfMissing(cat, file);
  // Warm a mobile variant in the background for faster phone playback.
  ensureMobileVariant(cat, file).catch(() => {});
  if (shouldUseHlsStreaming()) {
    ensureHlsVariant(cat, file, getEffectiveStreamSettings()).catch(() => {});
  }
  return { key, category: cat, file };
}

function generateCategoryNextPost(categoryFilter) {
  const category = String(categoryFilter || '').trim();
  if (!category) return null;

  const files = fileMap[category] || [];
  if (!files.length) return null;

  const unseen = files.filter((file) => !recentSet.has(`${category}/${file}`));
  const pool = unseen.length ? unseen : files;
  if (!pool.length) return null;

  const rnd = mulberry32((GLOBAL_SEED + Date.now() + pool.length) >>> 0);
  const file = pool[Math.floor(rnd() * pool.length)];
  if (!file) return null;

  const key = `${category}/${file}`;
  generateThumbnailIfMissing(category, file);
  ensureMobileVariant(category, file).catch(() => {});
  if (shouldUseHlsStreaming()) {
    ensureHlsVariant(category, file, getEffectiveStreamSettings()).catch(() => {});
  }
  recordRecentKey(key);
  return buildPost(category, file);
}

function generateNextPost(lastKey, action) {
  const item = pickNextItem(lastKey, action);
  if (!item) return null;
  recordRecentKey(item.key);
  return buildPost(item.category, item.file);
}

function makeContextSig(lastKey, action) {
  return `${lastKey || ''}::${action || ''}`;
}

let nextPrediction = null; // { contextSig, item }
let predictionInFlight = false;
let queuedPredictionContext = null;

async function runPredictionWorker() {
  if (predictionInFlight) return;
  predictionInFlight = true;
  try {
    while (queuedPredictionContext) {
      const ctx = queuedPredictionContext;
      queuedPredictionContext = null;
      const item = pickNextItem(ctx.lastKey, ctx.action);
      nextPrediction = item ? { contextSig: makeContextSig(ctx.lastKey, ctx.action), item } : null;
      await Promise.resolve();
    }
  } finally {
    predictionInFlight = false;
  }
}

function queuePrediction(lastKey, action) {
  queuedPredictionContext = { lastKey: lastKey || null, action: action || null };
  runPredictionWorker().catch(() => {});
}

function consumeOrGenerateNext(lastKey, action) {
  const contextSig = makeContextSig(lastKey, action);
  if (nextPrediction && nextPrediction.contextSig === contextSig && nextPrediction.item) {
    const item = nextPrediction.item;
    nextPrediction = null;
    recordRecentKey(item.key);
    return buildPost(item.category, item.file);
  }

  return generateNextPost(lastKey, action);
}

function parseCatalogKey(key) {
  if (!key || typeof key !== 'string') return null;
  const parts = key.split(/[\\/]/).filter(Boolean);
  if (parts.length < 2) return null;
  const category = parts[0];
  const file = parts.slice(1).join('/');
  if (!category || !file) return null;
  return { category, file };
}

function resolveVideoPathFromKey(key) {
  const parsed = parseCatalogKey(key);
  if (!parsed) return null;
  const { category, file } = parsed;

  const fullPath = path.resolve(videosRoot, category, file);
  const rootPath = path.resolve(videosRoot);
  if (!fullPath.startsWith(rootPath)) return null;
  return fullPath;
}

function openVideoFolderForKey(key) {
  const fullPath = resolveVideoPathFromKey(key);
  if (!fullPath) return false;
  if (!fsSync.existsSync(fullPath)) return false;

  if (process.platform === 'win32') {
    const folder = path.dirname(fullPath);
    const child = spawn('explorer.exe', [folder], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  }

  const folder = path.dirname(fullPath);
  if (process.platform === 'darwin') {
    const child = spawn('open', [folder], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  }

  const child = spawn('xdg-open', [folder], { detached: true, stdio: 'ignore' });
  child.unref();
  return true;
}

function getVideoMetadataForKey(key) {
  const fullPath = resolveVideoPathFromKey(key);
  if (!fullPath) return null;
  if (!fsSync.existsSync(fullPath)) return null;

  const st = fsSync.statSync(fullPath);
  const parsed = path.parse(fullPath);
  const keyParts = parseCatalogKey(key);
  const category = keyParts ? keyParts.category : '';

  const details = {
    Name: parsed.base,
    Category: category,
    FullPath: fullPath,
    Folder: parsed.dir,
    Extension: parsed.ext || '',
    SizeBytes: st.size,
    SizeMB: (st.size / (1024 * 1024)).toFixed(2),
    Created: st.birthtime,
    Modified: st.mtime,
    Accessed: st.atime,
    IsFile: st.isFile(),
    Device: st.dev,
    Inode: st.ino,
    Mode: st.mode,
    HardLinks: st.nlink,
    UID: st.uid,
    GID: st.gid,
    BlockSize: st.blksize,
    Blocks: st.blocks
  };

  return details;
}

// initial cache build and periodic refresh to avoid scanning on every request
// Load persisted state, then build cache and schedule periodic tasks
loadPersistent().then(() => {
  loadStreamSettings().catch(() => {});
  buildCache().then(() => { cacheReady = true; }).catch(() => { cacheReady = true; });
  safeSetInterval(buildCache, 30 * 1000, 'buildCache');
  // periodic flush of in-memory state
  safeSetInterval(() => Promise.all([saveRecent(), saveBehavior()]), 30 * 1000, 'flushState');
});

// API: return paginated posts (infinite generator)
// The endpoint mixes regular posts with personalized recommendations
app.get('/api/recommendation-mode', (_req, res) => {
  const coverage = getDeepIndexCoverageStatus();
  res.json({
    ok: true,
    enhancedEnabled: recommendationMode.enhancedEnabled,
    eligible: coverage.fullyIndexed,
    coverage,
  });
});

app.get('/api/stream-settings', (_req, res) => {
  const settings = getEffectiveStreamSettings();
  res.json({
    ok: true,
    settings,
    hlsEnabled: true,
  });
});

app.post('/api/stream-settings', async (req, res) => {
  const next = sanitizeStreamSettings((req && req.body) || {});
  await saveStreamSettings(next);
  res.json({
    ok: true,
    settings: getEffectiveStreamSettings(),
    hlsEnabled: true,
  });
});

app.post('/api/hls/prepare', async (req, res) => {
  const body = req.body || {};
  const key = body.key;
  const keys = Array.isArray(body.keys) ? body.keys : (key ? [key] : []);
  const parsedKeys = keys.map((value) => parseCatalogKey(value)).filter(Boolean);
  if (!parsedKeys.length) return res.status(400).json({ ok: false, error: 'invalid key' });

  const settings = getEffectiveStreamSettings();

  const waitMs = Math.max(250, Math.min(HLS_PREPARE_WAIT_MS, Number(body.waitMs || HLS_PREPARE_WAIT_MS)));
  const results = await Promise.all(
    parsedKeys.map(async (parsed) => {
      const built = await ensureHlsVariantWithTimeout(parsed.category, parsed.file, waitMs, settings);
      return { key: `${parsed.category}/${parsed.file}`, ready: Boolean(built) };
    })
  );

  const ready = results.every((result) => result.ready);
  res.json({ ok: true, ready, results });
});

app.post('/api/recommendation-mode', (req, res) => {
  const requested = !!(req.body && req.body.enhancedEnabled);
  const result = setEnhancedRecommendationMode(requested);
  const coverage = result.coverage || getDeepIndexCoverageStatus();
  res.json({
    ok: true,
    enhancedEnabled: recommendationMode.enhancedEnabled,
    requested,
    eligible: coverage.fullyIndexed,
    coverage,
    reason: result.reason || null,
  });
});

app.get('/api/posts', (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
  ensureUnseenPool();

  // Generate base posts from the catalog
  const posts = generatePostsRange(offset, Math.max(0, limit - 4));

  // Get personalized recommendations based on user behavior
  // Recommendations are mixed in to provide adaptive content
  let recs = [];
  try {
    if (recommendationMode.enhancedEnabled) {
      recs = recommendWithEnhancedIndex(6);
    }
    if (!recs || !recs.length) {
      recs = recommender.recommend(userBehavior, recentSet, 6, recentQueue);
    }
  } catch (e) {
    recs = [];
  }

  // Merge: put recommendations after regular posts
  const merged = posts.concat(recs);
  res.json({ total: Number.MAX_SAFE_INTEGER, posts: merged });
});

// API: return a single next post based on the last action
app.post('/api/next', (req, res) => {
  const { lastKey, action, categoryFilter } = req.body || {};
  ensureUnseenPool();

  if (!cacheReady) {
    return res.json({ post: null, initializing: true });
  }

  if (categoryFilter) {
    const categoryPost = generateCategoryNextPost(categoryFilter);
    return res.json({ post: categoryPost || null });
  }

  const next = consumeOrGenerateNext(lastKey, action);
  if (!next) return res.json({ post: null });
  res.json({ post: next });
});

// Queue a single background prediction based on latest behavior context.
app.post('/api/predict', (req, res) => {
  const { lastKey, action } = req.body || {};
  queuePrediction(lastKey, action);
  res.json({ ok: true });
});

// Open the folder containing the requested video in the OS file explorer.
app.post('/api/open-video-folder', (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ ok: false, error: 'missing key' });

  try {
    const opened = openVideoFolderForKey(key);
    if (!opened) return res.status(404).json({ ok: false, error: 'video not found' });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'failed to open folder' });
  }
});

// Return file metadata used by the comments drawer in the UI.
app.post('/api/video-metadata', (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ ok: false, error: 'missing key' });

  try {
    const details = getVideoMetadataForKey(key);
    if (!details) return res.status(404).json({ ok: false, error: 'video not found' });
    return res.json({ ok: true, details });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'failed to load metadata' });
  }
});

// Track user watch/interaction events. body: { key: "Category/file.mp4", watchTime: seconds, action: 'like'|'skip' }
// This data is used for adaptive recommendations and personalization
app.get('/api/pro-status', (_req, res) => {
  res.json({ ok: true, active: serverProStatus });
});

app.post('/api/pro-status', (req, res) => {
  if (req.body && typeof req.body.active === 'boolean') {
    serverProStatus = !!req.body.active;
  }
  res.json({ ok: true, active: serverProStatus });
});

app.post('/api/track', (req, res) => {
  const { key, watchTime = 0, action } = req.body || {};
  if (!key) return res.status(400).json({ ok: false, error: 'missing key' });

  // Initialize behavior tracking for new videos
  if (!userBehavior[key]) userBehavior[key] = { watchTime: 0, likes: 0, views: 0, skips: 0, lastSeenAt: 0 };
  if (userBehavior[key].views === undefined) userBehavior[key].views = 0;
  if (userBehavior[key].skips === undefined) userBehavior[key].skips = 0;
  userBehavior[key].lastSeenAt = Date.now();
  
  // Accumulate watch time
  userBehavior[key].watchTime += Number(watchTime || 0);
  
  // Track likes and skips
  if (action === 'like') userBehavior[key].likes = (userBehavior[key].likes || 0) + 1;
  if (action === 'watch' || action === 'complete') userBehavior[key].views = (userBehavior[key].views || 0) + 1;
  if (action === 'skip') {
    userBehavior[key].watchTime = Math.max(0, userBehavior[key].watchTime - 1);
    userBehavior[key].skips = (userBehavior[key].skips || 0) + 1;
  }

  // persist behavior (best-effort, non-blocking)
  saveBehavior().catch(()=>{});

  res.json({ ok: true });
});

// Last middleware: catch any route errors that bubbled through Express.
app.use((err, req, res, next) => {
  console.error('Express route error:', err && (err.stack || err.message || err));
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

httpServer.on('error', (err) => {
  console.error('HTTP server error:', err && (err.stack || err.message || err));
});

httpServer.on('clientError', (err, socket) => {
  const code = err && err.code;
  const benignReset = code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED';
  if (!benignReset) {
    console.warn('HTTP client error:', err && (err.message || err));
  }
  try {
    if (socket && !socket.destroyed && socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } else if (socket && !socket.destroyed) {
      socket.destroy();
    }
  } catch (e) { }
});

