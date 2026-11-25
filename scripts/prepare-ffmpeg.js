// Stages the ffmpeg binary for electron-builder.
// ffmpeg-static downloads the platform binary into node_modules at
// `npm ci` time (ffmpeg on Linux/macOS, ffmpeg.exe on Windows), but the
// build's `files` list does not include node_modules — so copy the
// binary into ffmpeg-bin/, which is shipped via `extraResources` and
// resolved by src/transcode.js from process.resourcesPath.
// Run by the build:* scripts before electron-builder; harmless to run
// by hand. Generated output — ffmpeg-bin/ is gitignored.
//
// Target-aware (v1.0.3): `node scripts/prepare-ffmpeg.js win|linux`.
// The Windows build runs on a Linux VM, so the host binary is the WRONG
// one for it — win stages the gyan.dev essentials build (PE32+, libx264),
// linux stages the ffmpeg-static host binary. Only the target platform's
// binary is ever staged: shipping the Linux binary in the Windows package
// would leave the app looking for a ffmpeg.exe that is not there (transcode
// dead on Windows).
// Win binary source: vendor/ffmpeg-win/ffmpeg.exe if present, otherwise
// downloaded from gyan.dev at build time. The download fallback matters
// because vendor/ is gitignored — CI (windows-latest) has no local copy,
// so without it the release build would fail loudly on a fresh checkout.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const GYAN_ESSENTIALS_URL = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

const target = process.argv[2] || 'linux';
if (target !== 'win' && target !== 'linux') {
  throw new Error('usage: node scripts/prepare-ffmpeg.js [win|linux]');
}

// Download a file following up to 5 redirects (gyan.dev redirects the
// stable URL to a versioned build). Dependency-free, works on any runner.
function downloadFile(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'IPTV-PC-build/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirects === 0) return reject(new Error('too many redirects downloading ' + url));
        res.resume();
        return downloadFile(new URL(res.headers.location, url).href, dest, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('download failed: ' + url + ' -> HTTP ' + res.statusCode));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}

function findInDir(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findInDir(p, name);
      if (found) return found;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

// Download the gyan.dev essentials zip, extract bin/ffmpeg.exe, return
// its path. Temp files live in a .ffmpeg-tmp-* dir under the project
// root (NOT os.tmpdir(): /tmp is a small tmpfs on some machines and the
// ~120 MB zip + ~300 MB extraction would fill it) and are cleaned up
// by main.
async function downloadWindowsFfmpeg() {
  const tmpDir = fs.mkdtempSync(path.join(__dirname, '..', '.ffmpeg-tmp-'));
  const zipPath = path.join(tmpDir, 'ffmpeg-release-essentials.zip');
  const extractDir = path.join(tmpDir, 'extracted');
  console.log('Windows ffmpeg: downloading', GYAN_ESSENTIALS_URL);
  await downloadFile(GYAN_ESSENTIALS_URL, zipPath);
  console.log('Windows ffmpeg: downloaded', fs.statSync(zipPath).size, 'bytes; extracting…');
  const extract = require('extract-zip');
  await extract(zipPath, { dir: extractDir });
  const exe = findInDir(extractDir, 'ffmpeg.exe');
  if (!exe) throw new Error('ffmpeg.exe not found inside the downloaded essentials zip');
  return { exe, tmpDir };
}

async function main() {
  const outDir = path.join(__dirname, '..', 'ffmpeg-bin');
  // Stage exactly one binary — never leave the other platform's behind.
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  if (target === 'win') {
    const vendorBin = path.join(__dirname, '..', 'vendor', 'ffmpeg-win', 'ffmpeg.exe');
    let src = vendorBin;
    let tmpDir = null;
    if (!fs.existsSync(src)) {
      console.log('Windows ffmpeg: no local vendor/ffmpeg-win/ffmpeg.exe, downloading…');
      const downloaded = await downloadWindowsFfmpeg();
      src = downloaded.exe;
      tmpDir = downloaded.tmpDir;
    }
    try {
      const dest = path.join(outDir, 'ffmpeg.exe');
      fs.copyFileSync(src, dest);
      // Static checks only — a Windows exe cannot run its -version here.
      const buf = fs.readFileSync(dest);
      if (buf.subarray(0, 2).toString('ascii') !== 'MZ' || buf.indexOf('PE\0\0', 0, 512) < 0) {
        throw new Error('staged ffmpeg.exe is not a PE32+ Windows binary');
      }
      if (!buf.includes(Buffer.from('libx264', 'ascii'))) {
        throw new Error('staged ffmpeg.exe has no libx264 (not an essentials build?)');
      }
      console.log('ffmpeg binary staged:', dest, fs.statSync(dest).size, 'bytes (Windows, gyan.dev essentials)');
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } else {
    const bin = require('ffmpeg-static');
    const dest = path.join(outDir, path.basename(bin));
    fs.copyFileSync(bin, dest);
    if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
    // Smoke-check the staged binary: a corrupt download (this happened
    // once behind the sandbox MITM proxy — the npm postinstall does not
    // verify a checksum) must fail the build loudly, never ship silently.
    const { execFileSync } = require('child_process');
    const probe = execFileSync(dest, ['-version'], { encoding: 'utf8', timeout: 15000 });
    if (!/ffmpeg version/.test(probe)) {
      throw new Error('staged ffmpeg binary failed its -version smoke check');
    }
    console.log('ffmpeg binary staged:', dest, fs.statSync(dest).size, 'bytes');
  }
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
