# Third-party notices

The root MIT license applies to the project’s original code and documentation. Upstream software, third-party artwork, channel logos, and media retain their respective terms.

- **Electron and Chromium** supply the desktop runtime. Electron ships its license and Chromium’s third-party notices with its distribution. [Electron license](https://github.com/electron/electron/blob/main/LICENSE)
- **hls.js 1.7.4** and **mpegts.js 1.8.2** supply playback libraries under Apache-2.0. Their license notices are in `src/renderer/vendor`. [hls.js](https://github.com/video-dev/hls.js/tree/v1.7.4) · [mpegts.js](https://github.com/xqq/mpegts.js/tree/v1.8.2)
- **Noto Nastaliq Urdu** provides a bundled Arabic-script WOFF2 subset under the SIL Open Font License 1.1, included in `src/renderer/vendor`. The app uses the system’s Jameel Noori Nastaleeq when installed. [Noto Nastaliq Urdu license](https://github.com/google/fonts/blob/main/ofl/notonastaliqurdu/OFL.txt)
- **FFmpeg** is run as a separate executable for fallback transcoding. The Windows x64 release workflow stages the GPLv3 Gyan FFmpeg 6.1.1 essentials build from `ffmpeg-static`, with its upstream license and build information. The release must include access to its corresponding sources, including applicable dependencies and build materials. [FFmpeg source revision](https://github.com/FFmpeg/FFmpeg/commit/e38092ef93) · [Windows binary and build notes](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1) · [FFmpeg licensing](https://ffmpeg.org/legal.html)

Included channel logos identify their respective broadcasters. Media providers and linked sites have their own terms and privacy policies.
