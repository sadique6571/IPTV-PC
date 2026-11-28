'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');

const KEEP_SECONDS = 3630;
const KEEP_BYTES = 6 * 1024 ** 3;
const MAX_SEGMENT = 32 * 1024 ** 2;
let current;

function mediaUrl(value, base) {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid media address');
  return url;
}

function parsePlaylist(text, address) {
  if (!text.startsWith('#EXTM3U') || /^#EXT-X-(?:STREAM-INF:|MAP:|BYTERANGE:|KEY:(?!METHOD=NONE(?:\s|$)))/m.test(text)) {
    throw new Error('Time-shift is available for unencrypted MPEG-TS HLS channels');
  }
  const segments = [];
  let sequence = 0, duration = 0, date = NaN, gap = false, discontinuity = false, target = 2;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) sequence = Number(line.split(':')[1]);
    else if (line.startsWith('#EXT-X-TARGETDURATION:')) target = Number(line.split(':')[1]) || 2;
    else if (line.startsWith('#EXTINF:')) duration = Number(line.slice(8).split(',')[0]);
    else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) date = Date.parse(line.slice(25));
    else if (line === '#EXT-X-DISCONTINUITY') discontinuity = true;
    else if (line === '#EXT-X-GAP') gap = true;
    else if (line && !line.startsWith('#') && Number.isFinite(duration) && duration > 0 && Number.isSafeInteger(sequence)) {
      segments.push({ sequence: sequence++, url: mediaUrl(line, address), duration, date, gap, discontinuity });
      date += duration * 1000;
      duration = 0;
      gap = discontinuity = false;
    }
  }
  return { segments, target, ended: /^#EXT-X-ENDLIST\s*$/m.test(text) };
}

async function fetchMedia(url, signal) {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
  if (!response.ok || !response.body) throw new Error('Live feed unavailable');
  return response;
}

async function readPlaylist(url, signal) {
  const response = await fetchMedia(url, signal);
  return parsePlaylist(await response.text(), response.url);
}

async function writeSegment(segment, file, session) {
  const response = await fetchMedia(segment.url, session.signal);
  let bytes = 0;
  const limit = new Transform({
    transform(chunk, _, callback) {
      bytes += chunk.length;
      if (bytes > MAX_SEGMENT) callback(new Error('HLS segment exceeds limit'));
      else callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), limit, fs.createWriteStream(file), { signal: session.signal });
  session.transferred += bytes;
  return bytes;
}

function audioMatch(video, audio) {
  if (Number.isFinite(video.date) && audio.some(entry => Number.isFinite(entry.date))) {
    return audio.find(entry => Math.abs(entry.date - video.date) < 350);
  }
  return audio.find(entry => entry.sequence === video.sequence);
}

function manifest(session, track) {
  const entries = session.entries;
  const target = Math.max(session.target, ...entries.map(entry => Math.ceil(entry[track].duration)));
  return ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-TARGETDURATION:' + target,
    '#EXT-X-MEDIA-SEQUENCE:' + (entries[0]?.id || 0),
    '#EXT-X-DISCONTINUITY-SEQUENCE:' + (entries[0]?.priorDiscontinuities || 0),
    ...entries.flatMap(entry => [
      ...(entry.discontinuity ? ['#EXT-X-DISCONTINUITY'] : []),
      ...(Number.isFinite(entry[track].date) ? ['#EXT-X-PROGRAM-DATE-TIME:' + new Date(entry[track].date).toISOString()] : []),
      '#EXTINF:' + entry[track].duration.toFixed(6) + ',',
      track + '-' + entry.id + '.ts',
    ]), ...(session.ended ? ['#EXT-X-ENDLIST'] : []), ''].join('\n');
}

function respond(session, req, res) {
  const name = req.url?.split('?')[0];
  const prefix = '/' + session.token + '/';
  if (req.method !== 'GET' || !name?.startsWith(prefix)) { res.writeHead(404).end(); return; }
  const asset = name.slice(prefix.length);
  if (asset === 'buffer.m3u8' || asset === 'video.m3u8' || asset === 'audio.m3u8' && session.audio) {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-store');
    const text = asset === 'buffer.m3u8' && session.audio
      ? '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"\n' +
        '#EXT-X-STREAM-INF:BANDWIDTH=10000000,AUDIO="audio"\nvideo.m3u8\n'
      : manifest(session, asset === 'audio.m3u8' ? 'audio' : 'video');
    res.end(text);
    return;
  }
  if (!/^(video|audio)-\d+\.ts$/.test(asset)) { res.writeHead(404).end(); return; }
  const stream = fs.createReadStream(path.join(session.dir, asset));
  stream.once('open', () => { res.setHeader('Content-Type', 'video/mp2t'); stream.pipe(res); });
  stream.once('error', () => { if (!res.headersSent) res.writeHead(404); res.end(); });
  res.once('close', () => stream.destroy());
}

