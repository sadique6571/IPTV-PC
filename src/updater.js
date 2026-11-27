'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { verifySamePublisher } = require('./windows-signature');

const { fetchSetupSignature, verifySetupSignature } = require('./ssh-signature');
const sshUpdates = require('../package.json').updateSigning === 'ssh';
let verifiedSignature;

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
let client;
let checkPromise;
let downloadPromise;
let available;
let readyPath;
let installing = false;

function getClient() {
  if (!app.isPackaged || process.platform !== 'win32' ||
      !fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return null;
  if (!client) {
    client = require('electron-updater').autoUpdater;
    client.autoDownload = false;
    client.autoInstallOnAppQuit = false;
    client.disableWebInstaller = true;
    client.on('error', (error) => console.error('IPTV update:', error.message));
  }
  return client;
}

function checkStatePath() {
  return path.join(app.getPath('userData'), 'update-state.json');
}

function isCheckDue() {
  try {
    const state = JSON.parse(fs.readFileSync(checkStatePath(), 'utf8'));
    return !Number.isFinite(state.lastCheckMs) || Date.now() - state.lastCheckMs >= CHECK_INTERVAL_MS;
  } catch (_) {
    return true;
  }
}

function markChecked() {
  try {
    fs.writeFileSync(checkStatePath(), JSON.stringify({ lastCheckMs: Date.now() }));
  } catch (error) {
    console.warn('Could not save update check time:', error.message);
  }
}

function fetchLatest() {
  const updater = getClient();
  if (!updater) return Promise.resolve({ available: false, reason: 'unsupported' });
  if (downloadPromise || readyPath) return Promise.resolve(available);
  if (!checkPromise) {
    checkPromise = (async () => {
      available = undefined;
      const result = await updater.checkForUpdates();
      markChecked();
      if (!result?.isUpdateAvailable) return { available: false, reason: 'up-to-date' };
      const { version, releaseNotes } = result.updateInfo;
      const notes = Array.isArray(releaseNotes)
        ? releaseNotes.map((release) => release.note || '').filter(Boolean).join('\n\n')
        : releaseNotes || '';
      available = { available: true, tag: `v${version}`, notes };
      return available;
    })().finally(() => { checkPromise = undefined; });
  }
  return checkPromise;
}

async function downloadUpdate(tag, onProgress) {
  const updater = getClient();
  if (checkPromise) await checkPromise;
  if (!updater || !available || available.tag !== tag) {
    throw new Error('Check for updates again before downloading.');
  }
  if (readyPath) return;
  if (!downloadPromise) {
    downloadPromise = (async () => {
      const progress = ({ percent }) => onProgress(Math.round(percent));
      updater.on('download-progress', progress);
      try {
        await updater.downloadUpdate();
        const installerPath = updater.installerPath;
        if (!installerPath) throw new Error('The update installer was not downloaded.');
        if (sshUpdates) {
          const signature = await fetchSetupSignature(tag);
          await verifySetupSignature(installerPath, signature);
          verifiedSignature = signature;
        } else {
          await verifySamePublisher(process.execPath, installerPath);
        }
        readyPath = installerPath;
      } finally {
        updater.removeListener('download-progress', progress);
      }
    })().finally(() => { downloadPromise = undefined; });
  }
  await downloadPromise;
}

async function installUpdate() {
  const updater = getClient();
  if (!updater || !readyPath || readyPath !== updater.installerPath) {
    throw new Error('Download the update before installing.');
  }
  if (installing) return;
  installing = true;
  try {
    if (sshUpdates) await verifySetupSignature(readyPath, verifiedSignature);
    else await verifySamePublisher(process.execPath, readyPath);
    updater.quitAndInstall(true, true);
  } catch (error) {
    installing = false;
    throw error;
  }
}

module.exports = { isCheckDue, fetchLatest, downloadUpdate, installUpdate };
