// IPTV Desktop — MovieBox client (main process, Node).
// Faithful JS port of the Android MovieBox.kt / MovieBoxSeries.kt /
// MovieBoxFeeds.kt client, per docs/moviebox-api.md (verbatim spec).
// Flow: visitor login (JWT, 7 days) -> signed mobile API (HMAC-MD5) for
// search/details/feeds; playable MP4s from resourceDetectors and
// play-info/v2 (movies) and the unsigned H5 endpoint (series, and the
// proven path for titles like The Body [Hindi] whose mobile links are
// only the notice clip). English captions via the H5 caption endpoint.
// Resolved URLs are signed and expire within hours — resolve at play time.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { hasHindiAudio, searchTitles } = require('./movie-search');

// ---------- constants (verbatim from MovieBox.kt) ----------
const BASE = '/wefeed-mobile-bff';
const USER_AGENT =
  'com.community.oneroom/50020044 (Linux; U; Android 11; en_US; 2201117TY; Build/RP1A.200720.011; Cronet/135.0.7012.3)';
const CERT_SHA256 = '03d4b741632d136bc23e2de4c6adcdb7712f1980b619c183221801730bbd0410';
const SECRET_BYTES = Buffer.from([
  0xef, 0xa8, 0x91, 0x97, 0x4e, 0xec, 0xd3, 0x14,
  0x8d, 0xf6, 0x3a, 0xa6, 0x11, 0x60, 0x2d, 0xef,
  0xd1, 0x01, 0x25, 0x9b, 0xa5, 0x21, 0x02, 0x2c,
  0x57, 0xae, 0x05, 0x66, 0xbd, 0x8e,
]);
const STREAM_REFERER = 'https://sportslive.wine';
const HOSTS = [
  'https://api6.aoneroom.com',
  'https://api5.aoneroom.com',
  'https://api4.aoneroom.com',
  'https://api4sg.aoneroom.com',
  'https://api3.aoneroom.com',
  'https://api6sg.aoneroom.com',
  'https://api.inmoviebox.com',
];
const RETRY_STATUSES = new Set([403, 406, 407, 429, 500, 502, 503, 504]);
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const H5_PLAY_HOST = 'https://vidiomoviebox.xyz';
const CAPTION_HOSTS = [
  'https://themoviebox.xyz', // code's host (MovieBox.kt)
  'https://h5-api.aoneroom.com', // verified live 2026-11-25 as fallback
];

// ---------- per-install identity (persisted in userData/moviebox.json) ----------
function mbStatePath() {
  return path.join(app.getPath('userData'), 'moviebox.json');
}
function randomHex(len) {
  const chars = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * 16)];
  return out;
}
function randomUuid() {
  return `${randomHex(8)}-${randomHex(4)}-${randomHex(4)}-${randomHex(4)}-${randomHex(12)}`;
}
function randomSpoofedIp() {
  const prefixes = ['103.241', '49.36', '117.195', '106.198', '122.162',
    '157.32', '182.70', '103.58', '27.60', '59.90'];
  const p = prefixes[Math.floor(Math.random() * prefixes.length)];
  return `${p}.${1 + Math.floor(Math.random() * 253)}.${1 + Math.floor(Math.random() * 253)}`;
}
let mbState = null;
function loadMbState() {
  if (mbState) return mbState;
  try { mbState = JSON.parse(fs.readFileSync(mbStatePath(), 'utf8')); } catch (_) { mbState = {}; }
  let dirty = false;
  if (!mbState.deviceId) { mbState.deviceId = randomHex(32); dirty = true; }
  if (!mbState.gaid) { mbState.gaid = randomUuid(); dirty = true; }
  if (dirty) saveMbState();
  return mbState;
}
function saveMbState() {
  try {
    fs.mkdirSync(path.dirname(mbStatePath()), { recursive: true });
    fs.writeFileSync(mbStatePath(), JSON.stringify(mbState), 'utf8');
  } catch (_) { /* non-fatal */ }
}
const spoofedIp = randomSpoofedIp();

// ---------- signing (Section 3 of the spec) ----------
const md5Hex = (buf) => crypto.createHash('md5').update(buf).digest('hex');

