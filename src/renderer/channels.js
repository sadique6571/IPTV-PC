// IPTV Desktop — M3U playlist parser (shared by Live TV).
// Parses #EXTINF lines: attributes (tvg-logo, group-title, tvg-country,
// tvg-language) + display name, followed by the stream URL line.
'use strict';

function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXTINF')) continue;
    // Name is after the last comma of the EXTINF line.
    const comma = line.lastIndexOf(',');
    const name = (comma >= 0 ? line.slice(comma + 1) : '').trim();
    const attrs = {};
    const attrRe = /([\w-]+)="([^"]*)"/g;
    let m;
    while ((m = attrRe.exec(line)) !== null) attrs[m[1]] = m[2];
    // Next non-empty, non-comment line is the URL.
    let url = '';
    for (let j = i + 1; j < lines.length; j++) {
      const u = lines[j].trim();
      if (!u) continue;
      if (u.startsWith('#')) continue;
      url = u;
      break;
    }
    if (!name || !url) continue;
    channels.push({
      name,
      url,
      logo: attrs['tvg-logo'] || '',
      group: attrs['group-title'] || 'General',
      country: attrs['tvg-country'] || '',
      language: attrs['tvg-language'] || '',
      ...(attrs['tvg-type'] === 'unavailable' && { unavailable: true }),
      ...(attrs['tvg-type'] === 'web' && { openInBrowser: true }),
    });
  }
  return channels;
}

function parseYouTubeSource(input) {
  let url;
  try { url = new URL(input); } catch (_) { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const short = url.hostname === 'youtu.be';
  if (!short && !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return null;

  const parts = url.pathname.split('/').filter(Boolean);
  let videoId = url.searchParams.get('v');
  if (short) videoId = parts[0];
  if (['embed', 'shorts', 'live'].includes(parts[0])) videoId = parts[1];
  const player = 'https://www.youtube.com/embed/';
  if (/^[A-Za-z0-9_-]{11}$/.test(videoId || '')) {
    return { embedUrl: player + videoId + '?autoplay=1&rel=0' };
  }
  const playlist = url.searchParams.get('list');
  if (/^[A-Za-z0-9_-]{10,80}$/.test(playlist || '')) {
    return { embedUrl: player + 'videoseries?list=' + playlist + '&autoplay=1&rel=0' };
  }
  if (parts.length > 1 && parts.at(-1) === 'live') {
    // Normalize the host for the main-process live resolver.
    return { liveUrl: new URL(url.pathname, 'https://www.youtube.com').href };
  }
  return {};
}

if (typeof module !== 'undefined') module.exports = { parseM3U, parseYouTubeSource };
