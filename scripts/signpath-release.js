'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { Arch, build, Platform } = require('electron-builder');
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');
const { dump, load } = require('js-yaml');
const { readSignature, verifySamePublisher } = require('../src/windows-signature');
const pkg = require('../package.json');

const projectDir = path.join(__dirname, '..');
const staging = path.join(projectDir, 'dist', 'signpath');
const appDir = path.join(staging, 'win-unpacked');
const appName = `${pkg.build.productName}.exe`;
const appFile = path.join(appDir, appName);
const setupName = pkg.build.nsis.artifactName.replace('${version}', pkg.version).replace('${ext}', 'exe');
const setupDir = path.join(staging, 'setup');
const releaseDir = path.join(staging, 'release');
const appUpdatePath = path.join(appDir, 'resources', 'app-update.yml');

function buildConfig(output) {
  return {
    directories: { output },
    win: { forceCodeSigning: false, signExecutable: false },
  };
}

async function packApp() {
  execFileSync(process.execPath, [path.join(__dirname, 'prepare-ffmpeg.js'), 'win'], { stdio: 'inherit' });
  await build({
    projectDir,
    targets: Platform.WINDOWS.createTarget(['dir'], Arch.x64),
    publish: 'never',
    config: buildConfig(staging),
  });
  await fs.access(appFile);
}

async function packSetup() {
  const signedApp = path.join(staging, 'signed-app', appName);
  const signature = await readSignature(signedApp);
  const publisherName = process.env.SIGNPATH_PUBLISHER_NAME?.trim();
  if (!publisherName) throw new Error('Configure SIGNPATH_PUBLISHER_NAME with the approved certificate subject.');
  if (![signature.subject, signature.name].includes(publisherName)) {
    throw new Error('The signed application does not match SIGNPATH_PUBLISHER_NAME.');
  }
  await fs.copyFile(signedApp, appFile);
  await fs.writeFile(appUpdatePath, dump({
    ...pkg.build.publish,
    publisherName: [publisherName],
    updaterCacheDirName: `${pkg.name}-updater`,
  }), 'utf8');

  await build({
    projectDir,
    prepackaged: appDir,
    targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
    publish: 'never',
    config: buildConfig(setupDir),
  });
  await fs.access(path.join(setupDir, setupName));
}

async function finalize() {
  const signedSetup = path.join(staging, 'signed-setup', setupName);
  const { publisherName } = load(await fs.readFile(appUpdatePath, 'utf8'));
  await verifySamePublisher(appFile, signedSetup, publisherName[0]);
  await fs.mkdir(releaseDir, { recursive: true });
  const setup = path.join(releaseDir, setupName);
  await fs.copyFile(signedSetup, setup);
  const { size, sha512 } = await buildBlockMap(setup, 'gzip', `${setup}.blockmap`);
  await fs.writeFile(path.join(releaseDir, 'latest.yml'), dump({
    version: pkg.version,
    files: [{ url: setupName, sha512, size }],
    path: setupName,
    sha512,
    releaseDate: new Date().toISOString(),
  }), 'utf8');
}

async function main() {
  if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('Run SignPath release stages on the GitHub-hosted Windows runner.');
  }
  const phase = process.argv[2];
  if (phase === 'app') await packApp();
  else if (phase === 'setup') await packSetup();
  else if (phase === 'finalize') await finalize();
  else throw new Error('Choose the app, setup, or finalize stage.');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
