// IPTV Desktop — renderer: Live TV + Movies/Series + player.
// TV-style: left list, right player, arrow-key navigation throughout.
'use strict';

/* global Hls, parseM3U */
const $ = (id) => document.getElementById(id);
const video = $('video');
const toastEl = $('toast');

let state = { favorites: [], continueWatching: {}, customPlaylist: null, lastTab: 'tv' };
let channels = [];
let filtered = [];
let activeCategory = 'All';
let focusIndex = -1;
let hls = null;
let mpegtsPlayer = null;
let current = null; // {kind:'tv'|'movie', title, ...}
let currentSources = []; // [{label, url}] for quality switching
let ccTrackUrl = null;
let ccOn = false;
let saveTimer = 0;

// ---------- helpers ----------
function fmt(s) {
  if (!isFinite(s) || s == null) return '0:00';
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
}
function toast(msg, ms = 2500) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.add('hidden'), ms);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function saveStateSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.api.saveState(state), 300);
}

// ---------- channels ----------
async function loadChannels() {
  if (state.customPlaylist && state.customPlaylist.channels) {
    channels = state.customPlaylist.channels;
    $('statusBar').textContent = `Playlist: ${state.customPlaylist.path} — ${channels.length} channels`;
  } else {
    const text = await window.api.bundledChannels();
    if (typeof text === 'object' && text.error) {
      $('statusBar').textContent = 'Failed to load bundled channels: ' + text.error;
      channels = [];
    } else {
      channels = parseM3U(text);
      $('statusBar').textContent = `${channels.length} channels loaded`;
    }
  }
  buildCategoryChips();
  applyChannelFilter();
}

// Android maps Drama + Music into General (no own category) — same here.
function normGroup(g) {
  return (g === 'Drama' || g === 'Music') ? 'General' : (g || 'General');
}
function categories() {
  const set = new Set(channels.map((c) => normGroup(c.group)));
  return ['All', '★ Favorites', ...[...set].sort()];
}
function buildCategoryChips() {
  const box = $('catChips');
  box.innerHTML = '';
  for (const cat of categories()) {
    const b = document.createElement('button');
    b.className = 'chip' + (cat === activeCategory ? ' active' : '');
    b.textContent = cat;
    b.onclick = () => { activeCategory = cat; buildCategoryChips(); applyChannelFilter(); };
    box.appendChild(b);
  }
}
function isFav(ch) { return state.favorites.includes(ch.url); }
function applyChannelFilter() {
  const q = $('tvSearch').value.trim().toLowerCase();
  filtered = channels.filter((c) => {
    if (activeCategory === '★ Favorites') { if (!isFav(c)) return false; }
    else if (activeCategory !== 'All' && normGroup(c.group) !== activeCategory) return false;
    if (q && !c.name.toLowerCase().includes(q)) return false;
    return true;
  });
  focusIndex = filtered.length ? 0 : -1;
  const src = state.customPlaylist ? state.customPlaylist.path.split(/[\\/]/).pop() : 'Checked streams';
  $('catalogTitle').textContent = `${src} · ${filtered.length}${q ? ` · "${$('tvSearch').value.trim()}"` : ''}`;
  renderChannelList();
}
function logoHtml(ch) {
  if (ch.logo) {
    return `<img class="logo" src="${esc(ch.logo)}" alt="" loading="lazy" onerror="this.outerHTML='<span class=\\'logo-fallback\\'>${esc(ch.name.slice(0, 1))}</span>'">`;
  }
  return `<span class="logo-fallback">${esc(ch.name.slice(0, 1))}</span>`;
}
function renderChannelList() {
  const list = $('channelList');
  list.innerHTML = '';
  filtered.forEach((ch, i) => {
    const row = document.createElement('button');
    row.className = 'row' + (i === focusIndex ? ' focused' : '');
    row.dataset.idx = i;
    row.innerHTML = `${logoHtml(ch)}<span class="name">${esc(ch.name)}</span>` +
      `<span class="meta">${esc(ch.group || '')}</span>` +
      `<span class="fav" title="Favorite">${isFav(ch) ? '★' : '☆'}</span>`;
    row.onclick = (e) => {
      if (e.target.classList.contains('fav')) { toggleFav(ch); return; }
      focusIndex = i;
      renderChannelList();
      playChannel(ch);
    };
    list.appendChild(row);
  });
  if (!filtered.length) {
    list.innerHTML = '<div style="padding:16px;color:var(--muted)">No channels match.</div>';
  }
}
function toggleFav(ch) {
  const i = state.favorites.indexOf(ch.url);
  if (i >= 0) state.favorites.splice(i, 1);
  else state.favorites.push(ch.url);
  saveStateSoon();
  renderChannelList();
}

// ---------- player ----------
// HLS retry budget (module-level so a pending re-attach can be cancelled
// when the user switches channel). Android parity: the Android player
// recovers from transient fragment failures instead of dying on the
// first one. The counter resets for a new source and whenever playback
// is healthy again (FRAG_BUFFERED / playing), so a later hiccup gets a
// fresh set of retries — and it can never loop forever: at most 3
// recovery attempts per outage, then the error is shown.
let hlsRetries = 0;
let hlsRetryTimer = null;
let hlsRetryUrl = null;
let currentStreamUrl = '';
let mpegtsNoFrameTimer = null;

