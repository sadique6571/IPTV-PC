// IPTV Desktop — in-app updater (main process).
// Mirrors the Android UpdateChecker + UpdateFlow behavior:
//  - GET https://api.github.com/repos/<owner>/<repo>/releases/latest
//    (public repo, no token), User-Agent required.
//  - Tag convention v<versionName>.<versionCode>; the versionCode is the
//    LAST dot segment. Offer the update only when remote code > installed.
//  - Find the asset named ASSET_NAME whose browser_download_url is under
//    https://github.com/<owner>/<repo>/releases/download/ and carries a
//    sha256 digest; verify the download's SHA-256 + size before accepting it.
//  - Nothing downloads without the user pressing Download. No auto-update.
//  - Silent check at most once a day; network/parse failures stay silent
//    there, and the manual check reports them gently (never a crash).
//  - If the repo does not exist yet (404) the check simply reports
//    "no update found" — the app keeps working as before.
//
// Desktop difference from Android: a running Windows .exe cannot replace
// itself, so "install" means: download + verify the new portable exe into
// userData/updates/ and show the user where it is, so they can close the
// app and run the new file. The updater never deletes or overwrites the
// running app.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, shell } = require('electron');
const cfg = require('./update-config');

const LATEST_RELEASE_URL =
  `https://api.github.com/repos/${cfg.OWNER}/${cfg.REPO}/releases/latest`;
const DOWNLOAD_URL_PREFIX =
  `https://github.com/${cfg.OWNER}/${cfg.REPO}/releases/download/`;

function updateStatePath() {
  return path.join(app.getPath('userData'), 'update-state.json');
}
function readUpdateState() {
  try {
    return JSON.parse(fs.readFileSync(updateStatePath(), 'utf8'));
  } catch (_) {
    return { lastCheckMs: 0 };
  }
}
function writeUpdateState(s) {
  try {
    fs.mkdirSync(path.dirname(updateStatePath()), { recursive: true });
    fs.writeFileSync(updateStatePath(), JSON.stringify(s), 'utf8');
  } catch (_) { /* non-fatal */ }
}

/** True when a check is due: never checked, or 24h since the last one. */
function isCheckDue() {
  const last = readUpdateState().lastCheckMs || 0;
  return Date.now() - last >= cfg.CHECK_INTERVAL_MS;
}
function markChecked() {
  writeUpdateState({ lastCheckMs: Date.now() });
}

/** "v2.0.12" -> 12. Null when the tag carries no version code. (Android parity.) */
function parseVersionCode(tag) {
  const clean = String(tag || '').trim().replace(/^v/, '');
  const last = clean.slice(clean.lastIndexOf('.') + 1);
  if (!last) return null;
  const n = Number(last);
  return Number.isInteger(n) ? n : null;
}

function installedVersionCode() { return cfg.BUILD_CODE; }
function installedVersionLabel() { return `v${app.getVersion()}.${cfg.BUILD_CODE}`; }

/**
 * Query the latest release. Returns null when up to date, when the release
 * has no usable asset, or when the repo/releases API is unreachable
 * (including 404 — the repo may not exist yet). Throws only on unexpected
 * errors; callers decide silent vs. visible handling.
 * Result on update: { tag, versionCode, downloadUrl, digest, notes, assetName, size }.
 */
async function fetchLatest() {
  let res;
  try {
    res = await fetch(LATEST_RELEASE_URL, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': cfg.USER_AGENT,
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    // Network failure (offline, DNS, timeout) — not an update, not a crash.
    return { available: false, reason: 'network', detail: String(e && e.message || e) };
  }
  if (res.status === 404) {
    // Repo or releases not published yet — graceful, no update.
    return { available: false, reason: 'not-found' };
  }
  if (!res.ok) {
    return { available: false, reason: 'http', detail: `GitHub API: HTTP ${res.status}` };
  }
  let json;
  try {
    json = await res.json();
  } catch (e) {
    return { available: false, reason: 'bad-response', detail: String(e && e.message || e) };
  }
  // Successful fetch — record the check (Android parity: markChecked
  // runs after a successful fetch, not on network/404 failures).
  markChecked();
  const tag = json.tag_name || '';
  const remoteCode = parseVersionCode(tag);
  if (remoteCode == null) return { available: false, reason: 'no-version' };
  if (remoteCode <= installedVersionCode()) return { available: false, reason: 'up-to-date', tag };
  const assets = Array.isArray(json.assets) ? json.assets : [];
  for (const asset of assets) {
    const name = asset.name || '';
    const url = asset.browser_download_url || '';
    if (!url || !url.startsWith(DOWNLOAD_URL_PREFIX)) continue;
    if (name !== cfg.ASSET_NAME) continue;
    const digest = String(asset.digest || '').replace(/^sha256:/, '');
    if (!/^[0-9a-fA-F]{64}$/.test(digest)) {
      return { available: false, reason: 'no-checksum', tag };
    }
    return {
      available: true,
      tag,
      versionCode: remoteCode,
      downloadUrl: url,
      digest: digest.toLowerCase(),
      notes: json.body || '',
      assetName: name,
      size: asset.size || 0,
    };
  }
  return { available: false, reason: 'no-asset', tag };
}

/** Download + verify the update asset. onProgress(0..100). Returns the saved file path. */
async function downloadUpdate(update, onProgress) {
  const dir = path.join(app.getPath('userData'), 'updates');
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, update.assetName);
  const partPath = path.join(dir, `.${update.assetName}.part`);
  const res = await fetch(update.downloadUrl, {
    headers: { 'User-Agent': cfg.USER_AGENT },
    redirect: 'follow',
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok || !res.body) throw new Error(`Download: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || -1;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(partPath);
  let downloaded = 0;
  let lastPercent = -1;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      out.write(chunk);
      downloaded += chunk.length;
      if (total > 0) {
        const pct = Math.min(100, Math.floor((downloaded * 100) / total));
        if (pct !== lastPercent) { lastPercent = pct; if (onProgress) onProgress(pct); }
      }
    }
  } finally {
    out.end();
    await new Promise((resolve) => out.on('finish', resolve));
  }
  const actual = hash.digest('hex');
  if ((total >= 0 && fs.statSync(partPath).size !== total) || actual !== update.digest) {
    try { fs.unlinkSync(partPath); } catch (_) {}
    throw new Error('Update verification failed (checksum mismatch).');
  }
  fs.renameSync(partPath, finalPath);
  return finalPath;
}

function showDownloadedFile(filePath) {
  shell.showItemInFolder(filePath);
}

module.exports = {
  isCheckDue,
  markChecked,
  parseVersionCode,
  installedVersionCode,
  installedVersionLabel,
  fetchLatest,
  downloadUpdate,
  showDownloadedFile,
};
