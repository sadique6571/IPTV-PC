# IPTV Desktop

Live TV, movies and series on the computer — the same TV style as the
Android IPTV app, for **Windows first** (Linux later from the same code).
Local-only project; nothing here is published anywhere yet.

## What it is

- **Live TV** — the 109 built-in channels from the Android app
  (`assets/channels.m3u`, same file), categories, search, favorites,
  custom M3U playlist loading. Playback with hls.js; raw MPEG-TS streams
  via mpegts.js; YouTube live pages open in the system browser.
- **Movies / Series** — the same MovieBox source as the Android app:
  visitor login + HMAC-MD5 signed mobile API (search, details, seasons),
  playable MP4s from `resourceDetectors` / `play-info/v2` and the website
  H5 endpoint (the proven path for titles like The Body [Hindi]),
  English subtitles from the caption endpoint, Continue Watching.
- **Player** — one player for TV and movies: play/pause, −10s/+10s, seek
  bar, quality menu, CC toggle, Prev/Next episode, fullscreen.
- **In-app updater** — mirrors the Android UpdateChecker: on startup
  (once a day) and via "Check for updates", it queries the public GitHub
  Releases API for the latest release, compares versions, and offers a
  Download that fetches + SHA-256-verifies the portable exe. Nothing
  downloads without asking. Config lives in `src/update-config.js`
  (owner `sadique6571`, repo `IPTV-PC`, asset `IPTV-Desktop-portable.exe`).
  A running .exe cannot replace itself, so the update is downloaded into
  the app's userData `updates/` folder and the user runs the new file
  after closing the app.

## Run it (development)

```sh
npm install
npm start
```

## Build it

```sh
# Windows portable exe + unpacked dir (builds fine on Linux — no Wine
# needed; electron-builder downloads its own NSIS/7-Zip tooling)
npm run build:win
# Windows unpacked dir only
npm run build:win-dir
# Linux unpacked dir
npm run build:linux
```

Output goes to `dist/`. The portable exe is
`dist/IPTV-Desktop-portable.exe` (version-free name, like the Android
app's constant `IPTV.apk`, so the updater never needs a name change).
The Windows build is **unsigned** (no code-signing certificate yet), so
Windows SmartScreen will warn on first run — "Run anyway" to launch.

## Project layout

```
package.json            Electron 45 / electron-builder / hls.js / mpegts.js (pinned)
src/
  main.js               Window, state file, IPC, media-header injection
  preload.js            Minimal contextBridge (no Node in the renderer)
  moviebox.js           MovieBox client (signed API + H5 + captions + feeds)
  updater.js            GitHub-releases updater (Android UpdateChecker parity)
  update-config.js      Update repo/asset/build-code constants (one-line change)
  renderer/
    index.html          App shell (header, split list/player, update dialog)
    styles.css          TV-style dark glass theme (Android palette)
    app.js              Live TV + movies + player + keyboard navigation
    channels.js         M3U parser
    vendor/             hls.min.js, mpegts.js (copied from node_modules)
assets/
  channels.m3u          The 109 built-in channels (same file as the Android app)
docs/
  moviebox-api.md       Exhaustive MovieBox API spec (from the Kotlin source)
  ui-spec.md            Android UI/design spec (colors, layout, player bar)
```

State (favorites, Continue Watching, custom playlist, MovieBox token,
update last-check) lives in the app's userData folder as JSON files —
no telemetry, no auto-updater, no accounts.

## Verified (2026-11-25, first build)

- `npm install` clean (284 packages) + `npm run build:win` exit 0:
  `dist/IPTV-Desktop-portable.exe` — 113,078,418 bytes (~108 MB),
  PE32 NSIS self-extracting archive; `dist/win-unpacked/IPTV Desktop.exe`
  — PE32+ x64 with `resources/app.asar`. `npm run build:linux` exit 0:
  `dist/linux-unpacked/iptv-desktop` (ELF x64, app.asar present).
- **Live TV playback proven in-app** (Xvfb smoke test): PTV Home HLS
  played — readyState 4, currentTime 18.2s, 854×480 video, real frames
  in the screenshot. Raw MPEG-TS (MUN TV) demuxed in-app — mpegts.js
  parsed PAT/PMT (H.264 + MP3) — but could not buffer to first frame in
  this sandbox: the sandbox egress proxy throttles that host to ~4.6 KB/s
  (measured with curl), far below real-time. On a normal connection it
  should play; not provable here.
- **Movies feed renders in-app**: Top Picks / New Release rails with
  real titles (NO WAY OUT, Rob Lowe: The Outsider [Hindi], …). MovieBox
  client verified in Node: The Body [Hindi] search → details (S1, 8 eps)
  → H5 play S1E1 returns 480p + 1080p signed MP4s → English captions
  fetched and converted to WebVTT.
- **Updater verified**: `fetchLatest` against the real `sadique6571/IPTV-PC`
  repo returns graceful "no release yet" (repo is empty); the download +
  SHA-256 path was proven against the Android release asset (IPTV.apk
  v2.0.23.71, 1,353,899 bytes, digest matched).
- Sandbox note: this VM routes traffic through an authenticated MITM
  egress proxy, which Electron/Chromium does not trust by default — the
  smoke test used `--ignore-certificate-errors --proxy-server=...` plus
  a dev-only `IPTV_PROXY_AUTH` env hook in `main.js` (never set in
  production, credentials never in code). On a real Windows PC there is
  no proxy and none of that is needed.

## Known limitations (v1)

- **DASH streams are not played** — play-info sometimes returns a DASH
  manifest (decoded from `signCookie`); the desktop player has no DASH
  support yet. Titles that only offer DASH show "No playable streams".
  (The detector/H5 paths cover most titles.)
- **3 YouTube live channels** (92 News, City 41, Express News) open in
  the system browser instead of playing in-app.
- **Trending rail** can come back empty when the trending endpoint is
  slow; the other rails still load.
- **No Xtream support yet** (the Android app has it; desktop v1 has
  built-in + M3U playlists only).
- **No downloads** (the Android app downloads movies; desktop v1 is
  streaming only).
- The app uses the default Electron icon (no custom icon set yet).