function hideCodecMsg() { $('codecMsg').classList.add('hidden'); }
function showCodecMsg() { $('codecMsg').classList.remove('hidden'); }
function openInExternalPlayer() {
  if (!currentStreamUrl) return;
  window.api.openExternal(currentStreamUrl);
  toast('External player mein khul raha hai…');
}

function attachSource(url) {
  if (hls) { hls.destroy(); hls = null; }
  if (mpegtsPlayer) { try { mpegtsPlayer.destroy(); } catch (_) {} mpegtsPlayer = null; }
  if (hlsRetryTimer) { clearTimeout(hlsRetryTimer); hlsRetryTimer = null; }
  if (mpegtsNoFrameTimer) { clearTimeout(mpegtsNoFrameTimer); mpegtsNoFrameTimer = null; }
  // New source (different URL) gets a fresh retry budget; a re-attach of
  // the same URL keeps the counter so retries stay bounded.
  if (url !== hlsRetryUrl) hlsRetries = 0;
  hlsRetryUrl = null;
  currentStreamUrl = url;
  hideCodecMsg();
  video.removeAttribute('src');
  video.load();
  const isHls = /\.m3u8(\?|$)/i.test(url);
  const isMp4 = /\.(mp4|webm|mov|mkv)(\?|$)/i.test(url);
  if (isHls && window.Hls && Hls.isSupported()) {
    // Raised retry budgets (hls.js defaults are 1-2): short-segment live
    // streams (Willow TV, Cricket Gold — 6-7s segments, SCTE-35 markers)
    // hit live-edge races that a single failed fragment must not kill.
    hls = new Hls({
      maxBufferLength: 30,
      fragLoadingMaxRetry: 6,
      manifestLoadingMaxRetry: 6,
      levelLoadingMaxRetry: 6,
    });
    hlsRetryUrl = url;
    hls.loadSource(url);
    hls.attachMedia(video);
    // A fragment buffered = playback is healthy again: fresh retries.
    hls.on(Hls.Events.FRAG_BUFFERED, () => { hlsRetries = 0; });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      window.__lastHlsError = data;
      if (!data.fatal) return;
      console.error('hls fatal', data);
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        // Corrupt frame / codec glitch — recover in place, no reload.
        if (hlsRetries < 3) {
          hlsRetries += 1;
          try { hls.recoverMediaError(); } catch (_) {}
          toast('Dobara koshish ho rahi hai…');
        } else {
          toast('Stream error: ' + (data.details || 'playback failed'));
        }
        return;
      }
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        // fragLoadError / levelLoadError / manifestLoadError: retry.
        if (hlsRetries < 3) {
          hlsRetries += 1;
          toast('Dobara koshish ho rahi hai…');
          if (hlsRetries === 1) {
            // First retry: resume loading on the same instance.
            try { hls.startLoad(); } catch (_) {}
          } else {
            // Same error again: full re-attach after a short delay.
            // Guarded by hlsRetryUrl so a channel switch cancels it.
            if (hlsRetryTimer) clearTimeout(hlsRetryTimer);
            hlsRetryTimer = setTimeout(() => {
              hlsRetryTimer = null;
              if (hls && hlsRetryUrl === url) attachSource(url);
            }, 1500);
          }
          return;
        }
        // Retries exhausted — only now show the dead error.
        toast('Stream error: ' + (data.details || 'playback failed'));
        return;
      }
      // Other fatal types (KEY_SYSTEM_ERROR etc.): nothing safe to retry.
      toast('Stream error: ' + (data.details || 'playback failed'));
    });
  } else if (isMp4) {
    video.src = url;
  } else if (window.mpegts && mpegts.isSupported()) {
    // Raw MPEG-TS streams with no playlist (7 channels on IP:port hosts)
    // — ExoPlayer sniffs these on Android; here mpegts.js plays them
    // through MSE. Needs webSecurity off (main process) for the fetch.
    try {
      mpegtsPlayer = mpegts.createPlayer({ type: 'mpegts', isLive: true, url });
      mpegtsPlayer.attachMediaElement(video);
      // MPEG-2 video (Geo Super: mpeg2video 720x576) cannot be decoded by
      // Chromium's MSE at all — no in-browser fix. Detect it from the
      // media-info codec (never a hardcoded channel name) and say so
      // instead of a silent black screen.
      mpegtsPlayer.on(mpegts.Events.MEDIA_INFO, (info) => {
        const codec = String((info && info.videoCodec) || '').toLowerCase();
        if (info && info.hasVideo && codec && !codec.includes('avc')) {
          showCodecMsg();
        }
      });
      mpegtsPlayer.load();
      mpegtsPlayer.play().catch(() => {});
      // Safety net: no video frames within ~8s (a codec the browser
      // can't decode, or a demuxer that never reports a track) — same
      // message instead of a black screen.
      mpegtsNoFrameTimer = setTimeout(() => {
        mpegtsNoFrameTimer = null;
        if (mpegtsPlayer && currentStreamUrl === url && video.videoWidth === 0) {
          showCodecMsg();
        }
      }, 8000);
    } catch (e) {
      console.warn('mpegts failed, falling back to native:', e);
      video.src = url;
    }
  } else {
    video.src = url;
  }
}
function playSource(url, opts) {
  opts = opts || {};
  currentSources = opts.sources || [{ label: 'Auto', url }];
  current = Object.assign({ kind: 'tv' }, opts.meta || {});
  attachSource(url);
  video.muted = false;
  const p = video.play();
  if (p && p.catch) p.catch((e) => { console.warn('play blocked:', e); toast('Press play to start'); });
  $('btnPlay').textContent = '❚❚';
  $('bigPlay').classList.add('hidden');
  if (opts.title) {
    const np = $('nowPlaying');
    np.textContent = '▶ ' + opts.title;
    np.classList.remove('hidden');
  }
  if (opts.resumeAt) {
    video.addEventListener('loadedmetadata', function once() {
      video.removeEventListener('loadedmetadata', once);
      try { video.currentTime = Math.min(opts.resumeAt, Math.max(0, video.duration - 5)); } catch (_) {}
    });
  }
  updateUpNext();
}
function playChannel(ch) {
  // YouTube live pages (3 channels) are not media streams — the Android
  // app plays them via a WebView; here they open in the system browser.
  if (/youtube\.com/i.test(ch.url)) {
    window.api.openExternal(ch.url);
    toast('YouTube live — browser mein khul raha hai: ' + ch.name);
    $('statusBar').textContent = 'YouTube live (browser): ' + ch.name;
    return;
  }
  const idx = channels.indexOf(ch);
  // Live TV carries no movie headers — clear any from a previous title.
  window.api.setMediaHeaders(null);
  playSource(ch.url, {
    title: ch.name,
    meta: { kind: 'tv', channel: ch, channelIndex: idx },
    sources: [{ label: 'Auto', url: ch.url }],
  });
  $('statusBar').textContent = 'Playing: ' + ch.name;
}
function playPause() {
  if (!video.src && !video.currentSrc) return;
  if (video.paused) { video.play(); $('btnPlay').textContent = '❚❚'; $('bigPlay').classList.add('hidden'); }
  else { video.pause(); $('btnPlay').textContent = '▶'; $('bigPlay').classList.remove('hidden'); }
}
function seekBy(sec) {
  if (!isFinite(video.duration)) { toast('Live stream — cannot seek'); return; }
  video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + sec));
}
function setQuality(label) {
  const src = currentSources.find((s) => s.label === label);
  if (!src) return;
  const pos = video.currentTime;
  const wasPaused = video.paused;
  attachSource(src.url);
  video.addEventListener('loadedmetadata', function once() {
    video.removeEventListener('loadedmetadata', once);
    if (isFinite(video.duration)) { try { video.currentTime = pos; } catch (_) {} }
    if (!wasPaused) video.play().catch(() => {});
  });
  toast('Quality: ' + label);
}

