'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');

function defaultName(title) {
  let name = String(title || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 150).replace(/[ .]+$/, '') || 'Movie';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name + '.mp4';
}

async function saveMovie(source, destination, signal, onProgress) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  let response;
  try {
    response = await fetch(source.url, {
      headers: { ...source.headers, 'Accept-Encoding': 'identity' },
      signal: AbortSignal.any([signal, controller.signal]),
    });
  } finally {
    clearTimeout(timer);
  }
  const type = response.headers.get('content-type') || '';
  if (response.status !== 200 || !response.body || /text\/|json|mpegurl|dash\+xml/i.test(type)) {
    await response.body?.cancel();
    throw new Error('Provider did not return a movie file.');
  }
  const length = Number(response.headers.get('content-length')) || 0;
  const temp = path.join(path.dirname(destination), '.iptv-' + randomUUID() + '.part');
  const file = await fs.open(temp, 'wx');
  let received = 0, last = 0;
  let prefix = Buffer.alloc(0);
  try {
    await pipeline(response.body, async function* (chunks) {
      for await (const chunk of chunks) {
        if (prefix.length < 8) {
          prefix = Buffer.concat([prefix, chunk.subarray(0, 8 - prefix.length)]);
          if (prefix.length === 8 && !['ftyp', 'moov', 'mdat', 'free', 'wide'].includes(prefix.toString('ascii', 4))) {
            throw new Error('Source is not an MP4 file.');
          }
        }
        received += chunk.length;
        if (Date.now() - last >= 200) {
          onProgress(received, length);
          last = Date.now();
        }
        yield chunk;
      }
    }, file.createWriteStream(), { signal });
    if (received < 8 || (length && received !== length)) throw new Error('Incomplete movie download.');
    signal.throwIfAborted();
    await fs.rename(temp, destination);
  } finally {
    await file.close();
    await fs.rm(temp, { force: true });
  }
}

module.exports = { defaultName, saveMovie };
