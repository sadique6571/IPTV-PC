// IPTV Desktop — preload. Minimal, explicit bridge; no Node in renderer.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Dev-only env passthrough (screenshot/autoplay hooks); nothing else.
  env: () => ({ autoplay: process.env.IPTV_AUTOPLAY || '' }),
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
  // In-app updater (mirrors Android UpdateChecker/UpdateFlow).
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installedVersion: () => ipcRenderer.invoke('update:installed'),
  downloadUpdate: (update) => ipcRenderer.invoke('update:download', update),
  showDownloadedFile: (filePath) => ipcRenderer.invoke('update:showFile', filePath),
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_e, update) => cb(update)),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, pct) => cb(pct)),
});
