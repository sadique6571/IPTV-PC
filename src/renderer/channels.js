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
    });
  }
  return channels;
}

if (typeof module !== 'undefined') module.exports = { parseM3U };
