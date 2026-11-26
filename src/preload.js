// IPTV Desktop — preload. Minimal, explicit bridge; no Node in renderer.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Dev-only env passthrough (screenshot/autoplay hooks); nothing else.
  env: () => ({ autoplay: process.env.IPTV_AUTOPLAY || '', openQuality: process.env.IPTV_OPEN_QUALITY || '', qualityLevel: process.env.IPTV_QUALITY_LEVEL || '' }),
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  paths: () => ipcRenderer.invoke('app:paths'),
  bundledChannels: () => ipcRenderer.invoke('channels:bundled'),
  openM3U: () => ipcRenderer.invoke('dialog:openM3U'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  mbSearch: (q) => ipcRenderer.invoke('mb:search', q),
  setMediaHeaders: (h) => ipcRenderer.invoke('media:setHeaders', h),
  mbDetails: (subjectId) => ipcRenderer.invoke('mb:details', subjectId),
  mbPlay: (args) => ipcRenderer.invoke('mb:play', args),
  mbCaptions: (args) => ipcRenderer.invoke('mb:captions', args),
  mbFeed: (args) => ipcRenderer.invoke('mb:feed', args),
  // YouTube live: resolve the current live video ID at play time.
  resolveYouTubeLive: (url) => ipcRenderer.invoke('yt:resolveLive', url),
  // MPEG-2 live transcode (Geo Super): ffmpeg in the main process.
  startTranscode: (url) => ipcRenderer.invoke('transcode:start', url),
  stopTranscode: () => ipcRenderer.invoke('transcode:stop'),
  transcodeStatus: () => ipcRenderer.invoke('transcode:status'),
  // Custom title bar (frameless window): window controls.
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:maximize-toggle'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onMaximizeChange: (cb) => ipcRenderer.on('window:maximize-changed', (_e, maximized) => cb(maximized)),
  // In-app installer updates.
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: (tag) => ipcRenderer.invoke('update:download', tag),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_e, update) => cb(update)),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, pct) => cb(pct)),
});