async function savePair(session, video, audio, discontinuity) {
  const id = session.nextId;
  const videoFile = path.join(session.dir, `video-${id}.ts`);
  const audioFile = path.join(session.dir, `audio-${id}.ts`);
  let bytes;
  try {
    bytes = await writeSegment(video, videoFile, session);
    if (audio) bytes += await writeSegment(audio, audioFile, session);
  } catch (error) {
    await Promise.allSettled([fsp.rm(videoFile, { force: true }), fsp.rm(audioFile, { force: true })]);
    throw error;
  }
  if (session.signal.aborted) return;
  session.nextId++;
  session.entries.push({ id, video, audio, bytes, discontinuity, priorDiscontinuities: session.discontinuities });
  if (discontinuity) session.discontinuities++;
  session.duration += video.duration;
  session.bytes += bytes;
  while (session.entries.length > 1 && (session.duration - session.entries[0].video.duration >= KEEP_SECONDS || session.bytes > KEEP_BYTES)) {
    const expired = session.entries.shift();
    session.duration -= expired.video.duration;
    session.bytes -= expired.bytes;
    session.expired.push({ id: expired.id, until: Date.now() + 30000 });
  }
}

async function record(session, anchor, offset) {
  let previous;
  let target = 2;
  let failures = 0;
  const { signal } = session;
  while (!signal.aborted) {
    try {
      const [video, audio] = await Promise.all([
        readPlaylist(session.video, signal),
        session.audio ? readPlaylist(session.audio, signal) : null,
      ]);
      target = video.target;
      session.target = video.target;
      for (const chunk of video.segments) {
        if (signal.aborted || chunk.gap) continue;
        if (!previous && chunk.sequence < anchor) continue;
        if (previous && (Number.isFinite(previous.date) && Number.isFinite(chunk.date)
          ? chunk.date <= previous.date : chunk.sequence <= previous.sequence)) continue;
        const partner = audio && audioMatch(chunk, audio.segments);
        if (audio && (!partner || partner.gap)) break;
        const discontinuity = chunk.discontinuity || !!previous && chunk.sequence !== previous.sequence + 1;
        await savePair(session, chunk, partner, discontinuity);
        if (signal.aborted) return;
        if (!previous) session.ready({ url: session.url,
          offset: chunk.sequence === anchor ? Math.max(0, Math.min(offset, chunk.duration - 0.05)) : 0,
          exact: chunk.sequence === anchor });
        previous = chunk;
      }
      failures = 0;
      session.error = '';
      while (session.expired[0]?.until <= Date.now()) {
        const { id } = session.expired.shift();
        await Promise.allSettled(['video', 'audio'].map(track => fsp.rm(
          path.join(session.dir, `${track}-${id}.ts`), { force: true },
        )));
      }
      if (video.ended) { session.ended = true; return; }
    } catch (error) {
      if (signal.aborted) return;
      if (!previous && ++failures >= 3) { session.ready({ error: error.message }); return; }
      session.error = 'Live feed interrupted. Retrying the buffer.';
    }
    await delay(Math.min(8000, Math.max(1000, target * 500)), undefined, { signal });
  }
}

async function start({ video, audio, anchor, offset }) {
  stop();
  let media, audioMedia;
  try { media = mediaUrl(video); audioMedia = audio ? mediaUrl(audio) : null; }
  catch (error) { return { error: error.message }; }
  if (!Number.isSafeInteger(anchor) || !Number.isFinite(offset)) return { error: 'No live pause point yet' };
  const controller = new AbortController();
  const session = { controller, signal: controller.signal, video: media, audio: audioMedia, token: randomUUID(),
    entries: [], expired: [], nextId: 0, target: 2, bytes: 0, transferred: 0, duration: 0, discontinuities: 0 };
  current = session;
  const ready = new Promise(resolve => { session.ready = resolve; });
  session.work = (async () => {
    session.dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'iptv-live-'));
    session.signal.throwIfAborted();
    session.server = http.createServer((req, res) => respond(session, req, res));
    await new Promise((resolve, reject) => {
      session.server.once('error', reject);
      session.server.listen(0, '127.0.0.1', resolve);
    });
    session.signal.throwIfAborted();
    session.url = `http://127.0.0.1:${session.server.address().port}/${session.token}/buffer.m3u8`;
    await record(session, anchor, offset);
  })().catch(error => { if (!session.signal.aborted) session.ready({ error: error.message }); })
    .finally(() => { if (session.signal.aborted) cleanup(session); });
  const startup = setTimeout(() => session.ready({ error: 'Live buffer could not start' }), 18000);
  const result = await ready;
  clearTimeout(startup);
  if (result.error && current === session) stop();
  return result;
}

function cleanup(session) {
  session.server?.close();
  session.server?.closeAllConnections();
  if (session.dir) fsp.rm(session.dir, { recursive: true, force: true }).catch(() => {});
}

function stop() {
  const session = current;
  if (!session) return;
  current = undefined;
  session.ready({ error: 'Live buffer closed' });
  session.controller.abort();
  cleanup(session);
}

function status() { return { bytes: current?.transferred || 0, message: current?.error || '' }; }

module.exports = { start, stop, status, parsePlaylist };
