'use strict';

const path = require('node:path');
const { existsSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { Arch, build, Platform } = require('electron-builder');
const { verifySamePublisher } = require('../src/windows-signature');
const { version } = require('../package.json');

async function main() {
  if (process.platform !== 'win32') throw new Error('Run the signed Windows build on Windows.');
  const thumbprint = process.env.IPTV_SIGNING_THUMBPRINT;
  if (!thumbprint && !process.env.WIN_CSC_LINK && !process.env.CSC_LINK) {
    throw new Error('A trusted code-signing certificate is required. Configure IPTV_SIGNING_THUMBPRINT or WIN_CSC_LINK before building.');
  }
  if (thumbprint && !/^[a-f0-9]{40}$/i.test(thumbprint)) {
    throw new Error('IPTV_SIGNING_THUMBPRINT must contain a 40-digit certificate thumbprint.');
  }

  execFileSync(process.execPath, [path.join(__dirname, 'prepare-ffmpeg.js'), 'win'], { stdio: 'inherit' });
  await build({
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
    publish: 'never',
    ...(thumbprint && { config: { win: { signtoolOptions: { certificateSha1: thumbprint } } } }),
  });

  const dist = path.join(__dirname, '..', 'dist');
  const installer = path.join(dist, `IPTV-Desktop-Setup-${version}.exe`);
  const app = path.join(dist, 'win-unpacked', 'IPTV Desktop.exe');
  await verifySamePublisher(app, installer);
  for (const file of [`${installer}.blockmap`, path.join(dist, 'latest.yml'),
    path.join(dist, 'win-unpacked', 'resources', 'app-update.yml')]) {
    if (!existsSync(file)) throw new Error(`Missing release metadata: ${path.basename(file)}`);
  }
  console.log(`Verified signed setup: ${installer}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
