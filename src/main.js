// IPTV Desktop — main process.
// Owns the window, the local state file (favorites / continue watching),
// the M3U file picker, and all MovieBox network calls (done here in Node
// so custom headers like Referer can be set — the renderer cannot set
// forbidden headers via fetch).
'use strict';

const { app, BrowserWindow, ipcMain, dialog, session, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const moviebox = require('./moviebox');
const updater = require('./updater');
const transcode = require('./transcode');
const youtube = require('./youtube');
const appId = 'com.sadique.iptv.desktop'; // Matches build.appId in package.json.

if (process.platform === 'win32') app.setAppUserModelId(appId);

let mainWindow = null;
// Current movie playback's file-request headers (see onBeforeSendHeaders).
// { host, referer, cookie } or null (live TV clears it).
let mediaHeaders = null;

function statePath() {
  return path.join(app.getPath('userData'), 'state.json');
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch (_) {
    return { favorites: [], continueWatching: {}, lastTab: 'tv' };
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('saveState failed:', e);
    return false;
  }
}

function roundWindowCorners(win) {
  if (process.platform !== 'win32') return;
  function updateShape() {
    if (win.isMinimized()) return;
    if (win.isMaximized() || win.isFullScreen()) {
      win.setShape([]);
      return;
    }
    const [width, height] = win.getContentSize();
    // Electron reports client bounds for a frameless resizable window, but
    // the Windows region starts at the outer edge of its resize frame.
    const frameInset = 8;
    const radius = Math.min(18, Math.floor(Math.min(width, height) / 2));
    if (!radius) return;
    const rows = [{ x: frameInset, y: radius, width, height: height - 2 * radius }];
    for (let y = 0; y < radius; y++) {
      const dy = radius - y - 0.5;
      const x = Math.round(radius - Math.sqrt(radius * radius - dy * dy));
      rows.push({ x: frameInset + x, y, width: width - 2 * x, height: 1 },
        { x: frameInset + x, y: height - 1 - y, width: width - 2 * x, height: 1 });
    }
    win.setShape(rows);
  }
  for (const event of ['resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) {
    win.on(event, updateShape);
  }
  updateShape();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 960,
    minHeight: 540,
    // Custom title bar (v1.0.3): frameless window — the app's own header
    // is the title bar (drag region + custom min/max/close buttons).
    // Native title bar + menu are gone; the window stays resizable.
    frame: false,
    resizable: true,
    backgroundColor: '#0b0e14',
    title: 'IPTV Desktop',
    // Same artwork as the Android launcher icon (assets/icon.png,
    // converted from iptv_icon.xml) — window + taskbar icon.
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Media hosts (channel streams, MovieBox CDNs) do not send CORS
      // headers; the Android app has no CORS concept either. The window
      // loads only local app files plus media streams — no remote web
      // content — so same-origin policy is disabled for playback.
      webSecurity: false,
    },
  });

  roundWindowCorners(mainWindow);
  mainWindow.webContents.once('did-finish-load', () => silentUpdateCheck());
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
  // Custom title bar: keep the maximise/restore button icon in sync.
  mainWindow.on('maximize', () => { if (mainWindow) mainWindow.webContents.send('window:maximize-changed', true); });
  mainWindow.on('unmaximize', () => { if (mainWindow) mainWindow.webContents.send('window:maximize-changed', false); });

  // Dev-only smoke-test hook: IPTV_SCREENSHOT=/tmp/shot.png captures the
  // window a few seconds after load and quits. Never set in production.
  if (process.env.IPTV_SCREENSHOT) {
    const out = process.env.IPTV_SCREENSHOT;
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      console.log(`[renderer ${level}]`, message.slice(0, 500));
    });
    setTimeout(async () => {
      try {
        const state = await mainWindow.webContents.executeJavaScript(
          `(() => { const v = document.getElementById('video'); const rows = document.querySelectorAll('#channelList .row').length; const e = window.__lastHlsError; const imgs = [...document.querySelectorAll('.card img, .row .logo')]; const loaded = imgs.filter((i) => i.naturalWidth > 0).length; return { readyState: v.readyState, currentTime: v.currentTime, paused: v.paused, videoWidth: v.videoWidth, videoHeight: v.videoHeight, src: (v.currentSrc || '').slice(0, 80), rows, imgs: imgs.length, imgsLoaded: loaded, status: document.getElementById('statusBar').textContent, qualityLevel: window.__qualityLevel || null, hlsError: e ? { type: e.type, details: e.details, fatal: e.fatal, url: (e.context && e.context.url) || '', responseCode: (e.networkDetails && e.networkDetails.status) || (e.response && e.response.code) || '' } : null, hlsLoaded: !!window.Hls, mpegtsLoaded: !!window.mpegts }; })()`,
        );
        console.log('VIDEO STATE:', JSON.stringify(state));
        const img = await mainWindow.capturePage();
        fs.writeFileSync(out, img.toPNG());
        console.log('screenshot saved:', out);
        try {
          console.log('TRANSCODE STATE:', JSON.stringify(await mainWindow.webContents.executeJavaScript(
            `(() => { const t = window.__transcode || null; return t ? { active: t.active, original: (t.original || '').slice(0, 60), playlist: (t.playlist || '').slice(0, 60) } : null; })()`,
          )));
        } catch (_) {}
      } catch (e) {
        console.error('screenshot failed:', e);
      }
      app.quit();
    }, Number(process.env.IPTV_WAIT_MS || 12000));
  }
}

