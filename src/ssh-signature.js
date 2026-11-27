'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function fetchSetupSignature(tag) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error('Unexpected update version.');
  const file = 'IPTV-Desktop-Setup-' + tag.slice(1) + '.exe.sig';
  const url = 'https://github.com/sadique6571/IPTV-PC/releases/download/' + tag + '/' + file;
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Could not download the update signature.');
  const signature = await response.text();
  if (signature.length > 8192 || !signature.startsWith('-----BEGIN SSH SIGNATURE-----')) {
    throw new Error('Invalid SSH signature file.');
  }
  return signature;
}

async function verifySetupSignature(installer, signature) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'iptv-verify-'));
  let input;
  try {
    const signers = path.join(dir, 'allowed_signers');
    const sig = path.join(dir, 'setup.sig');
    await fs.writeFile(signers, await fs.readFile(path.join(__dirname, 'release-signers')));
    await fs.writeFile(sig, signature);
    input = await fs.open(installer, 'r');
    const exe = path.join(process.env.SystemRoot, 'System32', 'OpenSSH', 'ssh-keygen.exe');
    await new Promise((resolve, reject) => {
      const child = spawn(exe, ['-Y', 'verify', '-f', signers, '-I', 'iptv-desktop', '-n', 'file', '-s', sig],
        { stdio: [input.fd, 'ignore', 'ignore'], windowsHide: true, timeout: 120000 });
      child.on('error', err => reject(err.code === 'ENOENT' ? new Error('Windows OpenSSH Client is required to verify this update.') : err));
      child.on('close', code => code === 0 ? resolve() : reject(new Error('SSH update signature verification failed.')));
    });
  } finally {
    if (input) await input.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { fetchSetupSignature, verifySetupSignature };
