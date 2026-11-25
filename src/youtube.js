// IPTV Desktop — YouTube live resolver (main process only).
// The 3 YouTube channels (92 News, City 41, Express News) have no
// direct stream URL — their live video ID changes whenever the stream
// restarts, so it is resolved at play time from the channel's /live
// page instead of being hardcoded. The page's ytInitialPlayerResponse
// JSON carries videoDetails (videoId + isLive) and playabilityStatus.
// Note: YouTube sometimes answers LOGIN_REQUIRED for anonymous fetches
// (seen for Express News and 92 News from this sandbox) — the caller
// must fall back to the live_stream embed by channel ID in that case.
'use strict';

function extractPlayerResponse(html) {
  const key = 'ytInitialPlayerResponse';
  const i = html.indexOf(key);
  if (i < 0) return null;
  const start = html.indexOf('{', i + key.length);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, j + 1)); } catch (_) { return null; }
      }
    }
  }
  return null;
}

async function resolveYouTubeLive(liveUrl) {
  if (typeof liveUrl !== 'string' || !/^https?:\/\/(www\.)?youtube\.com\//i.test(liveUrl)) {
    return { error: 'not a YouTube URL' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(liveUrl, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!r.ok) return { error: 'YouTube answered HTTP ' + r.status };
    const html = await r.text();
    const pr = extractPlayerResponse(html);
    if (!pr) return { error: 'no player data on the live page' };
    const vd = pr.videoDetails || {};
    const ps = pr.playabilityStatus || {};
    if (ps.status === 'LOGIN_REQUIRED') return { error: 'YouTube wants a login for this live page' };
    if (ps.status !== 'OK') return { error: 'live video not playable (' + (ps.status || 'unknown') + ')' };
    if (!vd.videoId || !/^[A-Za-z0-9_-]{11}$/.test(vd.videoId)) return { error: 'no live video ID found' };
    return { videoId: vd.videoId, title: vd.title || '', isLive: !!vd.isLive };
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { resolveYouTubeLive };
