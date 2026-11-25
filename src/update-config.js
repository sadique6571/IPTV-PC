// IPTV Desktop — update configuration.
// ONE place for everything the updater needs to know about the release
// repo. When the user creates the GitHub repo for the desktop app, the
// only change needed is REPO (and ASSET_NAME if the artifact name differs).
// Mirrors the Android UpdateChecker constants (owner/repo/asset).
'use strict';

module.exports = {
  // GitHub repo that publishes the desktop releases.
  // Created by the user 2026-11-25; v1.0.0.1 released the same day.
  // The updater checks this repo's latest release.
  OWNER: 'sadique6571',
  REPO: 'IPTV-PC',

  // Exact asset file name the updater looks for in the latest release
  // (the Windows portable exe built by electron-builder). The name is
  // deliberately version-free — like the Android app's constant
  // "IPTV.apk" — so it never needs changing per release.
  // Keep this in sync with package.json "build.portable.artifactName".
  ASSET_NAME: 'IPTV-Desktop-portable.exe',

  // Release tag convention (same as the Android app):
  //   v<versionName>.<versionCode>, e.g. v1.0.0.1
  // The versionCode is the LAST dot segment; it must increase for every
  // build users should be offered. Bump BUILD_CODE below on each release.
  BUILD_CODE: 4,

  // Silent check at most once a day (same as Android: 24h).
  CHECK_INTERVAL_MS: 24 * 60 * 60 * 1000,

  // User-Agent for GitHub API calls (GitHub rejects requests without one).
  USER_AGENT: 'IPTV-Desktop',
};