// Dev-only: proxy auth for smoke tests in this sandbox (the sandbox
// egress proxy needs auth; Chromium asks via the 'login' event).
// Gated on IPTV_PROXY_AUTH=user:pass — never set in production, and the
// credentials never live in code. Without it, no proxy auth is supplied.
if (process.env.IPTV_PROXY_AUTH) {
  const [proxyUser, proxyPass] = process.env.IPTV_PROXY_AUTH.split(':');
  app.on('login', (event, _webContents, _details, authInfo, callback) => {
    if (authInfo.isProxy) {
      event.preventDefault();
      callback(proxyUser, proxyPass);
    }
  });
}

app.whenReady().then(() => {
  // No default Electron menu bar (File/Edit/View/Window) — only the
  // app's own IPTV header shows. This removes the menu entirely; it is
  // NOT frame:false (the normal title bar with minimise/maximise/close
  // stays) and NOT autoHideMenuBar (Alt must not bring it back).
  Menu.setApplicationMenu(null);
  // Media request headers: the <video> element cannot set Referer/Cookie
  // on file requests, but MovieBox file CDNs need them (H5 streams need
  // the detail-page Referer or the CDN answers 429; play-info streams
  // need Referer https://sportslive.wine + the signCookie). The renderer
  // sets the current playback's headers via 'media:setHeaders'; they are
  // injected only for requests to that stream's host, nothing else.
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      const u = new URL(details.url);
      if (details.resourceType === 'subFrame' && u.origin === 'https://www.youtube.com' &&
          u.pathname.startsWith('/embed/')) {
        // Identify the desktop app to the YouTube player on a local file origin.
        callback({ requestHeaders: { ...details.requestHeaders, Referer: `https://${appId}/` } });
        return;
      }
      if (mediaHeaders && u.host === mediaHeaders.host) {
        const requestHeaders = { ...details.requestHeaders };
        if (mediaHeaders.referer) requestHeaders.Referer = mediaHeaders.referer;
        if (mediaHeaders.cookie) requestHeaders.Cookie = mediaHeaders.cookie;
        requestHeaders['User-Agent'] =
          'com.community.oneroom/50020044 (Linux; U; Android 11; en_US; 2201117TY; Build/RP1A.200720.011; Cronet/135.0.7012.3)';
        callback({ requestHeaders });
        return;
      }
    } catch (_) { /* fall through */ }
    callback({});
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Never leave a transcode ffmpeg running after the app quits.
app.on('before-quit', () => {
  try { transcode.shutdown(); } catch (_) {}
});

// ---- state / files -------------------------------------------------------
ipcMain.handle('state:load', () => loadState());
ipcMain.handle('state:save', (_e, state) => saveState(state));
ipcMain.handle('app:paths', () => ({
  userData: app.getPath('userData'),
  version: app.getVersion(),
}));
ipcMain.handle('channels:bundled', () => {
  try {
    const text = fs.readFileSync(path.join(__dirname, '..', 'assets', 'channels.m3u'), 'utf8');
    // Bundled tight-cropped logos (assets/logos/*) are referenced by
    // relative path in the M3U — resolve them to file:// URLs here so
    // the renderer <img> can load them (works in dev and in the
    // packaged app, where assets ship inside the asar).
    const base = path.join(__dirname, '..');
    return text.replace(/tvg-logo="assets\//g, (_m) => {
      return 'tvg-logo="' + pathToFileURL(path.join(base, 'assets')).href + '/';
    });
  } catch (e) {
    return { error: String(e) };
  }
});
ipcMain.handle('shell:openExternal', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
  return true;
});
ipcMain.handle('dialog:openM3U', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Open M3U playlist',
    filters: [{ name: 'M3U playlists', extensions: ['m3u', 'm3u8', 'txt'] }],
    properties: ['openFile'],
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  try {
    return { path: r.filePaths[0], text: fs.readFileSync(r.filePaths[0], 'utf8') };
  } catch (e) {
    return { error: String(e) };
  }
});