// ---------- player bar wiring ----------
video.addEventListener('timeupdate', () => {
  const dur = video.duration;
  if (isFinite(dur) && dur > 0) {
    $('seek').value = Math.round((video.currentTime / dur) * 1000);
    $('timeRead').textContent = fmt(video.currentTime) + ' / ' + fmt(dur);
  } else {
    $('timeRead').textContent = fmt(video.currentTime) + ' / LIVE';
  }
  // Continue Watching save (movies only, every ~5s via throttle)
  if (current && current.kind === 'movie' && current.cwKey) {
    if (!video._lastSave || Date.now() - video._lastSave > 5000) {
      video._lastSave = Date.now();
      state.continueWatching[current.cwKey] = Object.assign({}, state.continueWatching[current.cwKey], {
        position: Math.floor(video.currentTime),
        duration: isFinite(video.duration) ? Math.floor(video.duration) : 0,
        updatedAt: Date.now(),
      });
      saveStateSoon();
    }
  }
});
video.addEventListener('loadedmetadata', () => {
  const dur = video.duration;
  $('timeRead').textContent = isFinite(dur) ? '0:00 / ' + fmt(dur) : '0:00 / LIVE';
});
video.addEventListener('ended', () => {
  $('btnPlay').textContent = '▶';
  $('bigPlay').classList.remove('hidden');
  if (current && current.kind === 'movie' && current.cwKey) {
    delete state.continueWatching[current.cwKey];
    saveStateSoon();
    renderContinueWatching();
  }
  updateUpNext();
});
// Playback actually running = healthy again: fresh HLS retry budget.
// And if real frames exist, any codec warning was a false alarm.
video.addEventListener('playing', () => {
  hlsRetries = 0;
  if (video.videoWidth > 0) hideCodecMsg();
});
video.addEventListener('click', playPause);
$('btnPlay').onclick = playPause;
$('btnBack10').onclick = () => seekBy(-10);
$('btnFwd10').onclick = () => seekBy(10);
$('seek').addEventListener('input', (e) => {
  if (isFinite(video.duration) && video.duration > 0) {
    video.currentTime = (e.target.value / 1000) * video.duration;
  }
});
$('btnFull').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('playerWrap').requestFullscreen().catch(() => toast('Fullscreen not allowed'));
};
$('btnCC').onclick = () => toggleCC();
$('btnQuality').onclick = () => showQualityMenu();
$('btnPrev').onclick = () => stepEpisode(-1);
$('btnNext').onclick = () => stepEpisode(1);
$('btnOpenExternal').onclick = openInExternalPlayer;
// No volume slider in the player bar (Android parity) — volume is on
// the keyboard: + / - adjust, M mutes.

