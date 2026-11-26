# IPTV Desktop

Live TV, movies and series on the computer — the same TV style as the
Android IPTV app, for **Windows first** (Linux later from the same code).
Source and Windows releases are hosted on GitHub.

## What it is

- **Live TV** — the built-in playlist includes Pakistani channels, Indian
  music and selected Hindi kids' cartoons, and English-language cricket.
  Categories, search, favorites, and custom M3U playlists are supported.
  HLS and raw MPEG-TS play with hls.js and mpegts.js. YouTube video and
  playlist entries use the embedded player. Cricket Gold uses the native
  HLS player. European Cricket Network and Cricket Ireland use the embedded
  YouTube player when a live broadcast is available. Cricket entries with
  no in-app feed show their availability in the app.
- **Movies / Series** — the same MovieBox source as the Android app:
  visitor login + HMAC-MD5 signed mobile API (search, details, seasons),
  playable MP4s from `resourceDetectors` / `play-info/v2` and the website
  H5 endpoint (the proven path for titles like The Body [Hindi]),
  English subtitles from the caption endpoint, Continue Watching.
- **Player** — one player for TV and movies: play/pause, −10s/+10s, seek
  bar, quality menu, CC toggle, Prev/Next episode, fullscreen.
- **In-app updater** — installed Windows builds check GitHub on startup
  at most once a day and from **Check for updates**. Choose **Download**
  to fetch and verify the Windows update, then **Install & Restart** to
  upgrade in place and reopen the app.

## Run it (development)

```sh
npm install
npm start
```

## Build it

```sh
# On Windows with a configured local Authenticode certificate
npm run build:win
# Linux unpacked dir
npm run build:linux
```

The Windows output is `dist/IPTV-Desktop-Setup-<version>.exe`. The setup
wizard lets users choose the install folder and creates Desktop and Start
Menu shortcuts. For local signing, configure `IPTV_SIGNING_THUMBPRINT`
or `WIN_CSC_LINK` before building.

## Code signing policy

SignPath Foundation signing is planned, pending approval. The
GitHub-hosted release workflow signs the app and Setup EXE separately,
verifies both signatures, and creates a draft release with the matching
update metadata. Sadique Sadiq (@sadique6571) maintains the project,
reviews changes, and approves signing requests. See the
[SignPath application and release setup](docs/signpath-application.md).

## Project layout

```
package.json            Electron 45 / electron-builder / hls.js / mpegts.js (pinned)
src/
  main.js               Window, state file, IPC, media-header injection
  preload.js            Minimal contextBridge (no Node in the renderer)
  moviebox.js           MovieBox client (signed API + H5 + captions + feeds)
  updater.js            GitHub Releases updates for installed Windows builds
  renderer/
    index.html          App shell (header, split list/player, update dialog)
    styles.css          TV-style dark glass theme (Android palette)
    app.js              Live TV + movies + player + keyboard navigation
    channels.js         M3U parser
    vendor/             hls.min.js, mpegts.js (copied from node_modules)
assets/
  channels.m3u          Built-in TV, music, kids' cartoons, and cricket sources
docs/
  moviebox-api.md       Exhaustive MovieBox API spec (from the Kotlin source)
  ui-spec.md            Android UI/design spec (colors, layout, player bar)
```

## Privacy

Favorites, Continue Watching, custom playlists, the MovieBox visitor
token, and the time of the last update check are stored locally. The app
contacts GitHub to check for updates, media providers to load streams and
metadata, and YouTube when an embedded YouTube channel is selected. The
app starts the first channel on launch, which contacts its provider.
Media providers can log requests under their own privacy policies.

## License

Original project code and documentation are available under the
[MIT license](LICENSE). See the [third-party notices](docs/third-party-notices.md)
for bundled components and artwork.

## Verified (2026-11-25, first build)