// ---- MPEG-2 live transcode (Geo Super) -------------------------------
// The renderer detects an undecodable codec and hands the stream URL
// here; ffmpeg re-encodes to H.264/AAC HLS on localhost (see
// transcode.js). Only ever one transcode at a time.
ipcMain.handle('transcode:start', (_e, url) => transcode.startTranscode(url));
ipcMain.handle('transcode:stop', () => { transcode.stopTranscode(); return true; });
ipcMain.handle('transcode:status', () => transcode.status());

// Custom title bar (frameless window, v1.0.3): minimise / maximise / close.
ipcMain.handle('window:minimize', () => { if (mainWindow) mainWindow.minimize(); return true; });
ipcMain.handle('window:maximize-toggle', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle('window:close', () => { if (mainWindow) mainWindow.close(); return true; });
ipcMain.handle('window:isMaximized', () => !!mainWindow && mainWindow.isMaximized());

// ---- YouTube live (92 News / City 41 / Express News) ----------------
// Resolves the current live video ID from the channel's /live page at
// play time (see youtube.js); the renderer embeds it, falling back to
// the live_stream embed by channel ID when resolution fails.
ipcMain.handle('yt:resolveLive', (_e, url) => youtube.resolveYouTubeLive(url));

// ---- in-app installer updates ----------------------------------------
ipcMain.handle('update:check', async () => updater.fetchLatest());
ipcMain.handle('update:download', async (event, tag) => {
  await updater.downloadUpdate(tag, (pct) => {
    if (!event.sender.isDestroyed()) event.sender.send('update:progress', pct);
  });
});
ipcMain.handle('update:install', () => updater.installUpdate());

// Silent once-a-day check on startup: only surfaces when a newer
// release actually exists; failures stay silent (Android parity).
async function silentUpdateCheck() {
  if (!updater.isCheckDue()) return;
  try {
    const result = await updater.fetchLatest();
    if (result && result.available && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:available', result);
    }
  } catch (_) { /* silent */ }
}

// ---- MovieBox (all network in main process) ------------------------------
ipcMain.handle('media:setHeaders', (_e, h) => {
  mediaHeaders = (h && h.host) ? { host: h.host, referer: h.referer || '', cookie: h.cookie || '' } : null;
  return true;
});
ipcMain.handle('mb:search', (_e, q) => moviebox.search(q));
ipcMain.handle('mb:details', (_e, subjectId) => moviebox.getDetails(subjectId));
ipcMain.handle('mb:play', (_e, args) => moviebox.getPlayStreams(args));
ipcMain.handle('mb:captions', (_e, args) => moviebox.getEnglishCaptions(args));
ipcMain.handle('mb:feed', (_e, args) => moviebox.getFeed(args || {}));
