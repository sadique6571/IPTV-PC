// IPTV Desktop — MPEG-2 live transcode (main process only).
//
// Chromium's MSE cannot decode MPEG-2 video at all, so raw MPEG-TS
// channels whose video codec is MPEG-2 (Geo Super: mpeg2video 720x576
// interlaced + MP2 audio) play as a black screen via mpegts.js. The fix
// is a local transcode: ffmpeg re-encodes the stream to H.264 + AAC HLS
// and serves it on a localhost HTTP server; the renderer plays that
// playlist through the existing hls.js path.
//
// The ffmpeg binary comes from the ffmpeg-static npm package:
//  - dev: require('ffmpeg-static') resolves the platform binary.
//  - packaged: scripts/prepare-ffmpeg.js copies it into ffmpeg-bin/
//    (electron-builder extraResources), resolved via resourcesPath.
// Only ONE transcode runs at a time (one player). It is stopped on
// channel change, on stop, and on app quit — never orphaned.
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

let server = null;
let serverPort = 0;
let current = null; // { proc, dir, sourceUrl, playlistUrl, startedAt, lastError, exited }

function ffmpegPath() {
  // Test/dev override (never set in production).
  if (process.env.IPTV_FFMPEG) return process.env.IPTV_FFMPEG;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  try {
    const { app } = require('electron');
    if (app.isPackaged) {
      const staged = path.join(process.resourcesPath, 'ffmpeg-bin', exe);
      if (fs.existsSync(staged)) return staged;
    }
  } catch (_) { /* fall through to the npm package */ }
  try {
    return require('ffmpeg-static');
  } catch (_) {
    return exe;
  }
}

function ensureServer() {
  return new Promise((resolve, reject) => {
    if (server) return resolve(serverPort);
    server = http.createServer((req, res) => {
      try {
        const name = decodeURIComponent(
          new URL(req.url, 'http://127.0.0.1').pathname,
        ).replace(/^\/+/, '');
        // Whitelist: only the playlist and numbered segments of the
        // CURRENT transcode — nothing else on disk is ever served.
        if (!current || !/^(live\.m3u8|seg\d+\.ts)$/.test(name)) {
          res.writeHead(404);
          res.end();
          return;
        }
        fs.readFile(path.join(current.dir, name), (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, {
            'Content-Type': name.endsWith('.m3u8')
              ? 'application/vnd.apple.mpegurl'
              : 'video/mp2t',
            'Cache-Control': 'no-cache',
            'Content-Length': data.length,
          });
          res.end(data);
        });
      } catch (_) {
        res.writeHead(400);
        res.end();
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve(serverPort);
    });
  });
}

function waitForFirstSegment(dir, entry, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (entry.exited) return resolve(false);
      try {
        const files = fs.readdirSync(dir);
        if (
          files.includes('live.m3u8') &&
          files.some((f) => /^seg\d+\.ts$/.test(f))
        ) {
          return resolve(true);
        }
      } catch (_) { /* dir not created yet */ }
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(tick, 400);
    };
    tick();
  });
}

// Start transcoding sourceUrl -> H.264/AAC HLS on localhost.
// Resolves { ok: true, playlistUrl } once the first segment exists
// (usually 2-4s on a fast link; a slow/proxied link can take ~15s,
// so the budget is 30s), or { ok: false, error } if ffmpeg fails to
// start or produces nothing within that budget. Idempotent for the
// same URL.
async function startTranscode(sourceUrl) {
  if (current && current.sourceUrl === sourceUrl && !current.exited) {
    return { ok: true, playlistUrl: current.playlistUrl };
  }
  stopTranscode();
  const bin = ffmpegPath();
  if (!bin || !fs.existsSync(bin)) {
    return { ok: false, error: 'ffmpeg binary not found: ' + bin };
  }
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iptv-transcode-'));
  } catch (e) {
    return { ok: false, error: 'temp dir failed: ' + String(e) };
  }
  let port;
  try {
    port = await ensureServer();
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    return { ok: false, error: 'localhost server failed: ' + String(e) };
  }
  const playlistUrl = `http://127.0.0.1:${port}/live.m3u8`;
  const args = [
    '-v', 'error',
    '-nostdin',
    // Live input: reconnect on transient drops instead of dying.
    '-reconnect', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-timeout', '15000000',
    '-i', sourceUrl,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    // Geo Super is interlaced 576i (field_order=bb) — deinterlace so
    // the picture has no combing. Harmless on progressive sources.
    '-vf', 'yadif=0:-1:0',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-g', '48',
    '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+append_list',
    '-hls_segment_filename', path.join(dir, 'seg%03d.ts'),
    path.join(dir, 'live.m3u8'),
  ];
  let proc;
  try {
    proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    return { ok: false, error: 'ffmpeg spawn failed: ' + String(e) };
  }
  const entry = {
    proc,
    dir,
    sourceUrl,
    playlistUrl,
    startedAt: Date.now(),
    lastError: '',
    exited: null,
  };
  current = entry;
  proc.stderr.on('data', (d) => {
    entry.lastError = (entry.lastError + d.toString()).slice(-4000);
  });
  proc.on('error', (e) => {
    entry.lastError = (entry.lastError + '\n' + String(e)).slice(-4000);
  });
  proc.on('exit', (code, signal) => {
    if (current === entry) entry.exited = { code, signal };
  });
  const ready = await waitForFirstSegment(dir, entry, 30000);
  if (!ready) {
    // Say HOW ffmpeg died (signal/exit code), not just that it did —
    // "produced no output" alone hid a segfault during development.
    let err = entry.lastError;
    if (!err && entry.exited) {
      const { code, signal } = entry.exited;
      err = `ffmpeg exited (${signal ? 'signal ' + signal : 'code ' + code}) with no output`;
    }
    err = err || 'ffmpeg produced no output';
    stopTranscode();
    return { ok: false, error: err };
  }
  return { ok: true, playlistUrl };
}

// Kill the ffmpeg process (SIGTERM, SIGKILL after 2s if it lingers)
// and remove the temp segments. Safe to call when nothing runs.
function stopTranscode() {
  const entry = current;
  current = null;
  if (!entry) return;
  try {
    if (entry.proc && !entry.proc.killed) {
      entry.proc.kill('SIGTERM');
      const proc = entry.proc;
      setTimeout(() => {
        try { if (!proc.killed) proc.kill('SIGKILL'); } catch (_) {}
      }, 2000).unref();
    }
  } catch (_) {}
  try {
    fs.rmSync(entry.dir, { recursive: true, force: true });
  } catch (_) {}
}

// Hard stop for app quit: kill immediately, no grace period.
function shutdown() {
  const entry = current;
  current = null;
  if (!entry) return;
  try {
    if (entry.proc && !entry.proc.killed) entry.proc.kill('SIGKILL');
  } catch (_) {}
  try {
    fs.rmSync(entry.dir, { recursive: true, force: true });
  } catch (_) {}
  try {
    if (server) server.close();
  } catch (_) {}
}

function status() {
  return {
    active: !!current,
    sourceUrl: current ? current.sourceUrl : null,
    playlistUrl: current ? current.playlistUrl : null,
    startedAt: current ? current.startedAt : null,
    pid: current && current.proc ? current.proc.pid : null,
    lastError: current ? current.lastError : '',
    ffmpeg: ffmpegPath(),
  };
}

module.exports = { startTranscode, stopTranscode, shutdown, status };