// ---------- hide-the-list toggle (v1.0.2) ----------
// Hides the list panel + divider so the player goes full-width; the
// previous split returns when shown again. Persisted in state.listHidden.
function setListHidden(hidden, save) {
  $('split').classList.toggle('list-hidden', hidden);
  $('showListBtn').classList.toggle('hidden', !hidden);
  $('toggleList').textContent = hidden ? '☰ List dikhao' : '☰ List chhupao';
  state.listHidden = hidden;
  if (hidden === false && typeof state.splitWidth === 'number') {
    applySplitWidth(state.splitWidth, false);
  }
  if (save) saveStateSoon();
}
$('toggleList').onclick = () => setListHidden(!state.listHidden, true);
$('showListBtn').onclick = () => setListHidden(false, true);

// ---------- popups ----------
function closePopup() { $('popupMenu').classList.add('hidden'); }
function showQualityMenu() {
  const menu = $('popupMenu');
  if (!currentSources.length) { toast('No quality options'); return; }
  menu.innerHTML = '<div class="p-title">Quality</div>' + currentSources.map((s) =>
    `<button class="p-item" data-label="${esc(s.label)}">${esc(s.label)}<span class="tick">${video.currentSrc === s.url ? '✓' : ''}</span></button>`).join('');
  menu.classList.remove('hidden');
  menu.querySelectorAll('.p-item').forEach((b) => {
    b.onclick = () => { setQuality(b.dataset.label); closePopup(); };
  });
}
function toggleCC() {
  if (!ccTrackUrl) { toast('No English subtitles for this title'); return; }
  ccOn = !ccOn;
  const track = video.querySelector('track');
  if (track) track.mode = ccOn ? 'showing' : 'hidden';
  $('btnCC').classList.toggle('on', ccOn);
  toast(ccOn ? 'Subtitles: English ON' : 'Subtitles: OFF');
}
async function loadCaptionsFor(args) {
  // args: {streamId, subjectId, detailPath}
  ccOn = false;
  $('btnCC').classList.remove('on');
  const old = video.querySelector('track');
  if (old) old.remove();
  if (ccTrackUrl) { URL.revokeObjectURL(ccTrackUrl); ccTrackUrl = null; }
  try {
    const r = await window.api.mbCaptions(args);
    if (r && r.vtt) {
      ccTrackUrl = URL.createObjectURL(new Blob([r.vtt], { type: 'text/vtt' }));
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = 'English';
      track.srclang = 'en';
      track.src = ccTrackUrl;
      track.mode = 'hidden';
      video.appendChild(track);
      return true;
    }
  } catch (e) { console.warn('captions failed', e); }
  return false;
}

// ---------- movies / series ----------
let currentDetails = null; // details object for open title
let selectedSeason = 1;

