// IPTV Desktop — main process.
// Owns the window, the local state file (favorites / continue watching),
// the M3U file picker, and all MovieBox network calls (done here in Node
// so custom headers like Referer can be set — the renderer cannot set
// forbidden headers via fetch).
'use strict';

const { app, BrowserWindow, ipcMain, dialog, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const moviebox = require('./moviebox');
const updater = require('./updater');

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 960,
    minHeight: 540,
    backgroundColor: '#0b0e14',
    title: 'IPTV Desktop',
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

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });

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
          `(() => { const v = document.getElementById('video'); const rows = document.querySelectorAll('#channelList .row').length; const e = window.__lastHlsError; const imgs = [...document.querySelectorAll('.card img, .row .logo')]; const loaded = imgs.filter((i) => i.naturalWidth > 0).length; return { readyState: v.readyState, currentTime: v.currentTime, paused: v.paused, videoWidth: v.videoWidth, videoHeight: v.videoHeight, src: (v.currentSrc || '').slice(0, 80), rows, imgs: imgs.length, imgsLoaded: loaded, status: document.getElementById('statusBar').textContent, hlsError: e ? { type: e.type, details: e.details, fatal: e.fatal, url: (e.context && e.context.url) || '', responseCode: (e.networkDetails && e.networkDetails.status) || (e.response && e.response.code) || '' } : null, hlsLoaded: !!window.Hls, mpegtsLoaded: !!window.mpegts }; })()`,
        );
        console.log('VIDEO STATE:', JSON.stringify(state));
        const img = await mainWindow.capturePage();
        fs.writeFileSync(out, img.toPNG());
        console.log('screenshot saved:', out);
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
  // Media request headers: the <video> element cannot set Referer/Cookie
  // on file requests, but MovieBox file CDNs need them (H5 streams need
  // the detail-page Referer or the CDN answers 429; play-info streams
  // need Referer https://sportslive.wine + the signCookie). The renderer
  // sets the current playback's headers via 'media:setHeaders'; they are
  // injected only for requests to that stream's host, nothing else.
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    try {
      if (mediaHeaders && details.url) {
        const u = new URL(details.url);
        if (u.host === mediaHeaders.host) {
          const requestHeaders = { ...details.requestHeaders };
          if (mediaHeaders.referer) requestHeaders.Referer = mediaHeaders.referer;
          if (mediaHeaders.cookie) requestHeaders.Cookie = mediaHeaders.cookie;
          requestHeaders['User-Agent'] =
            'com.community.oneroom/50020044 (Linux; U; Android 11; en_US; 2201117TY; Build/RP1A.200720.011; Cronet/135.0.7012.3)';
          callback({ requestHeaders });
          return;
        }
      }
    } catch (_) { /* fall through */ }
    callback({});
  });

  createWindow();

  // Silent update check (once a day at most) — runs in the background.
  silentUpdateCheck();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
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
    return fs.readFileSync(path.join(__dirname, '..', 'assets', 'channels.m3u'), 'utf8');
  } catch (e) {
    return { error: String(e) };
  }
});
ipcMain.handle('shell:openExternal', (_e, url) => {
  // YouTube live pages (3 channels) are not media streams — open them in
  // the system browser, the way the Android app uses a WebView for them.
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

// ---- in-app updater (mirrors Android UpdateChecker/UpdateFlow) --------
ipcMain.handle('update:check', async () => updater.fetchLatest());
ipcMain.handle('update:installed', () => ({
  label: updater.installedVersionLabel(),
  code: updater.installedVersionCode(),
}));
ipcMain.handle('update:download', async (event, update) => {
  const filePath = await updater.downloadUpdate(update, (pct) => {
    event.sender.send('update:progress', pct);
  });
  return { filePath };
});
ipcMain.handle('update:showFile', (_e, filePath) => {
  updater.showDownloadedFile(filePath);
  return true;
});

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
