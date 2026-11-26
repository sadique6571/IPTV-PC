'use strict';

const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

async function readSignature(file) {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `
    $ErrorActionPreference = 'Stop'
    Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1')
    $signature = Get-AuthenticodeSignature -LiteralPath $env:IPTV_SIGNATURE_FILE
    if ($signature.Status -ne 'Valid' -or !$signature.SignerCertificate) { exit 1 }
    $encoding = [Text.Encoding]::UTF8
    $subject = [Convert]::ToBase64String($encoding.GetBytes($signature.SignerCertificate.Subject))
    $name = [Convert]::ToBase64String($encoding.GetBytes($signature.SignerCertificate.GetNameInfo('SimpleName', $false)))
    $raw = [Convert]::ToBase64String($signature.SignerCertificate.SubjectName.RawData)
    [Console]::Out.Write("$raw,$subject,$name")
  `;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  try {
    const { stdout } = await execFile(powershell,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        env: { ...process.env, IPTV_SIGNATURE_FILE: path.resolve(file) },
        timeout: 30000,
        windowsHide: true,
      });
    const [identity, subject, name] = stdout.trim().split(',');
    if (identity && subject && name) {
      return {
        identity,
        subject: Buffer.from(subject, 'base64').toString('utf8'),
        name: Buffer.from(name, 'base64').toString('utf8'),
      };
    }
  } catch (error) {
    throw new Error(`Could not verify the Windows publisher for ${path.basename(file)}.`, { cause: error });
  }
  throw new Error(`Windows publisher is missing from ${path.basename(file)}.`);
}

async function verifySamePublisher(appPath, installerPath, expectedPublisher) {
  const [appPublisher, installerPublisher] = await Promise.all([
    readSignature(appPath),
    readSignature(installerPath),
  ]);
  if (appPublisher.identity !== installerPublisher.identity) {
    throw new Error('The installer publisher does not match IPTV Desktop.');
  }
  if (expectedPublisher && ![appPublisher.subject, appPublisher.name].includes(expectedPublisher)) {
    throw new Error('The Windows certificate does not match the configured publisher.');
  }
}

module.exports = { readSignature, verifySamePublisher };