function movieCard(item) {
  const title = item.title || item.name || 'Untitled';
  const poster = item.poster || item.image || '';
  const meta = [item.year, item.type].filter(Boolean).join(' · ');
  const card = document.createElement('button');
  card.className = 'card';
  card.innerHTML = (poster ? `<img src="${esc(poster)}" alt="" loading="lazy">` : '<div style="height:170px;background:#000"></div>') +
    `<div class="ctitle">${esc(title)}</div><div class="cmeta">${esc(meta)}</div>`;
  card.onclick = () => openDetails(item.subjectId || item.id);
  return card;
}
async function loadMovieHome() {
  const box = $('movieRails');
  box.innerHTML = '<div style="color:var(--muted);padding:8px">Loading…</div>';
  renderContinueWatching();
  try {
    const feed = await window.api.mbFeed({});
    if (feed && feed.error) { box.innerHTML = `<div style="color:var(--muted);padding:8px">${esc(feed.error)}</div>`; return; }
    box.innerHTML = '';
    (feed.rails || []).forEach((rail) => {
      const div = document.createElement('div');
      div.className = 'rail';
      div.innerHTML = `<div class="rail-title">${esc(rail.title)}</div>`;
      const items = document.createElement('div');
      items.className = 'rail-items';
      (rail.items || []).forEach((it) => items.appendChild(movieCard(it)));
      div.appendChild(items);
      box.appendChild(div);
    });
    if (!box.children.length) box.innerHTML = '<div style="color:var(--muted);padding:8px">No rails available.</div>';
  } catch (e) {
    box.innerHTML = '<div style="color:var(--muted);padding:8px">Failed to load movies: ' + esc(e.message) + '</div>';
  }
}
function renderContinueWatching() {
  const entries = Object.values(state.continueWatching || {})
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const row = $('continueRow');
  const list = $('continueList');
  if (!entries.length) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  list.innerHTML = '';
  entries.forEach((cw) => {
    const card = document.createElement('button');
    card.className = 'card';
    const pct = cw.duration ? Math.round((cw.position / cw.duration) * 100) : 0;
    card.innerHTML = (cw.poster ? `<img src="${esc(cw.poster)}" alt="" loading="lazy">` : '<div style="height:170px;background:#000"></div>') +
      `<div class="ctitle">${esc(cw.title)}</div><div class="cmeta">${fmt(cw.position)} / ${fmt(cw.duration)} · ${pct}%</div>`;
    card.onclick = () => openDetails(cw.subjectId, { resume: cw });
    list.appendChild(card);
  });
}
let searchTimer = 0;
$('movieSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runMovieSearch, 400);
});
async function runMovieSearch() {
  const q = $('movieSearch').value.trim();
  const home = $('moviesHome'), res = $('movieResults');
  if (!q) { home.classList.remove('hidden'); res.classList.add('hidden'); res.innerHTML = ''; return; }
  home.classList.add('hidden');
  res.classList.remove('hidden');
  res.innerHTML = '<div style="padding:16px;color:var(--muted)">Searching…</div>';
  try {
    const r = await window.api.mbSearch(q);
    if (r && r.error) { res.innerHTML = '<div style="padding:16px;color:var(--muted)">' + esc(r.error) + '</div>'; return; }
    res.innerHTML = '';
    (r.results || []).forEach((it) => {
      const row = document.createElement('button');
      row.className = 'row';
      const poster = it.poster || it.image || '';
      row.innerHTML = (poster ? `<img class="poster" src="${esc(poster)}" alt="" loading="lazy">` : '<span class="logo-fallback">▣</span>') +
        `<span class="name">${esc(it.title || it.name || '')}</span><span class="meta">${esc([it.year, it.type].filter(Boolean).join(' · '))}</span>`;
      row.onclick = () => openDetails(it.subjectId || it.id);
      res.appendChild(row);
    });
    if (!res.children.length) res.innerHTML = '<div style="padding:16px;color:var(--muted)">No results.</div>';
  } catch (e) {
    res.innerHTML = '<div style="padding:16px;color:var(--muted)">Search failed: ' + esc(e.message) + '</div>';
  }
}
async function openDetails(subjectId, opts) {
  opts = opts || {};
  const dv = $('detailsView');
  $('moviesHome').classList.add('hidden');
  $('movieResults').classList.add('hidden');
  dv.classList.remove('hidden');
  dv.innerHTML = '<div style="padding:16px;color:var(--muted)">Loading details…</div>';
  try {
    const d = await window.api.mbDetails(subjectId);
    if (d && d.error) { dv.innerHTML = '<div style="padding:16px;color:var(--muted)">' + esc(d.error) + '</div>'; return; }
    currentDetails = d;
    selectedSeason = (d.seasons && d.seasons.length) ? d.seasons[0].number : 1;
    renderDetails(d, opts.resume);
  } catch (e) {
    dv.innerHTML = '<div style="padding:16px;color:var(--muted)">Failed to load details: ' + esc(e.message) + '</div>';
  }
}
function renderDetails(d, resume) {
  const dv = $('detailsView');
  const isSeries = d.type === 'series' || (d.seasons && d.seasons.length > 0);
  const seasons = d.seasons || [];
  const season = seasons.find((s) => s.number === selectedSeason) || seasons[0];
  const eps = (season && season.episodes) || [];
  dv.innerHTML = `
    <div class="d-head">
      ${d.poster ? `<img class="d-poster" src="${esc(d.poster)}" alt="">` : ''}
      <div>
        <h1>${esc(d.title || '')}</h1>
        <div class="d-meta">${esc([d.year, d.type, (d.genres || []).join(', ')].filter(Boolean).join(' · '))}</div>
        <div class="d-meta">${esc(d.meta || '')}</div>
      </div>
    </div>
    ${d.overview ? `<div class="d-desc">${esc(d.overview)}</div>` : ''}
    <div class="actions">
      <button class="btn primary" id="dPlay">▶ Play${isSeries ? ' S' + selectedSeason + ' E1' : ''}</button>
      <button class="btn" id="dFav">${d.isFav ? '★ Favorited' : '☆ Favorite'}</button>
      <button class="btn" id="dBack">← Back</button>
    </div>
    ${isSeries ? `
      <div class="season-row">${seasons.map((s) => `<button class="chip ${s.number === selectedSeason ? 'active' : ''}" data-season="${s.number}">Season ${s.number}</button>`).join('')}</div>
      <div class="ep-grid">${eps.map((ep) => `<button class="ep-btn ${ep.watched ? 'watched' : ''}" data-ep="${ep.number}">${ep.number}</button>`).join('')}</div>
    ` : ''}`;
  dv.querySelector('#dBack').onclick = () => backToMoviesHome();
  dv.querySelector('#dFav').onclick = (e) => {
    d.isFav = !d.isFav;
    e.target.textContent = d.isFav ? '★ Favorited' : '☆ Favorite';
    // Favorites for titles are stored by subjectId in state.favorites (shared with channels by URL).
    const key = 'mb:' + d.subjectId;
    const i = state.favorites.indexOf(key);
    if (d.isFav && i < 0) state.favorites.push(key);
    if (!d.isFav && i >= 0) state.favorites.splice(i, 1);
    saveStateSoon();
  };
  dv.querySelector('#dPlay').onclick = () => {
    if (isSeries) playEpisode(d, selectedSeason, eps.length ? eps[0].number : 1, resume);
    else playEpisode(d, 0, 0, resume);
  };
  dv.querySelectorAll('[data-season]').forEach((b) => {
    b.onclick = () => { selectedSeason = Number(b.dataset.season); renderDetails(d); };
  });
  dv.querySelectorAll('[data-ep]').forEach((b) => {
    b.onclick = () => playEpisode(d, selectedSeason, Number(b.dataset.ep));
  });
}
function backToMoviesHome() {
  $('detailsView').classList.add('hidden');
  $('movieResults').classList.add('hidden');
  $('moviesHome').classList.remove('hidden');
  $('movieSearch').value = '';
  currentDetails = null;
}
async function playEpisode(d, season, episode, resume) {
  const isSeries = d.type === 'series' || (d.seasons && d.seasons.length > 0);
  const label = isSeries ? `${d.title} S${season} E${episode}` : d.title;
  $('statusBar').textContent = 'Loading: ' + label + '…';
  try {
    const r = await window.api.mbPlay({ subjectId: d.subjectId, se: season, ep: episode, detailPath: d.detailPath });
    if (!r || r.error || !(r.sources && r.sources.length)) {
      toast('No playable streams found');
      $('statusBar').textContent = 'No streams for ' + label;
      return;
    }
    const cwKey = 'mb:' + d.subjectId + ':' + season + ':' + episode;
    const resumeAt = resume ? resume.position : (state.continueWatching[cwKey] ? state.continueWatching[cwKey].position : 0);
    state.continueWatching[cwKey] = {
      subjectId: d.subjectId, title: label, poster: d.poster || '',
      position: resumeAt || 0, duration: 0, updatedAt: Date.now(),
    };
    saveStateSoon();
    renderContinueWatching();
    const best = r.sources[r.sources.length - 1];
    // File-request headers for this title (Referer/Cookie) — the video
    // element cannot set them itself; main injects them for this host.
    try {
      await window.api.setMediaHeaders({
        host: new URL(best.url).host,
        referer: r.referer || '',
        cookie: r.cookie || '',
      });
    } catch (_) {}
    await loadCaptionsFor({ streamId: r.streamId, subjectId: d.subjectId, detailPath: d.detailPath });
    playSource(best.url, {
      title: label,
      resumeAt: resumeAt || 0,
      sources: r.sources,
      meta: {
        kind: 'movie', subject: d, se: season, ep: episode,
        cwKey, detailPath: d.detailPath, streamId: r.streamId,
      },
    });
    $('statusBar').textContent = 'Playing: ' + label;
  } catch (e) {
    toast('Playback failed: ' + e.message);
    $('statusBar').textContent = 'Playback failed';
  }
}
async function stepEpisode(delta) {
  if (!current || current.kind !== 'movie' || !current.subject) return;
  const d = current.subject;
  const isSeries = d.type === 'series' || (d.seasons && d.seasons.length > 0);
  if (!isSeries) { toast('No previous/next for movies'); return; }
  const season = current.se;
  const eps = ((d.seasons || []).find((s) => s.number === season) || {}).episodes || [];
  const nums = eps.map((e) => e.number).sort((a, b) => a - b);
  const i = nums.indexOf(current.ep);
  const next = nums[i + delta];
  if (next == null) { toast(delta > 0 ? 'Last episode' : 'First episode'); return; }
  playEpisode(d, season, next);
}
function updateUpNext() {
  const box = $('upNext');
  if (!current || current.kind !== 'movie' || !current.subject) { box.classList.add('hidden'); return; }
  const d = current.subject;
  const isSeries = d.type === 'series' || (d.seasons && d.seasons.length > 0);
  if (!isSeries) { box.classList.add('hidden'); return; }
  const season = current.se;
  const eps = ((d.seasons || []).find((s) => s.number === season) || {}).episodes || [];
  const nums = eps.map((e) => e.number).sort((a, b) => a - b);
  const next = nums[nums.indexOf(current.ep) + 1];
  if (next == null) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = `<span>Up next: S${season} E${next}</span><button class="btn primary" id="upNextBtn">Play next</button>`;
  $('upNextBtn').onclick = () => playEpisode(d, season, next);
}