function urlEncode(value) {
  // Java URLEncoder: space -> '+', unreserved a-z A-Z 0-9 . - * _
  return encodeURIComponent(String(value))
    .replace(/%20/g, '+')
    .replace(/~/g, '%7E')
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}
function urlDecode(value) {
  try { return decodeURIComponent(String(value).replace(/\+/g, ' ')); } catch (_) { return value; }
}
function sortedQuery(rawQuery) {
  if (!rawQuery) return '';
  return rawQuery.split('&')
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq < 0) return null;
      return [urlDecode(part.slice(0, eq)), urlDecode(part.slice(eq + 1))];
    })
    .filter(Boolean)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join('&');
}
function canonicalString(method, url, body, ts) {
  let pathPart = url, query = '';
  try { const u = new URL(url); pathPart = u.pathname; query = u.search.slice(1); } catch (_) {}
  const sorted = sortedQuery(query);
  const canonicalUrl = sorted ? `${pathPart}?${sorted}` : pathPart;
  let bodyHash = '', bodyLength = '';
  if (body !== null && body !== undefined) {
    const bytes = Buffer.from(body, 'utf8');
    bodyHash = md5Hex(bytes.subarray(0, 102400));
    bodyLength = String(bytes.length);
  }
  return [method.toUpperCase(), 'application/json', 'application/json',
    bodyLength, String(ts), bodyHash, canonicalUrl].join('\n');
}
function buildTag(ts) {
  const stamp = `${Math.floor(ts / 1000)}${String(ts % 1000).padStart(3, '0')}000${Math.floor(Math.random() * 1000)}`;
  const hash = md5Hex(Buffer.from(CERT_SHA256 + 'oneroom' + stamp, 'utf8'));
  return `${stamp}.${hash}`;
}
function signedHeaders(method, url, body, token) {
  const st = loadMbState();
  const ts = Date.now();
  const clientToken = `${ts},${md5Hex(Buffer.from([...String(ts)].reverse().join(''), 'utf8'))}`;
  const tag = buildTag(ts);
  const canonical = canonicalString(method, url, body, ts);
  const sig = crypto.createHmac('md5', SECRET_BYTES).update(canonical, 'utf8').digest('base64');
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Connection: 'keep-alive',
    'x-client-token': clientToken,
    'x-tr-signature': `${ts}|2|${sig}`,
    'x-client-build': tag,
    'x-client-info': `{"package_name":"com.community.oneroom","version_name":"3.0.03.0529.03","version_code":50020044,"os":"android","os_version":"11","install_ch":"ps","device_id":"${st.deviceId}","install_store":"ps","gaid":"${st.gaid}","brand":"Redmi","model":"2201117TY","system_language":"en","net":"NETWORK_WIFI","region":"US","timezone":"Asia/Kolkata","sp_code":"40401","X-Play-Mode":"2","X-Client-Build":"${tag}"}`,
    'x-client-status': '0',
    'x-forwarded-for': spoofedIp,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// ---------- transport: host rotation, retry, token refresh ----------
let activeHostIdx = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class AuthError extends Error {}
class ApiError extends Error {}
class HostsExhaustedError extends Error {}

async function httpCall(method, url, body, token) {
  const headers = signedHeaders(method, url, body, token);
  const res = await fetch(url, {
    method,
    headers,
    body: body == null ? undefined : body,
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  const text = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
  const lowerHeaders = {};
  res.headers.forEach((v, k) => { lowerHeaders[k.toLowerCase()] = v; });
  return { status: res.status, headers: lowerHeaders, text };
}

function absorbXUser(headers) {
  const raw = headers['x-user'] || '';
  if (!raw) return;
  try {
    const token = JSON.parse(raw).token || '';
    const st = loadMbState();
    if (token && token !== st.token) saveSession(token);
  } catch (_) {}
}
function parseJwtExp(token) {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return 0;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return Number(payload.exp) || 0;
  } catch (_) { return 0; }
}
function saveSession(token) {
  const st = loadMbState();
  st.token = token;
  st.tokenExp = parseJwtExp(token);
  st.tokenCreated = Math.floor(Date.now() / 1000);
  saveMbState();
}
function clearSession() {
  const st = loadMbState();
  delete st.token; delete st.tokenExp; delete st.tokenCreated;
  saveMbState();
}
function loadSession() {
  const st = loadMbState();
  if (!st.token) return false;
  const now = Math.floor(Date.now() / 1000);
  const valid = st.tokenExp > 0 ? now + 60 < st.tokenExp : now < (st.tokenCreated || 0) + 7 * 24 * 3600;
  return !!valid;
}
async function ensureToken() {
  const st = loadMbState();
  if (st.token && loadSession()) return st.token;
  const data = await requestHosts('POST', `${BASE}/user-api/visitor-login`, '{}', null);
  const token = (data && data.token) || '';
  if (!token) throw new Error('MovieBox login failed: no token.');
  saveSession(token);
  return token;
}
async function requestHosts(method, pathSuffix, body, token) {
  const startIdx = activeHostIdx;
  let backoffMs = 50;
  let lastError = null;
  for (let i = 0; i < HOSTS.length; i++) {
    if (i > 0) { await sleep(backoffMs); backoffMs = 50; }
    const idx = (startIdx + i) % HOSTS.length;
    const url = HOSTS[idx] + pathSuffix;
    try {
      const { status, headers, text } = await httpCall(method, url, body, token);
      absorbXUser(headers);
      if (RETRY_STATUSES.has(status)) {
        activeHostIdx = (idx + 1) % HOSTS.length;
        if (status === 429) {
          const ra = Number(headers['retry-after']);
          backoffMs = Number.isFinite(ra) ? Math.min(ra * 1000, 3000) : 400;
        }
        lastError = `HTTP ${status}`;
        continue;
      }
      if (status === 401) throw new AuthError('HTTP 401');
      if (status < 200 || status > 299) throw new ApiError(`MovieBox HTTP ${status}`);
      activeHostIdx = idx;
      let json;
      try { json = JSON.parse(text); } catch (_) { throw new Error('Bad JSON from MovieBox'); }
      const code = json.code == null ? 0 : json.code;
      if (code === 441) throw new AuthError('API code 441');
      if (code !== 0) throw new ApiError(`MovieBox error ${code}: ${json.message || ''}`);
      return (json.data && typeof json.data === 'object') ? json.data : json;
    } catch (e) {
      if (e instanceof AuthError || e instanceof ApiError) throw e;
      lastError = e.message;
      activeHostIdx = (idx + 1) % HOSTS.length;
      continue;
    }
  }
  throw new HostsExhaustedError(`MovieBox: all hosts failed (${lastError})`);
}
async function request(method, pathSuffix, body) {
  const token = await ensureToken();
  try {
    return await requestHosts(method, pathSuffix, body, token);
  } catch (e) {
    if (e instanceof AuthError || e instanceof HostsExhaustedError) {
      clearSession();
      return await requestHosts(method, pathSuffix, body, await ensureToken());
    }
    throw e;
  }
}

// ---------- parsing helpers ----------
function idString(obj, ...keys) {
  for (const k of keys) {
    const v = obj && obj[k];
    if (v === '' || v == null) continue;
    return String(v);
  }
  return null;
}
function longValue(obj, key) {
  const v = obj && obj[key];
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Math.trunc(Number(v));
  return 0;
}
function longKeys(obj, ...keys) {
  for (const k of keys) { const v = longValue(obj, k); if (v !== 0) return v; }
  return 0;
}
function stringList(obj, ...keys) {
  for (const k of keys) {
    const v = obj && obj[k];
    if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
    if (typeof v === 'string' && v.trim()) return v.split(',').map((x) => x.trim()).filter(Boolean);
  }
  return [];
}
function extractYear(value) {
  const m = String(value || '').match(/(19|20)\d\d/);
  return m ? m[0] : '';
}
function isDeprecationNoticeUrl(url) {
  const lower = String(url || '').toLowerCase();
  return lower.includes('1c7de0bd3393702d9191801f15f88f8d') ||
    lower.includes('9a0461bc39da389663bf3dbb17091d3f') ||
    lower.includes('b164fbfb4347792950bdfbfb563d39d9') ||
    lower.includes('/notice.mp4') ||
    (lower.includes('macdn.aoneroom.com') && lower.includes('/other/'));
}
const CAM_TITLE_REGEX = /\b(cam|hdcam|hdts|hd-ts|camrip|cam-rip|tsrip|telesync|telecine|hdtc|predvd)\b|\bhd\s*-?\s*cam\b/i;
const ADULT_TITLE_REGEX = /\b(xxx|porn|porno|erotic|erotica|hentai)\b|\bsex\s+tape\b|18\+/i;
const ADULT_GENRES = new Set(['adult', 'erotic', 'erotica', 'porn', 'pornography', 'xxx', 'hentai']);
function isAdultGenre(g) {
  const t = String(g || '').trim().toLowerCase();
  return ADULT_GENRES.has(t) || t.includes('adult') || t.includes('erotic') || t.includes('porn');
}
function parseSearchMovie(s) {
  if (!s) return null;
  const id = idString(s, 'subjectId', 'id');
  if (!id) return null;
  const stype = (s.subjectType != null ? s.subjectType : (s.stype != null ? s.stype : 1));
  if (stype !== 1 && stype !== 2) return null;
  if (!s.hasResource) return null;
  const title = (s.title != null && s.title !== '' ? s.title : (s.name || ''));
  if (!title) return null;
  if (CAM_TITLE_REGEX.test(title) || ADULT_TITLE_REGEX.test(title)) return null;
  const genres = stringList(s, 'genre', 'genres');
  if (genres.some(isAdultGenre)) return null;
  const year = extractYear(s.releaseDate != null ? s.releaseDate : (s.year != null ? s.year : (s.releaseInfo || '')));
  const poster = (s.cover && s.cover.url) ? s.cover.url
    : (s.coverUrl || s.poster || s.pic || '');
  return {
    subjectId: id,
    title,
    year,
    poster: poster || '',
    isHindi: hasHindiAudio(s, title),
    releaseDate: s.releaseDate || '',
    type: stype === 2 ? 'series' : 'movie',
  };
}
function subjectsFrom(data) {
  const out = [];
  if (!data || typeof data !== 'object') return out;
  const results = data.results;
  if (Array.isArray(results)) {
    for (const g of results) {
      const subjects = g && g.subjects;
      if (!Array.isArray(subjects)) continue;
      for (const s of subjects) { const m = parseSearchMovie(s); if (m) out.push(m); }
    }
    if (out.length) return out;
  }
  for (const key of ['list', 'subjects', 'items', 'data']) {
    const arr = data[key];
    if (!Array.isArray(arr)) continue;
    for (const s of arr) { const m = parseSearchMovie(s); if (m) out.push(m); }
    if (out.length) return out;
  }
  return out;
}
function detailPageUrl(subjectId, detailPath) {
  return `https://themoviebox.xyz/movies/${detailPath}?id=${subjectId}&type=/movie/detail&detailSe=&detailEp=&lang=en`;
}

// ---------- search / details ----------
async function searchPage(query, page) {
  const body = JSON.stringify({ keyword: query, page, perPage: 15, subjectType: 0 });
  const data = await request('POST', `${BASE}/subject-api/search/v2`, body);
  const results = (data && data.results) || [];
  const movies = [];
  for (const g of results) {
    const subjects = (g && g.subjects) || [];
    for (const s of subjects) { const m = parseSearchMovie(s); if (m) movies.push(m); }
  }
  return movies;
}
async function search(query, known = []) {
  try {
    return { results: await searchTitles(query, known, searchPage) };
  } catch (e) {
    return { error: `Search failed: ${e.message}` };
  }
}
async function getDetails(subjectId) {
  try {
    const data = await request('GET', `${BASE}/subject-api/get?subjectId=${urlEncode(subjectId)}`, null);
    const subject = (data && data.subject) || data || {};
    const title = subject.title || 'Unknown';
    if (CAM_TITLE_REGEX.test(title) || ADULT_TITLE_REGEX.test(title)) {
      return { error: 'Ye title dikhaya nahi ja sakta.' };
    }
    const genres = stringList(subject, 'genre', 'genres');
    if (genres.some(isAdultGenre)) return { error: 'Ye title dikhaya nahi ja sakta.' };
    const stype = subject.subjectType != null ? subject.subjectType : (subject.stype != null ? subject.stype : 1);
    const isSeries = stype === 2;
    const detailPath = String(subject.detailUrl || '').split('/').pop().split('?')[0].trim();
    const dubs = [];
    if (Array.isArray(subject.dubs)) {
      for (const d of subject.dubs) {
        const dubId = idString(d, 'subjectId', 'id');
        if (!dubId) continue;
        const language = d.lanName || d.language || d.lang || 'Unknown';
        const label = d.title || d.name || language;
        dubs.push({ subjectId: dubId, language, label });
      }
    }
    const ratingRaw = subject.imdbRatingValue != null ? subject.imdbRatingValue : subject.rating;
    const rating = typeof ratingRaw === 'number' ? ratingRaw.toFixed(1) : (ratingRaw || '');
    const details = {
      subjectId: idString(subject, 'subjectId', 'id') || subjectId,
      title,
      year: extractYear(subject.releaseDate != null ? subject.releaseDate : (subject.year || '')),
      type: isSeries ? 'series' : 'movie',
      poster: (subject.cover && subject.cover.url) || subject.coverUrl || subject.poster || subject.pic || '',
      genres,
      overview: subject.description || subject.intro || '',
      rating,
      director: subject.director || '',
      stars: subject.stars || '',
      durationSec: longValue(subject, 'duration'),
      dubs,
      detailPath,
      detectors: (data && data.resourceDetectors) || subject.resourceDetectors || null,
    };
    if (isSeries) details.seasons = await seasons(subjectId);
    return details;
  } catch (e) {
    return { error: `Details failed: ${e.message}` };
  }
}

// ---------- seasons ----------
function parseSeasons(data) {
  const arrays = [data && data.seasons, data && data.seasonList, data && data.list].filter(Array.isArray);
  const seasons = [];
  for (const arr of arrays) {
    for (const s of arr) {
      if (!s || typeof s !== 'object') continue;
      const number = longKeys(s, 'se', 'season', 'seasonNumber', 'index');
      if (number <= 0) continue;
      const name = s.name || s.title || s.seasonName || '';
      const episodes = [];
      const epArr = s.episodes || s.episodeList || s.eps;
      if (Array.isArray(epArr)) {
        for (const e of epArr) {
          let epNum = 0; let epTitle = '';
          if (e != null && typeof e === 'object') {
            epNum = longKeys(e, 'ep', 'episode', 'episodeNumber', 'index');
            epTitle = e.title || e.name || '';
          } else if (typeof e === 'number') epNum = e;
          if (epNum <= 0) continue;
          episodes.push({ number: epNum, title: epTitle });
        }
      } else {
        const count = Math.max(0, Math.min(5000, longKeys(s, 'episodeCount', 'epCount', 'totalEpisode', 'count', 'maxEp')));
        for (let n = 1; n <= count; n++) episodes.push({ number: n, title: '' });
      }
      if (episodes.length) {
        episodes.sort((a, b) => a.number - b.number);
        seasons.push({ number, name, episodes });
      }
    }
    if (seasons.length) return seasons.sort((a, b) => a.number - b.number);
  }
  return [];
}
async function seasons(subjectId) {
  try {
    const data = await request('GET', `${BASE}/subject-api/season-info?subjectId=${urlEncode(subjectId)}`, null);
    const parsed = parseSeasons(data);
    if (parsed.length) return parsed;
  } catch (_) { /* fall through */ }
  const pairs = new Set();
  for (let page = 1; page <= 2; page++) {
    try {
      const data = await request('GET', `${BASE}/subject-api/resource?subjectId=${urlEncode(subjectId)}&page=${page}&perPage=20`, null);
      const items = (data && data.list) || [];
      if (!items.length) break;
      for (const item of items) {
        const se = longValue(item, 'se');
        const ep = longValue(item, 'ep');
        if (se > 0 && ep > 0) pairs.add(`${se}:${ep}`);
      }
    } catch (_) { break; }
  }
  const bySeason = {};
  for (const key of pairs) {
    const [se, ep] = key.split(':').map(Number);
    (bySeason[se] = bySeason[se] || []).push(ep);
  }
  return Object.keys(bySeason).map(Number).sort((a, b) => a - b).map((se) => ({
    number: se,
    name: '',
    episodes: [...new Set(bySeason[se])].sort((a, b) => a - b).map((n) => ({ number: n, title: '' })),
  }));
}

// ---------- stream resolution ----------
function resolutionFromSourceLink(link) {
  const upper = String(link || '').toUpperCase();
  let idx = upper.indexOf('P');
  while (idx >= 0) {
    let start = idx;
    while (start > 0 && /\d/.test(upper[start - 1])) start--;
    const digits = upper.slice(start, idx);
    if (digits.length >= 3 && digits.length <= 4) return parseInt(digits, 10) || 0;
    idx = upper.indexOf('P', idx + 1);
  }
  return 0;
}
function parseDetectorItem(item) {
  if (!item) return null;
  if (longValue(item, 'se') !== 0 || longValue(item, 'ep') !== 0) return null;
  const url = item.resourceLink || item.url || '';
  if (!url || isDeprecationNoticeUrl(url)) return null;
  const title = item.title || item.fileName || '';
  if (CAM_TITLE_REGEX.test(title)) return null;
  return {
    url,
    resolution: longValue(item, 'resolution'),
    codec: item.codecName || item.codec || '',
    sizeBytes: longValue(item, 'size'),
    durationSec: longValue(item, 'duration'),
    headers: { 'User-Agent': USER_AGENT },
    id: '',
  };
}
function detectorStreams(detectors) {
  const out = [];
  if (!Array.isArray(detectors)) return out;
  for (const det of detectors) {
    const resList = det && det.resolutionList;
    if (Array.isArray(resList) && resList.length) {
      for (const item of resList) { const s = parseDetectorItem(item); if (s) out.push(s); }
      continue;
    }
    const downloadUrl = (det && det.downloadUrl) || '';
    if (!downloadUrl) continue;
    out.push({
      url: downloadUrl,
      resolution: resolutionFromSourceLink((det && det.resourceLink) || ''),
      codec: (det && det.codecName) || '',
      sizeBytes: longValue(det, 'firstSize'),
      durationSec: 0,
      headers: { 'User-Agent': USER_AGENT },
      id: '',
    });
  }
  return out;
}
function parsePlayInfoStream(stream, displayResolutions) {
  if (!stream) return null;
  const signCookie = stream.signCookie || '';
  const streamUrl = stream.url || '';
  // DASH via signCookie is not supported by the desktop player in v1
  // (no dash.js); only direct files are returned here.
  if (isDeprecationNoticeUrl(streamUrl) || !streamUrl.startsWith('http')) return null;
  const resolutions = String(stream.resolutions || displayResolutions || '')
    .split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => n > 0);
  const maxRes = resolutions.length ? Math.max(...resolutions) : 1080;
  const headers = { Referer: STREAM_REFERER, 'User-Agent': USER_AGENT };
  if (signCookie) {
    headers.Cookie = signCookie.replace(/;+$/, '').split(';').map((x) => x.trim()).filter(Boolean).join('; ');
  }
  return {
    url: streamUrl,
    resolution: maxRes,
    codec: stream.codecName || stream.codec || '',
    sizeBytes: longValue(stream, 'size'),
    durationSec: longValue(stream, 'duration'),
    headers,
    id: stream.id || '',
  };
}
async function playInfoStreams(subjectId, season, episode) {
  try {
    let pathSuffix = `${BASE}/subject-api/play-info/v2?subjectId=${urlEncode(subjectId)}`;
    if (season != null && episode != null) pathSuffix += `&se=${season}&ep=${episode}`;
    const data = await request('GET', pathSuffix, null);
    const streams = (data && data.streams) || [];
    const displayRes = (data && data.displayResolutions) || '';
    const out = [];
    for (const s of streams) { const p = parsePlayInfoStream(s, displayRes); if (p) out.push(p); }
    return out;
  } catch (_) { return []; }
}
// H5 endpoint — unsigned; needs the player-page Referer with the exact slug.
async function h5PlayStreams(subjectId, season, episode, detailPath) {
  if (!detailPath) return [];
  const url = `${H5_PLAY_HOST}/wefeed-h5api-bff/subject/play?subjectId=${urlEncode(subjectId)}&se=${season}&ep=${episode}`;
  const referer = `${H5_PLAY_HOST}/player/${detailPath}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', Referer: referer },
      signal: AbortSignal.timeout(15000),
    });
  } catch (_) { return []; }
  if (!res.ok) return [];
  let json;
  try { json = await res.json(); } catch (_) { return []; }
  const streams = (json && json.data && json.data.streams) || [];
  const out = [];
  for (const row of streams) {
    const streamUrl = row.url || '';
    if (!streamUrl || !streamUrl.startsWith('http') || isDeprecationNoticeUrl(streamUrl)) continue;
    const resolution = parseInt(String(row.resolutions || '').split(',')[0], 10) || 0;
    out.push({
      url: streamUrl,
      resolution,
      codec: row.codecName || '',
      sizeBytes: longValue(row, 'size'),
      durationSec: longValue(row, 'duration'),
      // The FILE request needs the detail-page Referer (CDN 429s without
      // it) — different from the play-API Referer above.
      headers: { 'User-Agent': USER_AGENT, Referer: detailPageUrl(subjectId, detailPath) },
      id: row.id || '',
    });
  }
  return out;
}
function dedupeAndSort(streams) {
  const seen = new Set();
  const out = [];
  for (const s of streams) {
    if (!s || !s.url || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  out.sort((a, b) => (a.resolution || 0) - (b.resolution || 0));
  return out;
}
function toSources(streams) {
  return dedupeAndSort(streams).map((s) => ({
    label: s.resolution > 0 ? `${s.resolution}p` : 'Auto',
    url: s.url,
    resolution: s.resolution || 0,
    headers: s.headers || {},
    id: s.id || '',
  }));
}

// ---------- public API (called from main.js IPC) ----------
async function getPlayStreams({ subjectId, se, ep, detailPath }) {
  const isSeries = se != null && ep != null && (se > 0 || ep > 0);
  try {
    let streams = [];
    if (isSeries) {
      streams = await playInfoStreams(subjectId, se, ep);
      if (!streams.length) streams = await h5PlayStreams(subjectId, se, ep, detailPath);
    } else {
      const details = await getDetails(subjectId);
      if (details.error) return { error: details.error };
      streams = detectorStreams(details.detectors);
      if (!streams.length) streams = await playInfoStreams(subjectId);
      if (!streams.length) streams = await h5PlayStreams(subjectId, 0, 0, details.detailPath);
    }
    const sources = toSources(streams);
    if (!sources.length) return { error: 'No playable streams found for this title.' };
    const firstId = (sources.find((s) => s.id) || {}).id || '';
    // Player headers: use the best (highest-resolution) stream's headers;
    // the main process injects them on the file request (Referer/Cookie).
    const best = sources[sources.length - 1];
    return {
      sources,
      streamId: firstId,
      referer: (best.headers && best.headers.Referer) || '',
      cookie: (best.headers && best.headers.Cookie) || '',
    };
  } catch (e) {
    return { error: `Stream lookup failed: ${e.message}` };
  }
}

// ---------- captions ----------
function srtToVtt(srt) {
  let text = String(srt || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = text.split(/\n\s*\n/).filter((b) => b.trim());
  const out = ['WEBVTT', ''];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    let i = 0;
    if (/^\d+$/.test(lines[0].trim())) i = 1; // sequence number
    if (i >= lines.length) continue;
    const timing = lines[i].replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    if (!/-->/.test(timing)) continue;
    out.push(timing);
    out.push(...lines.slice(i + 1));
    out.push('');
  }
  return out.join('\n');
}
async function getEnglishCaptions({ streamId, subjectId, detailPath }) {
  if (!streamId || !subjectId || !detailPath) return { error: 'Missing caption parameters.' };
  for (const host of CAPTION_HOSTS) {
    const url = `${host}/wefeed-h5api-bff/subject/caption?format=MP4&id=${urlEncode(streamId)}&subjectId=${urlEncode(subjectId)}&detailPath=${urlEncode(detailPath)}`;
    let res;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          'X-Client-Info': JSON.stringify({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Karachi' }),
          Referer: detailPageUrl(subjectId, detailPath),
        },
        signal: AbortSignal.timeout(15000),
      });
    } catch (_) { continue; }
    if (!res.ok) continue;
    let json;
    try { json = await res.json(); } catch (_) { continue; }
    const captions = (json && json.data && json.data.captions) || [];
    for (const cap of captions) {
      if (String(cap.lan || '').toLowerCase() !== 'en') continue;
      const capUrl = cap.url || '';
      if (!capUrl || !capUrl.startsWith('http')) continue;
      try {
        const srtRes = await fetch(capUrl, { signal: AbortSignal.timeout(15000) });
        if (!srtRes.ok) return { error: 'Caption file unavailable.' };
        const srt = await srtRes.text();
        return { vtt: srtToVtt(srt) };
      } catch (_) { return { error: 'Caption download failed.' }; }
    }
    return { error: 'No English captions for this title.' };
  }
  return { error: 'Caption service unreachable.' };
}

// ---------- home feeds ----------
async function homeFeed(tabId) {
  try {
    const data = await request('GET', `${BASE}/tab-operating?page=1&tabId=${tabId}&version=`, null);
    const items = (data && data.items) || [];
    const sections = [];
    for (const item of items) {
      const title = item.title || item.name || item.moduleTitle || item.tabName || '';
      const movies = [];
      const seen = new Set();
      const collect = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const s of arr) {
          const subj = s && s.subject ? s.subject : s;
          const m = parseSearchMovie(subj);
          if (m && !seen.has(m.subjectId)) { seen.add(m.subjectId); movies.push(m); }
        }
      };
      collect(item.subjects);
      collect(item.banner && item.banner.banners);
      collect(item.customData && item.customData.items);
      if (title && movies.length) sections.push({ title, movies });
    }
    return sections;
  } catch (_) { return []; }
}
async function listMovies(genre, sort) {
  const body = JSON.stringify({ tabId: 2, page: 1, perPage: 20, classify: 'All', country: 'All', genre: genre || 'All', sort: sort || 'Newest', year: 'All' });
  const data = await request('POST', `${BASE}/subject-api/list`, body);
  return subjectsFrom(data);
}
function byYearDesc(list) {
  return [...list].sort((a, b) => (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0));
}
async function getFeed() {
  try {
    const [fresh, trend, picks, series] = await Promise.all([
      (async () => {
        try {
          const list = (await listMovies('All', 'Newest')).filter((m) => m.type === 'movie');
          if (list.length) return byYearDesc(list).slice(0, 20);
        } catch (_) {}
        const feed = [...await homeFeed(0), ...await homeFeed(2)].flatMap((s) => s.movies);
        const recent = feed.filter((m) => m.type === 'movie' && (m.year === '2026' || m.year === '2025'));
        const deduped = [...new Map(recent.map((m) => [m.subjectId, m])).values()];
        if (deduped.length) return byYearDesc(deduped).slice(0, 20);
        return byYearDesc([...new Map(feed.filter((m) => m.type === 'movie').map((m) => [m.subjectId, m])).values()]).slice(0, 20);
      })(),
      (async () => {
        try {
          const body = JSON.stringify({ page: 1, perPage: 20 });
          const data = await request('POST', `${BASE}/subject-api/trending/v2`, body);
          return subjectsFrom(data).filter((m) => m.type === 'movie').slice(0, 20);
        } catch (_) { return []; }
      })(),
      (async () => {
        for (const [pathSuffix, body] of [
          [`${BASE}/subject-api/daily-movie-rec`, '{}'],
          [`${BASE}/subject-api/top-rec`, JSON.stringify({ page: 1, perPage: 20 })],
        ]) {
          try {
            const data = await request('POST', pathSuffix, body);
            const list = subjectsFrom(data).filter((m) => m.type === 'movie');
            if (list.length) return list.slice(0, 20);
          } catch (_) { /* try next */ }
        }
        return [];
      })(),
      (async () => {
        const feed = [...await homeFeed(0), ...await homeFeed(5), ...await homeFeed(19)].flatMap((s) => s.movies);
        return [...new Map(feed.filter((m) => m.type === 'series').map((m) => [m.subjectId, m])).values()].slice(0, 20);
      })(),
    ]);
    const recommended = [...new Map([...trend, ...picks].map((m) => [m.subjectId, m])).values()];
    const pickIds = new Set(recommended.map((m) => m.subjectId));
    const rails = [];
    if (trend.length) rails.push({ title: 'Trending Now', items: trend.slice(0, 10) });
    if (picks.length) rails.push({ title: 'Top Picks for You', items: picks });
    const freshFiltered = byYearDesc(fresh.filter((m) => !pickIds.has(m.subjectId)));
    if (freshFiltered.length) rails.push({ title: 'New Release', items: freshFiltered });
    if (recommended.length) rails.push({ title: 'Recommended', items: recommended });
    if (series.length) rails.push({ title: 'Series', items: series });
    return { rails };
  } catch (e) {
    return { error: `Feed failed: ${e.message}` };
  }
}

module.exports = { search, getDetails, getPlayStreams, getEnglishCaptions, getFeed };
