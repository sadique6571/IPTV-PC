// electron-builder afterPack hook (v1.0.3): strip Chromium locale files.
// The packaged app ships ~55 locale .pak files (~49 MB unpacked on
// Windows) but the app's own UI strings are Roman Urdu baked into the
// code — they do not come from locale files. Keep ONLY en-US.pak;
// Chromium falls back to it when the OS locale's file is missing, so
// nothing breaks — the worst case is a built-in Chromium string
// (context menu, dialog) showing in English instead of the OS language.
// Runs for both the Windows and Linux packaged builds (appOutDir is
// the unpacked app dir in both cases). Never touches dxcompiler.dll,
// icudtl.dat, resources.pak or vk_swiftshader.dll.
'use strict';

const fs = require('fs');
const path = require('path');

const KEEP = new Set(['en-US.pak']);

module.exports = async function afterPack(context) {
  const localesDir = path.join(context.appOutDir, 'locales');
  let entries;
  try {
    entries = fs.readdirSync(localesDir);
  } catch (_) {
    console.log('[afterPack] no locales dir at ' + localesDir + ' — skipping');
    return;
  }
  let removed = 0;
  let freedBytes = 0;
  for (const name of entries) {
    if (KEEP.has(name)) continue;
    const full = path.join(localesDir, name);
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      freedBytes += stat.size;
      fs.unlinkSync(full);
      removed++;
    } catch (e) {
      console.warn('[afterPack] could not remove ' + name + ': ' + e.message);
    }
  }
  console.log(
    `[afterPack] locales: removed ${removed} files, kept ${[...KEEP].join(', ')}, freed ${(freedBytes / 1048576).toFixed(1)} MB`
  );
};