// ---------- tabs ----------
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('tvView').classList.toggle('hidden', tab !== 'tv');
  $('moviesView').classList.toggle('hidden', tab !== 'movies');
  state.lastTab = tab;
  saveStateSoon();
  if (tab === 'movies' && !$('movieRails').children.length) loadMovieHome();
}
document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => switchTab(t.dataset.tab); });
$('tvSearch').addEventListener('input', applyChannelFilter);
$('openM3U').onclick = async () => {
  const r = await window.api.openM3U();
  if (!r) return;
  if (r.error) { toast('Could not open playlist: ' + r.error); return; }
  const list = parseM3U(r.text);
  if (!list.length) { toast('No channels found in that file'); return; }
  state.customPlaylist = { path: r.path, channels: list };
  saveStateSoon();
  activeCategory = 'All';
  await loadChannels();
  toast(`Loaded ${list.length} channels`);
};

// ---------- clock ----------
function tickClock() {
  const d = new Date();
  $('clock').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
setInterval(tickClock, 10000);

// ---------- keyboard navigation ----------
function visibleRows() {
  const active = document.querySelector('.tab.active').dataset.tab;
  if (active === 'tv') return [...$('channelList').querySelectorAll('.row')];
  if (!$('detailsView').classList.contains('hidden')) return [...$('detailsView').querySelectorAll('.ep-btn, #dPlay')];
  if (!$('movieResults').classList.contains('hidden')) return [...$('movieResults').querySelectorAll('.row')];
  return [...document.querySelectorAll('.card')];
}
function moveFocus(delta) {
  const rows = visibleRows();
  if (!rows.length) return;
  focusIndex = Math.max(0, Math.min(rows.length - 1, (focusIndex < 0 ? 0 : focusIndex + delta)));
  rows.forEach((r, i) => r.classList.toggle('focused', i === focusIndex));
  rows[focusIndex].scrollIntoView({ block: 'nearest' });
}
document.addEventListener('keydown', (e) => {
  const inInput = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
  if (e.key === 'Escape') {
    if (!$('popupMenu').classList.contains('hidden')) { closePopup(); return; }
    if (currentDetails) { backToMoviesHome(); return; }
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    return;
  }
  if (inInput) {
    if (e.key === 'ArrowDown') { e.preventDefault(); document.activeElement.blur(); focusIndex = 0; moveFocus(0); }
    if (e.key === 'Enter') { document.activeElement.blur(); }
    return;
  }
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); moveFocus(1); break;
    case 'ArrowUp': e.preventDefault(); moveFocus(-1); break;
    case 'ArrowRight': if (document.activeElement === video || document.activeElement === document.body) { seekBy(10); } break;
    case 'ArrowLeft': if (document.activeElement === video || document.activeElement === document.body) { seekBy(-10); } break;
    case 'Enter': {
      const rows = visibleRows();
      if (rows[focusIndex]) { e.preventDefault(); rows[focusIndex].click(); }
      break;
    }
    case ' ': e.preventDefault(); playPause(); break;
    case 'f': case 'F': $('btnFull').click(); break;
    case 'c': case 'C': toggleCC(); break;
    case 'q': case 'Q': showQualityMenu(); break;
    case '+': case '=': video.volume = Math.min(1, video.volume + 0.1); video.muted = false; toast('Volume: ' + Math.round(video.volume * 100) + '%'); break;
    case '-': case '_': video.volume = Math.max(0, video.volume - 0.1); toast('Volume: ' + Math.round(video.volume * 100) + '%'); break;
    case 'm': case 'M': video.muted = !video.muted; toast(video.muted ? 'Muted' : 'Sound on'); break;
    case 'l': case 'L': setListHidden(!state.listHidden, true); break;
  }
});
document.addEventListener('click', (e) => {
  if (!$('popupMenu').classList.contains('hidden') && !$('popupMenu').contains(e.target) && e.target.id !== 'btnQuality') closePopup();
});