- **v1.0.4 (2026-11-26)**: HEVC/H.265 movies now play — the MP4 movie
  path gets the same safety net as live TV: an 8s no-frames watchdog
  (fires on error 4, or on audio playing with no frames), tries the next
  source in descending quality, then routes through the existing ffmpeg
  transcode to H.264/AAC HLS. Messages are codec-generic ("Ye format
  app mein seedha nahi chalta — convert ho raha hai…"). Quality switches
  reset the per-URL watchdog/transcode state. Two transcode fixes found
  while verifying: `-timeout` is only passed for http:// inputs (ffmpeg
  rejects it for HTTPS — the transcode died before starting), and audio
  is downmixed to stereo (`-ac 2`) because some files carry 5.1 AAC with
  an unknown channel layout that the AAC encoder rejects ("Unsupported
  channel layout"). Version 1.0.4, BUILD_CODE 5 (tag v1.0.4.5). Verified
  2026-11-26 under Xvfb (system ffmpeg): Chal Mera Putt (both sources
  HEVC) plays via transcode (848×360, currentTime 0:32/4:14, playing);
  The Avengers (all 4 sources HEVC) plays via transcode (1920×1080,
  currentTime advancing); a manual quality switch to an HEVC source
  re-runs the fallback and plays via transcode; Delhi 2021 1080p (H.264)
  plays direct (1920×1080, no ffmpeg spawned); PTV Home HLS plays
  direct (1280×720, 15.6s, no ffmpeg); Geo Super still transcodes
  (768×576). Test-harness notes (not app changes): the sandbox renderer
  needs `--ignore-certificate-errors --proxy-server=...` +
  `IPTV_PROXY_AUTH` for its https fetches, and `setMediaHeaders` (the
  mobile UA) for the file CDN, which answers 428 to a desktop browser UA.
- **v1.0.3 (2026-11-25)**: ffmpeg transcode for MPEG-2 — Geo Super
  plays in-app (transcoded to H.264 + AAC HLS on localhost; falls back
  to the VLC message if ffmpeg fails; PTV Home still plays direct, no
  ffmpeg spawned). TV Quality menu — Auto + per-level rows with bitrate,
  switchable. Channel arrange — drag-and-drop, Shift+Arrow keys, Arrange
  menu (Pakistani pehle / A–Z / Default), order persists. YouTube live
  channels (92 News, City 41, Express News) now play in-app via embed
  (actual video playback not proven in this sandbox — Error 153 even for
  a known-embeddable test video). Uniform 44×44 logo tiles; Ten Sports
  and Willow tight crops bundled in `assets/logos/`. Size — locales
  stripped to en-US only + NSIS maximum compression; exe is still bigger
  than v1.0.2 (137 MB vs 108 MB) because ffmpeg.exe adds 82.8 MB. Menu
  bar removed; custom title bar — frameless window, header is the drag
  region, minimise/maximise/close buttons in app style. Version 1.0.3,
  BUILD_CODE 4 (tag v1.0.3.4). Verified 2026-11-25 under Xvfb: Geo Super
  transcode plays (768×576, currentTime advancing); 12/12 arrange checks
  pass; title-bar minimise/maximise/close verified under openbox. The
  Windows ffmpeg binary is downloaded at build time from gyan.dev
  (`scripts/prepare-ffmpeg.js`, vendor copy preferred when present) —
  CI needs no local copy. Windows-only behaviour (ffmpeg.exe playback,
  YouTube video, window drag/snap) cannot be proven from the Linux VM.
- **v1.0.2 (2026-11-25)**: HLS recovery — fatal MEDIA_ERROR calls
  `recoverMediaError()`, fatal NETWORK_ERROR retries (startLoad, then
  full re-attach, max 3) with raised retry budgets (frag/manifest/level
  ×6); counter resets on FRAG_BUFFERED/playing. Hide-the-list toggle
  (header button + player-side button + `L` key, persisted). Player bar
  is now a frosted-glass pill (60% black + 25% white rim, Android
  demo chrome). MPEG-2 channels (Geo Super) show an honest message +
  "VLC mein kholo" instead of a black screen. Version 1.0.2,
  BUILD_CODE 3 (tag v1.0.2.3). Verified 2026-11-25: drag test drove a
  real +150px pointer drag (list 565→715px, splitWidth 715 persisted;
  `L` hides the list, restore button brings back 715px); PTV Home HLS
  plays (readyState 4, 23.5s, 854×480); Geo Super shows the MPEG-2
  message + button (videoWidth 0, 8.4s in); exe icon extracted from
  both exes = the IPTV artwork (pefile: 6 RT_ICON entries each).
- **v1.0.1 (2026-11-25)**: Android launcher icon everywhere — the
  `iptv_icon.xml` artwork (navy `#080F1E` + mint `#48F6BD`) converted to
  `assets/icon.png` (512×512) and `assets/icon.ico` (256/128/64/48/32/16),
  wired into the window, the header, and the Windows exe / Linux build.
  Draggable divider between the list and the player (min 280px list /
  320px player, split persists in state). Version 1.0.1, BUILD_CODE 2
  (tag v1.0.1.2).
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
- **3 YouTube live channels** (92 News, City 41, Express News) now play
  in-app via embed (v1.0.3); actual video playback was not provable in
  this sandbox (Error 153 even for a known-embeddable test video).
- **Trending rail** can come back empty when the trending endpoint is
  slow; the other rails still load.
- **No Xtream support yet** (the Android app has it; desktop v1 has
  built-in + M3U playlists only).
- **No downloads** (the Android app downloads movies; desktop v1 is
  streaming only).