// ---------- in-app updater (mirrors Android UpdateChecker/UpdateFlow) ----------
// Silent check runs once a day from the main process; manual check from
// the header button. Nothing downloads without pressing Download, and a
// running .exe cannot replace itself — the new portable exe is downloaded
// + verified, then the user runs it after closing the app.
let pendingUpdate = null;
let downloadedFile = null;

function showUpdateDialog(update) {
  pendingUpdate = update;
  downloadedFile = null;
  $('updText').textContent = `Naya version aa gaya hai (${update.tag}). Download kar ke install karna hai?`;
  const notes = $('updNotes');
  if (update.notes && update.notes.trim()) {
    notes.textContent = update.notes.trim().slice(0, 2000);
    notes.classList.remove('hidden');
  } else notes.classList.add('hidden');
  $('updProgress').classList.add('hidden');
  $('updDone').classList.add('hidden');
  $('updDownload').classList.remove('hidden');
  $('updLater').classList.remove('hidden');
  $('updShowFile').classList.add('hidden');
  $('updClose').classList.add('hidden');
  $('updateDialog').classList.remove('hidden');
  $('updDownload').focus();
}
function hideUpdateDialog() { $('updateDialog').classList.add('hidden'); pendingUpdate = null; }

$('updLater').onclick = hideUpdateDialog;
$('updClose').onclick = hideUpdateDialog;
$('updShowFile').onclick = () => { if (downloadedFile) window.api.showDownloadedFile(downloadedFile); };
$('updDownload').onclick = async () => {
  if (!pendingUpdate) return;
  $('updDownload').classList.add('hidden');
  $('updLater').classList.add('hidden');
  $('updProgress').classList.remove('hidden');
  $('updBar').value = 0;
  $('updPct').textContent = 'Download ho raha hai… 0%';
  try {
    const r = await window.api.downloadUpdate(pendingUpdate);
    downloadedFile = r.filePath;
    $('updProgress').classList.add('hidden');
    const done = $('updDone');
    done.textContent = 'Download ho gaya hai. App band kar ke nayi file chalain — purani file aap khud delete kar sakte hain.';
    done.classList.remove('hidden');
    $('updShowFile').classList.remove('hidden');
    $('updClose').classList.remove('hidden');
  } catch (e) {
    $('updProgress').classList.add('hidden');
    toast('Download fail ho gaya: ' + e.message);
    hideUpdateDialog();
  }
};
window.api.onUpdateProgress((pct) => {
  $('updBar').value = pct;
  $('updPct').textContent = `Download ho raha hai… ${pct}%`;
});
window.api.onUpdateAvailable((update) => showUpdateDialog(update));
$('checkUpdate').onclick = async () => {
  toast('Update check ho raha hai…');
  try {
    const r = await window.api.checkUpdate();
    if (r && r.available) showUpdateDialog(r);
    else if (r && r.reason === 'up-to-date') toast('App up to date hai.');
    else if (r && r.reason === 'not-found') toast('Update check nahi ho saka — release abhi publish nahi hui.');
    else toast('Update check nahi ho saka — internet check karein.');
  } catch (e) {
    toast('Update check nahi ho saka — internet check karein.');
  }
};

// ---------- draggable divider: list vs player (v1.0.1) ----------
// The left pane width (px) is persisted in state.splitWidth and restored
// on next launch. List min 280px, player min 320px — neither pane can
// collapse to nothing. Mouse drag + keyboard (Left/Right arrows,
// Shift = bigger step) both work; other keys and focus are untouched.
const SPLIT_MIN_LEFT = 280;
const SPLIT_MIN_RIGHT = 320;
const SPLIT_STEP = 20;
function splitMaxLeft() {
  const split = $('split');
  if (!split) return 800;
  // #split horizontal padding is 12px each side; the splitter is 14px.
  return Math.max(SPLIT_MIN_LEFT, split.clientWidth - 24 - 14 - SPLIT_MIN_RIGHT);
}
function applySplitWidth(px, save) {
  const w = Math.round(Math.min(Math.max(px, SPLIT_MIN_LEFT), splitMaxLeft()));
  $('leftPane').style.flex = `0 0 ${w}px`;
  state.splitWidth = w;
  if (save) saveStateSoon();
  return w;
}
function initSplitter() {
  const splitter = $('splitter');
  const left = $('leftPane');
  if (!splitter || !left) return;
  // Restore the saved split (default is the 45% from CSS).
  if (typeof state.splitWidth === 'number' && state.splitWidth > 0) {
    applySplitWidth(state.splitWidth, false);
  }
  let dragging = false, dragStartX = 0, dragStartW = 0;
  splitter.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    dragging = true;
    dragStartX = e.clientX;
    dragStartW = left.getBoundingClientRect().width;
    try { splitter.setPointerCapture(e.pointerId); } catch (_) { /* pointer capture is best-effort */ }
    splitter.classList.add('dragging');
    document.body.classList.add('split-dragging');
    e.preventDefault();
  });
  splitter.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    applySplitWidth(dragStartW + (e.clientX - dragStartX), false);
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove('dragging');
    document.body.classList.remove('split-dragging');
    saveStateSoon();
  };
  splitter.addEventListener('pointerup', endDrag);
  splitter.addEventListener('pointercancel', endDrag);
  // Keyboard: arrows resize the split; Shift = 100px step.
  splitter.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 100 : SPLIT_STEP;
    const cur = left.getBoundingClientRect().width;
    if (e.key === 'ArrowLeft') { applySplitWidth(cur - step, true); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { applySplitWidth(cur + step, true); e.preventDefault(); }
  });
  // Keep the saved split inside the window when it is resized.
  window.addEventListener('resize', () => {
    if (typeof state.splitWidth === 'number') applySplitWidth(state.splitWidth, false);
  });
}

// ---------- boot ----------
(async function boot() {
  tickClock();
  const info = await window.api.paths();
  const ver = await window.api.installedVersion();
  $('version').textContent = ver.label;
  state = Object.assign(state, await window.api.loadState());
  initSplitter();
  if (state.listHidden) setListHidden(true, false);
  await loadChannels();
  if (state.lastTab === 'movies') switchTab('movies');
  // Auto-play first channel so the TV opens onto something playing.
  // Dev-only: IPTV_AUTOPLAY=<substring> plays the first matching channel.
  let first = filtered[0];
  const env = window.api.env ? window.api.env() : {};
  if (env.autoplay) {
    const needle = env.autoplay.toLowerCase();
    first = filtered.find((c) => c.name.toLowerCase().includes(needle)) || first;
  }
  if (first) playChannel(first);
})();
