// IPTV Desktop — renderer: Live TV + Movies/Series + player.
// TV-style: left list, right player, arrow-key navigation throughout.
'use strict';

/* global Hls, parseM3U, parseYouTubeSource */
const $ = (id) => document.getElementById(id);
const video = $('video');
const toastEl = $('toast');

let state = { favorites: [], continueWatching: {}, customPlaylist: null, lastTab: 'tv', channelOrder: null };
let channels = [];
let defaultChannels = []; // M3U/file order — never reordered; "Default order" restores this
let filtered = [];
let dragUrl = null; // URL of the row being dragged (null when not dragging)
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
  defaultChannels = channels.slice();
  channels = applySavedOrder(channels);
  buildCategoryChips();
  applyChannelFilter();
}

// ---------- channel order (v1.0.3) ----------
// The user's channel order lives in state.channelOrder (array of URLs,
// saved in state.json). The M3U is only the source of channels: saved
// order wins, channels missing from it (new in the list) go at the end
// in their original relative order, stale URLs are dropped.
function applySavedOrder(list) {
  const order = state.channelOrder;
  if (!Array.isArray(order) || !order.length) return list.slice();
  const byUrl = new Map(list.map((c) => [c.url, c]));
  const out = [];
  for (const url of order) {
    const ch = byUrl.get(url);
    if (ch) { out.push(ch); byUrl.delete(url); }
  }
  for (const c of list) if (byUrl.has(c.url)) out.push(c);
  return out;
}
function saveChannelOrder() {
  state.channelOrder = channels.map((c) => c.url);
  saveStateSoon();
}
// Move a channel inside the FULL channels list (not the filtered view).
function moveChannel(fromIdx, toIdx) {
  if (fromIdx < 0 || fromIdx >= channels.length) return null;
  toIdx = Math.max(0, Math.min(channels.length - 1, toIdx));
  if (fromIdx === toIdx) return channels[fromIdx];
  const [ch] = channels.splice(fromIdx, 1);
  channels.splice(toIdx, 0, ch);
  saveChannelOrder();
  return ch;
}
// Move the focused row one step (keyboard/remote: Shift+ArrowUp/Down,
// or the Arrange menu). The move applies to the FULL channel list, but
// it jumps past the next/previous VISIBLE row — so under a category or
// search filter one press always visibly moves the row one step (moving
// to the adjacent full-list slot could swap with a hidden channel and
// look like nothing happened).
function moveFocusedChannel(delta) {
  if (document.querySelector('.tab.active').dataset.tab !== 'tv') return;
  if (focusIndex < 0 || !filtered[focusIndex]) { toast('Pehle koi channel select karein'); return; }
  const ch = filtered[focusIndex];
  const neighbour = delta > 0 ? filtered[focusIndex + 1] : filtered[focusIndex - 1];
  if (!neighbour) { toast(delta > 0 ? 'Ye pehle se sab se neeche hai' : 'Ye pehle se sab se upar hai'); return; }
  // moveChannel(from, to) splices the channel out and inserts at `to`:
  // moving down, inserting at the neighbour's index lands after it
  // (it shifted down by one on removal); moving up, it lands before it.
  const moved = moveChannel(channels.indexOf(ch), channels.indexOf(neighbour));
  if (!moved) return;
  applyChannelFilter(moved.url);
  toast(`${moved.name} ${delta < 0 ? 'upar' : 'neeche'} move ho gaya`);
}
function applyArrange(act) {
  if (act === 'pk') {
    // Stable sort: PK first, then IN, then the rest — the original
    // relative order inside each group is kept (Array.sort is stable).
    const rank = (c) => (c.country === 'PK' ? 0 : c.country === 'IN' ? 1 : 2);
    channels.sort((a, b) => rank(a) - rank(b));
    saveChannelOrder();
    applyChannelFilter();
    toast('Pakistani channels pehle');
  } else if (act === 'az') {
    channels.sort((a, b) => a.name.localeCompare(b.name));
    saveChannelOrder();
    applyChannelFilter();
    toast('A–Z order');
  } else if (act === 'def') {
    state.channelOrder = null;
    channels = defaultChannels.slice();
    applyChannelFilter();
    saveStateSoon();
    toast('Default order (M3U)');
  } else if (act === 'up') moveFocusedChannel(-1);
  else if (act === 'down') moveFocusedChannel(1);
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
function applyChannelFilter(keepFocusUrl) {
  const q = $('tvSearch').value.trim().toLowerCase();
  filtered = channels.filter((c) => {
    if (activeCategory === '★ Favorites') { if (!isFav(c)) return false; }
    else if (activeCategory !== 'All' && normGroup(c.group) !== activeCategory) return false;
    if (q && !c.name.toLowerCase().includes(q)) return false;
    return true;
  });
  // After a manual move/sort, keep the focus on the moved channel
  // instead of jumping back to the top of the list.
  focusIndex = keepFocusUrl
    ? Math.max(0, filtered.findIndex((c) => c.url === keepFocusUrl))
    : (filtered.length ? 0 : -1);
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
    // Drag-and-drop reorder (mouse): drag a row onto another row to
    // move it there; the drop position (before/after) follows the
    // mouse's half of the target row. The move applies to the FULL
    // channel list, so it works under a category/search filter too.
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      dragUrl = ch.url;
      e.dataTransfer.setData('text/plain', ch.url);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      dragUrl = null;
      list.querySelectorAll('.row').forEach((r) => r.classList.remove('dragging', 'drop-before', 'drop-after'));
    });
    // dragenter MUST be cancelled for the row to become a drop target
    // at all — without this, dragover never fires on other rows and
    // the drop event never happens (verified with a CDP drag probe).
    row.addEventListener('dragenter', (e) => {
      if (!dragUrl || dragUrl === ch.url) return;
      e.preventDefault();
    });
    row.addEventListener('dragover', (e) => {
      if (!dragUrl || dragUrl === ch.url) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      row.classList.toggle('drop-before', before);
      row.classList.toggle('drop-after', !before);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragUrl || dragUrl === ch.url) return;
      const dragged = channels.find((c) => c.url === dragUrl);
      if (!dragged) return;
      const rect = row.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      const from = channels.indexOf(dragged);
      let to = channels.indexOf(ch);
      if (!before) to += 1;
      if (from < to) to -= 1;
      moveChannel(from, to);
      applyChannelFilter(dragged.url);
      toast(`${dragged.name} move ho gaya`);
    });
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
let liveBuffer = null;
let liveFragment = null;
let suppressedProgress = '';
let mediaBytes = 0;
let lastNetworkBytes = 0;
let lastNetworkTime = performance.now();
let mpegtsNoFrameTimer = null;
// MPEG-2 transcode state (v1.0.3): when a raw TS stream's video codec
// is not H.264, the main process re-encodes it to H.264/AAC HLS on
// localhost and the playlist below is what actually gets attached.
// transcodeOriginalUrl stays the real stream URL (the VLC button opens
// that, never the localhost playlist). transcodeAttemptedFor stops a
// failed transcode from retrying in a loop for the same playback.
let transcodePlaylistUrl = '';
let transcodeOriginalUrl = '';
let transcodeAttemptedFor = '';
let transcodeWatchdog = null;

// MP4 no-frames watchdog (v1.0.4): movies/series play as direct MP4s,
// and some MovieBox MP4s are HEVC/H.265, which Chromium cannot decode
// at all. That shows as no picture — audio may still play (Windows) or
// the element may error outright (error 4, readyState 0). When no
// frames appear within ~8s, try the next source, else transcode.
// mp4TriedUrls stops the fallback from retrying a dead URL in a loop;
// mp4NoFrameRounds gives a slow-but-healthy load one extra window.
let mp4NoFrameTimer = null;
let mp4TriedUrls = [];
let mp4NoFrameRounds = 0;

function hideCodecMsg() { $('codecMsg').classList.add('hidden'); }
function showCodecMsg(kind) {
  // The fallback message must name the right problem: an MPEG-2 live
  // channel vs an HEVC (or otherwise undecodable) movie file.
  const title = $('codecTitle');
  const text = $('codecText');
  if (kind === 'movie') {
    if (title) title.textContent = 'Ye movie is format mein nahi chal sakti';
    if (text) text.textContent = 'Is movie ki video (HEVC) browser player mein nahi chal sakti — convert bhi nahi ho saka. Isko external player (jaise VLC) mein kholein.';
  } else {
    if (title) title.textContent = 'Ye channel MPEG-2 video hai';
    if (text) text.textContent = 'Browser player mein iski picture nahi chal sakti — isko external player (jaise VLC) mein kholein.';
  }
  $('codecMsg').classList.remove('hidden');
}
function openInExternalPlayer() {
  if (!currentStreamUrl) return;
  window.api.openExternal(currentStreamUrl);
  toast('External player mein khul raha hai…');
}

function attachSource(url, options = {}) {
  hideYouTubeEmbed();
  if (hls) { hls.destroy(); hls = null; }
  liveFragment = null;
  if (mpegtsPlayer) { try { mpegtsPlayer.destroy(); } catch (_) {} mpegtsPlayer = null; }
  if (hlsRetryTimer) { clearTimeout(hlsRetryTimer); hlsRetryTimer = null; }
  if (mpegtsNoFrameTimer) { clearTimeout(mpegtsNoFrameTimer); mpegtsNoFrameTimer = null; }
  if (mp4NoFrameTimer) { clearTimeout(mp4NoFrameTimer); mp4NoFrameTimer = null; }
  if (transcodeWatchdog) { clearTimeout(transcodeWatchdog); transcodeWatchdog = null; }
  // A re-attach of our own transcode playlist (hls.js retry) keeps the
  // transcode alive; ANY other source stops it — ffmpeg must never
  // keep running after a channel change.
  const isTranscodePlaylist = !!transcodePlaylistUrl && url === transcodePlaylistUrl;
  if (isTranscodePlaylist) {
    currentStreamUrl = transcodeOriginalUrl;
    window.__transcode = { active: true, original: transcodeOriginalUrl, playlist: transcodePlaylistUrl };
  } else {
    if (transcodePlaylistUrl) { window.api.stopTranscode().catch(() => {}); }
    transcodePlaylistUrl = '';
    transcodeOriginalUrl = '';
    window.__transcode = null;
    currentStreamUrl = url;
  }
  // New source (different URL) gets a fresh retry budget; a re-attach of
  // the same URL keeps the counter so retries stay bounded.
  if (url !== hlsRetryUrl) hlsRetries = 0;
  hlsRetryUrl = null;
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
      ...(options.buffered ? { startPosition: options.offset, initialLiveManifestSize: 1 } : {}),
      fragLoadingMaxRetry: 6,
      manifestLoadingMaxRetry: 6,
      levelLoadingMaxRetry: 6,
    });
    hlsRetryUrl = url;
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(Hls.Events.LEVEL_UPDATED, updateRecordButton);
    hls.on(Hls.Events.FRAG_CHANGED, (_event, data) => { liveFragment = data.frag; });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => updateAudioControl());
    hls.on(Hls.Events.FRAG_LOADED, (_event, { frag }) => {
      if (!options.buffered && !isTranscodePlaylist) mediaBytes += frag.stats?.loaded || 0;
    });
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
          if (options.buffered || hlsRetries === 1) {
            // First retry: resume loading on the same instance.
            try { hls.startLoad(options.buffered ? video.currentTime || options.offset : -1); } catch (_) {}
          } else {
            // Same error again: full re-attach after a short delay.
            // Guarded by hlsRetryUrl so a channel switch cancels it.
            if (hlsRetryTimer) clearTimeout(hlsRetryTimer);
            hlsRetryTimer = setTimeout(() => {
              hlsRetryTimer = null;
              if (hls && hlsRetryUrl === url && !video.paused) attachSource(url);
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
  } else if (isMp4 || options.local) {
    video.src = url;
    // Movies/series only: a direct MP4 the browser cannot decode
    // (HEVC) shows no picture and never errors on Windows — watch for
    // frames and fall back (next source, then transcode).
    if (current && current.kind === 'movie') armMp4NoFrameWatchdog(url);
  } else if (window.mpegts && mpegts.isSupported()) {
    // Raw MPEG-TS streams with no playlist (7 channels on IP:port hosts)
    // — ExoPlayer sniffs these on Android; here mpegts.js plays them
    // through MSE. Needs webSecurity off (main process) for the fetch.
    try {
      mpegtsPlayer = mpegts.createPlayer({ type: 'mpegts', isLive: true, url });
      mpegtsPlayer.attachMediaElement(video);
      // MPEG-2 video (Geo Super: mpeg2video 720x576 interlaced) cannot
      // be decoded by Chromium's MSE at all. Detect it from the
      // media-info codec (never a hardcoded channel name) and transcode
      // it in the main process (ffmpeg -> H.264/AAC HLS on localhost)
      // instead of a silent black screen; the VLC message is only the
      // fallback if the transcode fails.
      mpegtsPlayer.on(mpegts.Events.MEDIA_INFO, (info) => {
        const codec = String((info && info.videoCodec) || '').toLowerCase();
        if (info && info.hasVideo && codec && !codec.includes('avc')) {
          handleUnplayableSource(url, 'ts');
        }
      });
      mpegtsPlayer.load();
      mpegtsPlayer.play().catch(() => {});
      // Safety net: no video frames within ~8s (a codec the browser
      // can't decode, or a demuxer that never reports a track) — same
      // transcode attempt, then the VLC message if that fails too.
      mpegtsNoFrameTimer = setTimeout(() => {
        mpegtsNoFrameTimer = null;
        if (mpegtsPlayer && currentStreamUrl === url && video.videoWidth === 0) {
          handleUnplayableSource(url, 'ts');
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
// A stream the browser can't decode: transcode it in the main process
// and play the localhost HLS playlist. kind 'ts' = an MPEG-2 live
// channel; kind 'movie' = a direct MP4 (usually HEVC) that showed no
// frames. If the transcode fails — or still shows no frames 10s after
// attaching — fall back to the honest message + VLC button, never a
// silent black screen.
async function handleUnplayableSource(url, kind) {
  if (transcodeAttemptedFor === url) { showCodecMsg(kind); return; }
  transcodeAttemptedFor = url;
  if (kind === 'movie') {
    toast('Ye format app mein seedha nahi chalta — convert ho raha hai…');
    $('statusBar').textContent = 'Convert ho raha hai…';
  } else {
    toast('MPEG-2 hai — app mein chalane ke liye convert ho raha hai…');
    $('statusBar').textContent = 'MPEG-2 convert ho raha hai…';
  }
  let res;
  try {
    res = await window.api.startTranscode(url);
  } catch (e) {
    res = { ok: false, error: String(e) };
  }
  // The user moved on while ffmpeg was starting — don't hijack the new
  // source; stop the transcode that is no longer needed.
  if (currentStreamUrl !== url || transcodeAttemptedFor !== url) {
    if (res && res.ok) window.api.stopTranscode().catch(() => {});
    return;
  }
  if (!res || !res.ok) {
    console.warn('transcode failed:', res && res.error);
    showCodecMsg(kind);
    if (kind === 'movie') $('statusBar').textContent = 'Convert nahi ho saka' + (current && current.playLabel ? ': ' + current.playLabel : '');
    toast('Convert nahi ho saka — VLC mein kholein');
    return;
  }
  transcodePlaylistUrl = res.playlistUrl;
  transcodeOriginalUrl = url;
  attachSource(res.playlistUrl);
  // Play unconditionally: the pause state here was caused by the
  // failed source (an HEVC load errors with the element paused), not
  // by the user — the fixed stream must start, as the TS path always did.
  video.play().catch(() => {});
  if (kind === 'movie' && current && current.playLabel) {
    $('statusBar').textContent = 'Playing: ' + current.playLabel + ' (convert karke)';
  }
  transcodeWatchdog = setTimeout(() => {
    transcodeWatchdog = null;
    if (video.videoWidth === 0) {
      window.api.stopTranscode().catch(() => {});
      transcodePlaylistUrl = '';
      transcodeOriginalUrl = '';
      window.__transcode = null;
      showCodecMsg(kind);
      toast('Convert nahi ho saka — VLC mein kholein');
    }
  }, 10000);
}
// MP4 no-frames watchdog (v1.0.4): arm a timer when a movie MP4 is
// attached; if no frames exist when it fires, fall back. Two rounds
// max (16s): a load with no metadata, no error and no progress yet
// gets one extra window instead of killing a slow-but-healthy movie.
// A transcode already starting for this playback blocks the watchdog
// (its guard is transcodeAttemptedFor) so a slow ffmpeg start is
// never hijacked by a source switch.
function armMp4NoFrameWatchdog(url) {
  if (mp4NoFrameTimer) { clearTimeout(mp4NoFrameTimer); mp4NoFrameTimer = null; }
  mp4NoFrameRounds = 0;
  const check = () => {
    mp4NoFrameTimer = null;
    if (currentStreamUrl !== url) return;
    if (video.videoWidth > 0) return;
    if (transcodeAttemptedFor) return;
    // Still loading with no error and no progress at all: one more
    // window, then treat it as unplayable.
    if (!video.error && video.readyState < 1 && video.currentTime === 0 && mp4NoFrameRounds < 1) {
      mp4NoFrameRounds += 1;
      mp4NoFrameTimer = setTimeout(check, 8000);
      return;
    }
    handleMp4NoFrames(url);
  };
  mp4NoFrameTimer = setTimeout(check, 8000);
}
// Next untried movie source, highest quality first (currentSources is
// ascending, so walk it backwards), skipping the failed URL and any
// URL already tried for this playback.
function nextUntriedMovieSource(failedUrl) {
  for (let i = currentSources.length - 1; i >= 0; i -= 1) {
    const s = currentSources[i];
    if (s.url !== failedUrl && !mp4TriedUrls.includes(s.url)) return s;
  }
  return null;
}
// A movie MP4 showed no frames (HEVC or another undecodable codec):
// try the next quality — a lower one may be H.264 — and only when no
// source plays, transcode the BEST (highest-quality) source via ffmpeg.
function handleMp4NoFrames(url) {
  if (transcodeAttemptedFor) return;
  mp4TriedUrls.push(url);
  const next = nextUntriedMovieSource(url);
  if (next) {
    toast('Ye quality nahi chal rahi — doosri quality try ho rahi hai…');
    const pos = video.currentTime;
    attachSource(next.url);
    video.addEventListener('loadedmetadata', function once() {
      video.removeEventListener('loadedmetadata', once);
      if (isFinite(video.duration) && pos > 0) { try { video.currentTime = pos; } catch (_) {} }
    });
    // Play unconditionally (see handleUnplayableSource): the pause was
    // caused by the failed source, not by the user.
    video.play().catch(() => {});
    return;
  }
  // All sources failed direct: transcode the best source, not the
  // last-tried (lowest) one. Re-attach it first so the transcode's
  // "user moved on" guard (currentStreamUrl === url) holds for it;
  // the transcodeAttemptedFor guard above stops the re-armed watchdog
  // and the error fast-path from hijacking the transcode while ffmpeg
  // starts.
  const best = currentSources[currentSources.length - 1];
  const target = best ? best.url : url;
  if (target !== url) attachSource(target);
  handleUnplayableSource(target, 'movie');
}
function playSource(url, opts) {
  opts = opts || {};
  cancelLiveBuffer();
  // A fresh explicit play gets a fresh transcode attempt (a transient
  // ffmpeg failure must not stay sticky for the channel).
  transcodeAttemptedFor = '';
  mp4TriedUrls = [];
  currentSources = opts.sources || [{ label: 'Auto', url }];
  current = Object.assign({ kind: 'tv' }, opts.meta || {});
  if (opts.title) current.playLabel = opts.title;
  attachSource(url, { local: current.kind === 'download' });
  video.muted = false;
  const p = video.play();
  if (p && p.catch) p.catch((e) => { console.warn('play blocked:', e); toast('Press play to start'); });
  syncPlayerControls();
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
  moviePlayRequest++;
  const web = ch.unavailable || ch.openInBrowser ? {} : parseYouTubeSource(ch.url);
  if (web) {
    playWebChannel(ch, web);
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
// ---------- YouTube playback ----------
// Channel IDs are stable (unlike live video IDs, which change on every
// stream restart), so they are the fallback anchor. Resolved once from
// each channel's public page; the live VIDEO id is resolved fresh at
// play time (see src/youtube.js).
const YT_CHANNEL_IDS = {
  '92newshdtv': 'UCk7Kj4QiPYN4vbe5yT8femw',
  'city41': 'UCcmpeVbSSQlZRvHfdC-CRwg',
  'expressnewspkofficial': 'UCF-uOc4AYA9uyH7ZFUTZEIg',
};
let ytActive = false;
let ytSelection = 0;
function showYouTubeEmbed(embedUrl, ch) {
  const frame = $('ytFrame');
  frame.src = embedUrl;
  frame.classList.remove('hidden');
  $('playerWrap').classList.add('yt-mode');
  $('ytOpenBrowser').classList.toggle('hidden', ch.group === 'Sports');
  ytActive = true;
  current = { kind: 'tv', channel: ch, channelIndex: channels.indexOf(ch) };
  currentSources = [];
  hideCodecMsg();
  const np = $('nowPlaying');
  np.textContent = '▶ ' + ch.name;
  np.classList.remove('hidden');
  $('statusBar').textContent = 'YouTube: ' + ch.name;
  updateUpNext();
}
function hideYouTubeEmbed() {
  ytSelection += 1;
  if (!ytActive) return;
  ytActive = false;
  $('ytOpenBrowser').classList.add('hidden');
  const frame = $('ytFrame');
  frame.src = 'about:blank';
  frame.classList.add('hidden');
  $('playerWrap').classList.remove('yt-mode');
}
async function playWebChannel(ch, source) {
  cancelLiveBuffer();
  hideYouTubeEmbed();
  const selection = ytSelection;
  // Stop whatever was playing (normal stream or another embed).
  if (hls) { hls.destroy(); hls = null; }
  if (mpegtsPlayer) { try { mpegtsPlayer.destroy(); } catch (_) {} mpegtsPlayer = null; }
  if (transcodePlaylistUrl) { window.api.stopTranscode().catch(() => {}); transcodePlaylistUrl = ''; transcodeOriginalUrl = ''; }
  // The old <video> keeps playing (audio!) behind the embed unless stopped.
  try { video.pause(); } catch (_) {}
  video.removeAttribute('src');
  video.load();
  current = null;
  currentSources = [];
  $('nowPlaying').classList.add('hidden');
  hideCodecMsg();
  updateUpNext();
  window.api.setMediaHeaders(null);
  if (source.embedUrl) {
    showYouTubeEmbed(source.embedUrl, ch);
    return;
  }
  if (source.liveUrl) {
    $('statusBar').textContent = 'YouTube live load ho raha hai: ' + ch.name;
    let videoId;
    try {
      const result = await window.api.resolveYouTubeLive(source.liveUrl);
      videoId = result?.isLive ? result.videoId : null;
    } catch (error) { console.warn('YouTube live:', error.message); }
    if (selection !== ytSelection) return;
    const handle = new URL(source.liveUrl).pathname.match(/^\/@([^/]+)/)?.[1].toLowerCase();
    const channelId = YT_CHANNEL_IDS[handle];
    const embed = videoId
      ? `https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0`
      : channelId && `https://www.youtube.com/embed/live_stream?channel=${channelId}&autoplay=1`;
    if (embed) {
      showYouTubeEmbed(embed, ch);
      return;
    }
  }
  if (ch.unavailable || ch.group === 'Sports') {
    const message = ch.unavailable ? 'In-app live feed unavailable' : 'Live broadcast unavailable right now';
    $('statusBar').textContent = ch.name + ' - ' + message;
    toast(message);
    return;
  }
  window.api.openExternal(ch.url);
  $('statusBar').textContent = 'Browser: ' + ch.name;
}
function cancelLiveBuffer() {
  if (!liveBuffer) return;
  liveBuffer = null;
  $('btnLive').classList.add('hidden');
  updateRecordButton();
  window.api.stopLiveBuffer().catch(() => {});
}

function liveAnchor() {
  const details = hls?.latestLevelDetails;
  const frag = liveFragment || details?.fragments.find(fragment =>
    video.currentTime >= fragment.start && video.currentTime < fragment.start + fragment.duration);
  if (!details?.live || !frag || !Number.isSafeInteger(frag.sn) || !details.url || transcodePlaylistUrl) return null;
  return { sequence: frag.sn, date: frag.programDateTime, offset: Math.max(0, video.currentTime - frag.start) };
}

let savingRecording = false;
function updateRecordButton() {
  const button = $('btnRecord');
  const available = current?.kind === 'tv' && !ytActive && (liveBuffer || liveAnchor());
  button.classList.toggle('hidden', !available);
  button.disabled = savingRecording || !!liveBuffer && !liveBuffer.result;
  button.textContent = savingRecording ? 'Saving…' : liveBuffer ? 'Save recording' : 'Record';
}

function startLiveBuffer(recording = false) {
  const anchor = liveAnchor();
  if (!anchor) return;
  const audioTrack = hls.audioTracks?.[hls.audioTrack];
  const sourcePlayer = hls;
  const session = {
    channel: current.channel, result: null, bytes: 0, wantsPlayback: false, active: false,
    recording, pausedAt: null,
  };
  liveBuffer = session;
  $('btnLive').classList.toggle('hidden', recording);
  $('statusBar').textContent = recording ? 'Starting recording…' : 'Paused · saving live TV…';
  if (!recording) sourcePlayer.stopLoad();
  updateRecordButton();
  const failed = () => {
    if (liveBuffer !== session) return;
    cancelLiveBuffer();
    if (!recording) sourcePlayer.startLoad(video.currentTime);
    $('statusBar').textContent = recording ? 'Recording unavailable for this stream' : 'Paused · live window only';
    if (session.wantsPlayback) resumeVideo();
  };
  window.api.startLiveBuffer({
    video: hls.latestLevelDetails.url,
    audio: audioTrack?.url || '',
    anchor: anchor.sequence,
    offset: anchor.offset,
  }).then(result => {
    if (liveBuffer !== session) return;
    if (!result?.url) { failed(); return; }
    session.result = result;
    $('statusBar').textContent = recording ? 'Recording ' + session.channel.name :
      result.exact ? 'Paused · live TV is being saved' : 'Pause point expired · earliest saved video is ready';
    updateRecordButton();
    if (session.wantsPlayback) resumeLiveBuffer(session);
  }).catch(failed);
}

function resumeVideo() {
  video.play().catch(() => toast('Press play to start'));
}

async function resumeLiveBuffer(session) {
  if (!session.result) {
    session.wantsPlayback = true;
    toast('Preparing the live buffer…');
    return;
  }
  if (session.startingPlayback) return;
  session.startingPlayback = true;
  const result = session.pausedAt
    ? await window.api.liveBufferPosition(session.pausedAt).catch(() => null)
    : session.result;
  if (liveBuffer !== session) return;
  session.startingPlayback = false;
  if (!result?.url) { resumeVideo(); return; }
  session.active = true;
  $('btnLive').classList.remove('hidden');
  attachSource(result.url, { buffered: true, offset: result.offset });
  resumeVideo();
  $('statusBar').textContent = 'Playing saved live TV: ' + session.channel.name;
}

function playPause() {
  // A YouTube embed has its own controls — the app's play/pause must
  // never touch the (stopped) <video> behind it.
  if (ytActive) return;
  if (!video.src && !video.currentSrc) return;
  if (video.paused) {
    if (liveBuffer && !liveBuffer.active && (!liveBuffer.recording || liveBuffer.pausedAt)) resumeLiveBuffer(liveBuffer);
    else resumeVideo();
  } else {
    if (liveBuffer?.recording && !liveBuffer.active) liveBuffer.pausedAt = liveAnchor();
    video.pause();
    if (current?.kind === 'tv' && !liveBuffer) startLiveBuffer();
  }
}
function seekWindow() {
  if (Number.isFinite(video.duration) && video.duration > 0) return [0, video.duration];
  const ranges = video.seekable;
  return ranges.length ? [ranges.start(0), ranges.end(ranges.length - 1)] : null;
}
function seekBy(sec) {
  const range = seekWindow();
  if (!range) { toast('This stream is not seekable yet'); return; }
  video.currentTime = Math.max(range[0], Math.min(range[1] - 0.05, video.currentTime + sec));
}
function setQuality(label) {
  const src = currentSources.find((s) => s.label === label);
  if (!src) return;
  const pos = video.currentTime;
  const wasPaused = video.paused;
  // A manual quality switch gets a fresh unplayable attempt: the new
  // URL may be HEVC even if the old one played (or vice versa).
  transcodeAttemptedFor = '';
  mp4TriedUrls = [];
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
  const range = seekWindow();
  if (range && range[1] > range[0]) {
    const percent = Math.max(0, Math.min(1, (video.currentTime - range[0]) / (range[1] - range[0])));
    $('seek').value = Math.round(percent * 1000);
    $('seek').style.setProperty('--progress', (percent * 100) + '%');
    $('timeRead').textContent = fmt(Math.max(0, video.currentTime - range[0])) + ' / ' + fmt(range[1] - range[0]);
  } else {
    $('timeRead').textContent = fmt(video.currentTime) + ' / LIVE';
  }
  // Continue Watching save (movies only, every ~5s via throttle)
  if (current && current.kind === 'movie' && current.cwKey && current.cwKey !== suppressedProgress) {
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
  syncPlayerControls();
  hlsRetries = 0;
  if (video.videoWidth > 0) {
    hideCodecMsg();
    if (transcodeWatchdog) { clearTimeout(transcodeWatchdog); transcodeWatchdog = null; }
    if (mp4NoFrameTimer) { clearTimeout(mp4NoFrameTimer); mp4NoFrameTimer = null; }
    if (transcodePlaylistUrl && current && current.channel) {
      $('statusBar').textContent = 'Playing: ' + current.channel.name + ' (MPEG-2 → H.264)';
    }
  }
});
// Undecodable MP4 (HEVC) can error immediately (MEDIA_ERR_SRC_NOT_SUPPORTED,
// code 4) with no frames: fast-path the same fallback the watchdog runs,
// instead of waiting out the 8s timer. Network errors (code 2) do NOT
// fast-path — the watchdog's slow-load guard handles those. The
// currentSrc check keeps a stale error from the empty-src load() in
// attachSource from firing on a URL that never actually loaded.
video.addEventListener('error', () => {
  if (video.error && current?.kind === 'download' && video.currentSrc === currentStreamUrl) {
    $('statusBar').textContent = 'This saved video could not be played. Check the file or try another video format.';
    toast('Could not play saved video');
  }
  if (!video.error || video.error.code !== 4) return;
  if (!current || current.kind !== 'movie') return;
  if (!currentStreamUrl || !/\.(mp4|webm|mov|mkv)(\?|$)/i.test(currentStreamUrl)) return;
  if (video.currentSrc !== currentStreamUrl) return;
  if (video.videoWidth > 0) return;
  if (transcodeAttemptedFor) return;
  if (mp4NoFrameTimer) { clearTimeout(mp4NoFrameTimer); mp4NoFrameTimer = null; }
  handleMp4NoFrames(currentStreamUrl);
});
video.addEventListener('play', syncPlayerControls);
video.addEventListener('pause', syncPlayerControls);
video.addEventListener('loadeddata', updatePiPButton);
video.addEventListener('emptied', updatePiPButton);
video.addEventListener('enterpictureinpicture', updatePiPButton);
video.addEventListener('leavepictureinpicture', updatePiPButton);
video.addEventListener('waiting', showPlayerBar);
video.addEventListener('click', () => {
  if (document.fullscreenElement && !video.paused) showPlayerBar();
  else playPause();
});
$('btnPlay').onclick = playPause;
// YouTube embed escape hatch (yt-mode only): if the embed shows a black
// player / YouTube error on the user's PC, one tap opens the channel in
// the system browser instead — never a dead click.
$('ytOpenBrowser').onclick = () => {
  if (current && current.channel && current.channel.url) window.api.openExternal(current.channel.url);
};
$('btnBack10').onclick = () => seekBy(-10);
$('btnFwd10').onclick = () => seekBy(10);
$('seek').addEventListener('input', (e) => {
  const range = seekWindow();
  if (range) video.currentTime = Math.min(range[1] - 0.05, range[0] + (e.target.value / 1000) * (range[1] - range[0]));
});
let hideBarTimer;
function showPlayerBar() {
  clearTimeout(hideBarTimer);
  $('playerWrap').classList.remove('controls-hidden');
  if (document.fullscreenElement && !video.paused && !video.ended) {
    hideBarTimer = setTimeout(() => {
      if (!$('popupMenu').classList.contains('hidden') || $('seek').matches(':active') || video.readyState < 3) return;
      $('playerWrap').classList.add('controls-hidden');
    }, 3000);
  }
}
function syncPlayerControls() {
  $('btnPlay').textContent = video.paused ? '▶' : '❚❚';
  $('bigPlay').classList.toggle('hidden', !video.paused || !current || ytActive);
  const savedVideo = current?.kind === 'download';
  for (const id of ['btnPrev', 'btnNext', 'btnCC', 'btnQuality']) {
    $(id).classList.toggle('hidden', savedVideo);
  }
  updateAudioControl();
  updatePiPButton();
  updateRecordButton();
  showPlayerBar();
}
document.addEventListener('fullscreenchange', showPlayerBar);
$('playerWrap').addEventListener('pointermove', showPlayerBar);
$('playerWrap').addEventListener('pointerup', showPlayerBar);
$('playerWrap').addEventListener('focusin', showPlayerBar);
$('btnLive').onclick = () => { if (liveBuffer) playChannel(liveBuffer.channel); };
$('btnFull').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('playerWrap').requestFullscreen().catch(() => toast('Fullscreen not allowed'));
};
function updatePiPButton() {
  const button = $('btnPiP');
  const active = document.pictureInPictureElement === video;
  button.disabled = !active && (!document.pictureInPictureEnabled || ytActive || !video.videoWidth);
  button.classList.toggle('on', active);
  button.setAttribute('aria-pressed', String(active));
}
async function togglePiP() {
  try {
    if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
    else if (!$('btnPiP').disabled) {
      await video.requestPictureInPicture();
      if (document.fullscreenElement) await document.exitFullscreen();
    }
  } catch { toast('Picture-in-Picture is unavailable for this video'); }
  updatePiPButton();
}
$('btnPiP').onclick = togglePiP;
$('btnRecord').onclick = async () => {
  if (!liveBuffer) { startLiveBuffer(true); return; }
  const session = liveBuffer;
  if (savingRecording || !session.result) return;
  savingRecording = true;
  updateRecordButton();
  try {
    const saved = await window.api.saveRecording(session.channel.name);
    if (!saved.canceled) {
      toast('Recording saved · ' + saved.name);
      if (liveBuffer === session && session.recording && !session.active && !video.paused) {
        cancelLiveBuffer();
        $('statusBar').textContent = 'Playing: ' + session.channel.name;
      }
      if (!$('downloadsView').classList.contains('hidden')) renderDownloads();
    }
  } catch {
    toast('Could not save recording. Check the destination and try again.');
  } finally {
    savingRecording = false;
    updateRecordButton();
  }
};
$('btnCC').onclick = () => toggleCC();
$('btnQuality').onclick = () => showQualityMenu();
$('btnPrev').onclick = () => stepPlayback(-1);
$('btnNext').onclick = () => stepPlayback(1);
$('btnAudio').onclick = showAudioMenu;
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

// ---------- custom title bar (frameless window, v1.0.3) ----------
// Header is the drag region; these buttons are the window controls.
$('winMin').onclick = () => window.api.minimizeWindow();
$('winMax').onclick = () => window.api.toggleMaximizeWindow();
$('winClose').onclick = () => window.api.closeWindow();
// Maximise/restore icon follows the real window state.
const setMaxIcon = (maximized) => {
  document.documentElement.classList.toggle('maximized', maximized);
  $('winMax').textContent = maximized ? '❐' : '▢';
  $('winMax').title = maximized ? 'Restore' : 'Maximise';
};
window.api.onMaximizeChange(setMaxIcon);
window.api.isMaximized().then(setMaxIcon).catch(() => {});
// Double-click on the header (not on a button/input) toggles maximise.
$('topbar').addEventListener('dblclick', (e) => {
  if (e.target.closest('button, input')) return;
  window.api.toggleMaximizeWindow();
});

// ---------- popups ----------
function closePopup() { $('popupMenu').classList.add('hidden'); showPlayerBar(); }
function updateAudioControl() {
  const hasTracks = (hls?.audioTracks?.length || 0) > 1;
  const hasDubs = current?.kind === 'movie' && current.subject?.dubs?.length;
  $('btnAudio').classList.toggle('hidden', !hasTracks && !hasDubs);
}
function showAudioMenu() {
  const trackPlayer = hls;
  const playback = current;
  const tracks = trackPlayer?.audioTracks || [];
  const dubs = playback?.subject?.dubs || [];
  const menu = $('popupMenu');
  menu.innerHTML = '<div class="p-title">Audio</div>';
  function addAudioOption(label, action) {
    const button = document.createElement('button');
    button.className = 'p-item';
    button.textContent = label;
    button.onclick = () => { closePopup(); action(); };
    menu.append(button);
  }
  if (tracks.length > 1) tracks.forEach((track, index) =>
    addAudioOption(track.name || track.lang || 'Track ' + (index + 1), () => {
      if (hls === trackPlayer) trackPlayer.audioTrack = index;
    }));
  for (const dub of dubs) addAudioOption(dub.language || dub.label, async () => {
    try {
      const details = await window.api.mbDetails(dub.subjectId);
      if (current !== playback) return;
      if (details?.error || !details?.subjectId) { toast('Audio version unavailable'); return; }
      playEpisode(details, playback.se, playback.ep, { position: video.currentTime });
    } catch { toast('Could not load audio version'); }
  });
  if (menu.children.length > 1) menu.classList.remove('hidden');
}
function closeArrangeMenu() { $('arrangeMenu').classList.add('hidden'); }
function showArrangeMenu() {
  const menu = $('arrangeMenu');
  const focused = (focusIndex >= 0 && filtered[focusIndex]) ? filtered[focusIndex] : null;
  const items = [
    { id: 'pk', label: 'Pakistani pehle' },
    { id: 'az', label: 'A–Z' },
    { id: 'def', label: 'Default order' },
  ];
  menu.innerHTML = '<div class="p-title">Arrange channels</div>' +
    items.map((it) => `<button class="p-item" data-act="${it.id}">${esc(it.label)}</button>`).join('') +
    '<div class="p-title">' + (focused ? esc(focused.name) + ' — move karein' : 'Move: pehle koi channel select karein') + '</div>' +
    '<button class="p-item" data-act="up">↑ Upar move karein</button>' +
    '<button class="p-item" data-act="down">↓ Neeche move karein</button>';
  menu.classList.remove('hidden');
  menu.querySelectorAll('.p-item').forEach((b) => {
    b.onclick = () => { applyArrange(b.dataset.act); closeArrangeMenu(); };
  });
}
$('arrangeBtn').onclick = () => {
  if ($('arrangeMenu').classList.contains('hidden')) showArrangeMenu();
  else closeArrangeMenu();
};
// Live TV quality: the stream's real resolution, plus the HLS
// variants when the playlist offers more than one level.
function resolutionLabel(w, h) {
  if (!w || !h) return '';
  return h + 'p';
}
function tvQualityItems() {
  const items = [];
  const isTranscode = !!transcodePlaylistUrl;
  if (hls && Array.isArray(hls.levels) && hls.levels.length > 1) {
    const auto = hls.autoLevelEnabled;
    items.push({ key: 'auto', label: 'Auto', tick: auto });
    hls.levels.forEach((lv, i) => {
      const label = resolutionLabel(lv.width, lv.height) +
        (lv.bitrate ? ` · ${(lv.bitrate / 1e6).toFixed(1)} Mbps` : '');
      items.push({ key: String(i), label, tick: !auto && hls.nextLevel === i });
    });
  } else if (video.videoWidth > 0) {
    // Single-variant stream (raw MPEG-TS, single-level HLS, or the
    // ffmpeg transcode output): one honest entry, not fake choices.
    const label = resolutionLabel(video.videoWidth, video.videoHeight) +
      (isTranscode ? ' — MPEG-2 → H.264' : ' — live');
    items.push({ key: 'current', label, tick: true });
  } else {
    items.push({ key: 'current', label: isTranscode ? 'MPEG-2 → H.264 — live' : 'Live — Auto', tick: false });
  }
  return items;
}
function setTvLevel(index) {
  if (!hls) return;
  if (index < 0) {
    hls.nextLevel = -1;
    window.__qualityLevel = { level: -1, height: null, width: null };
    toast('Quality: Auto');
  } else {
    const lv = hls.levels && hls.levels[index];
    if (!lv) { toast('Quality option nahi hai'); return; }
    hls.nextLevel = index;
    window.__qualityLevel = { level: index, height: lv.height, width: lv.width };
    toast('Quality: ' + resolutionLabel(lv.width, lv.height));
  }
}
function showQualityMenu() {
  if (current?.kind === 'download') return;
  const menu = $('popupMenu');
  // A YouTube embed has its own quality control (the ⚙ icon in the
  // YouTube player) — the app's quality list does not apply to it.
  if (ytActive) { toast('Quality YouTube player mein badlein (⚙ icon)'); return; }
  // Live TV: real stream quality (resolution + HLS levels) — the movie
  // path below (currentSources switching) is unchanged.
  if (current && current.kind === 'tv') {
    const items = tvQualityItems();
    menu.innerHTML = '<div class="p-title">Quality</div>' + items.map((it) =>
      `<button class="p-item" data-key="${esc(it.key)}">${esc(it.label)}<span class="tick">${it.tick ? '✓' : ''}</span></button>`).join('');
    menu.classList.remove('hidden');
    menu.querySelectorAll('.p-item').forEach((b) => {
      b.onclick = () => {
        const key = b.dataset.key;
        if (key === 'auto') setTvLevel(-1);
        else if (key !== 'current') setTvLevel(Number(key));
        closePopup();
      };
    });
    return;
  }
  if (!currentSources.length) { toast('No quality options'); return; }
  menu.innerHTML = '<div class="p-title">Quality</div>' + currentSources.map((s) =>
    `<button class="p-item" data-label="${esc(s.label)}">${esc(s.label)}<span class="tick">${video.currentSrc === s.url ? '✓' : ''}</span></button>`).join('');
  menu.classList.remove('hidden');
  menu.querySelectorAll('.p-item').forEach((b) => {
    b.onclick = () => { setQuality(b.dataset.label); closePopup(); };
  });
}
function toggleCC() {
  if (ytActive) { toast('Subtitles YouTube player mein (CC button)'); return; }
  if (!ccTrackUrl) { toast('No English subtitles for this title'); return; }
  ccOn = !ccOn;
  const track = video.querySelector('track');
  if (track) track.mode = ccOn ? 'showing' : 'hidden';
  $('btnCC').classList.toggle('on', ccOn);
  toast(ccOn ? 'Subtitles: English ON' : 'Subtitles: OFF');
}
function clearMovieCaptions() {
  ccOn = false;
  $('btnCC').classList.remove('on');
  const old = video.querySelector('track');
  if (old) old.remove();
  if (ccTrackUrl) { URL.revokeObjectURL(ccTrackUrl); ccTrackUrl = null; }
}
async function loadCaptionsFor(args) {
  clearMovieCaptions();
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
let knownMovies = [];
async function loadMovieHome() {
  const box = $('movieRails');
  box.innerHTML = '<div style="color:var(--muted);padding:8px">Loading…</div>';
  renderContinueWatching();
  try {
    const feed = await window.api.mbFeed({});
    if (feed && feed.error) { box.innerHTML = `<div style="color:var(--muted);padding:8px">${esc(feed.error)}</div>`; return; }
    knownMovies = (feed.rails || []).flatMap(rail => rail.items || []);
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
  const entries = Object.entries(state.continueWatching || {})
    .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const row = $('continueRow');
  const list = $('continueList');
  if (!entries.length) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  list.innerHTML = '';
  entries.forEach(([key, cw]) => {
    const card = document.createElement('button');
    card.className = 'card';
    const pct = cw.duration ? Math.round((cw.position / cw.duration) * 100) : 0;
    card.innerHTML = (cw.poster ? `<img src="${esc(cw.poster)}" alt="" loading="lazy">` : '<div style="height:170px;background:#000"></div>') +
      `<div class="ctitle">${esc(cw.title)}</div><div class="cmeta">${fmt(cw.position)} / ${fmt(cw.duration)} · ${pct}%</div>`;
    card.onclick = () => openDetails(cw.subjectId, { resume: cw });
    const entry = document.createElement('div');
    entry.className = 'continue-entry';
    const remove = document.createElement('button');
    remove.className = 'continue-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', 'Remove ' + cw.title + ' from Continue Watching');
    const askRemove = () => {
      const dialog = $('removeContinue');
      $('removeContinueTitle').textContent = cw.title;
      dialog.returnValue = 'cancel';
      dialog.onclose = () => {
        if (dialog.returnValue !== 'remove') return;
        if (current?.cwKey === key) suppressedProgress = key;
        delete state.continueWatching[key];
        saveStateSoon();
        renderContinueWatching();
      };
      dialog.showModal();
    };
    remove.onclick = askRemove;
    card.oncontextmenu = event => { event.preventDefault(); askRemove(); };
    entry.append(card, remove);
    list.appendChild(entry);
  });
}
let searchTimer = 0;
let searchRequest = 0;
$('movieSearch').addEventListener('input', () => {
  toggleDownloads(false);
  searchRequest++;
  $('detailsView').classList.add('hidden');
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runMovieSearch, 400);
});
async function runMovieSearch() {
  const request = ++searchRequest;
  const q = $('movieSearch').value.trim();
  const home = $('moviesHome'), res = $('movieResults');
  if (!q) { home.classList.remove('hidden'); res.classList.add('hidden'); res.innerHTML = ''; return; }
  home.classList.add('hidden');
  res.classList.remove('hidden');
  res.innerHTML = '<div style="padding:16px;color:var(--muted)">Searching…</div>';
  try {
    const recent = Object.values(state.continueWatching || {}).map(item => ({
      subjectId: item.subjectId,
      title: item.title.replace(/\s+S\d+\s+E\d+$/i, ''),
      poster: item.poster,
      isHindi: /[[(]hindi(?: dubbed)?[\])]/i.test(item.title),
      type: /\sS\d+\s+E\d+$/i.test(item.title) ? 'series' : 'movie',
    }));
    const r = await window.api.mbSearch(q, [...knownMovies, ...recent]);
    if (request !== searchRequest) return;
    if (r && r.error) { res.innerHTML = '<div style="padding:16px;color:var(--muted)">' + esc(r.error) + '</div>'; return; }
    res.innerHTML = '';
    (r.results || []).forEach((it) => {
      const row = document.createElement('button');
      row.className = 'row';
      const poster = it.poster || it.image || '';
      row.innerHTML = (poster ? `<img class="poster" src="${esc(poster)}" alt="" loading="lazy">` : '<span class="logo-fallback">▣</span>') +
        `<span class="name">${esc(it.title || it.name || '')}</span>${it.isHindi ? '<span class="badge">Hindi</span>' : ''}<span class="meta">${esc([it.year, it.type].filter(Boolean).join(' · '))}</span>`;
      row.onclick = () => openDetails(it.subjectId || it.id);
      res.appendChild(row);
    });
    if (!res.children.length) res.innerHTML = '<div style="padding:16px;color:var(--muted)">No results.</div>';
  } catch (e) {
    if (request !== searchRequest) return;
    res.innerHTML = '<div style="padding:16px;color:var(--muted)">Search failed: ' + esc(e.message) + '</div>';
  }
}
async function openDetails(subjectId, opts) {
  searchRequest++;
  const request = ++detailsRequest;
  currentDetails = null;
  opts = opts || {};
  const dv = $('detailsView');
  $('moviesHome').classList.add('hidden');
  $('movieResults').classList.add('hidden');
  dv.classList.remove('hidden');
  dv.innerHTML = '<div style="padding:16px;color:var(--muted)">Loading details…</div>';
  try {
    const d = await window.api.mbDetails(subjectId);
    if (request !== detailsRequest) return;
    if (d && d.error) { showDetailsError(d.error, subjectId, opts); return; }
    currentDetails = d;
    d.isFav = state.favorites.includes('mb:' + d.subjectId);
    selectedSeason = (d.seasons && d.seasons.length) ? d.seasons[0].number : 1;
    renderDetails(d, opts.resume);
  } catch (e) {
    if (request === detailsRequest) showDetailsError(e.message, subjectId, opts);
  }
}
let detailsRequest = 0;
function showDetailsError(message, subjectId, opts) {
  const dv = $('detailsView');
  dv.innerHTML = `<div class="d-desc">${esc(message)}</div><div class="actions">
    <button class="btn primary" id="dRetry">Retry</button><button class="btn" id="dBack">Back</button></div>`;
  $('dRetry').onclick = () => openDetails(subjectId, opts);
  $('dBack').onclick = backToMoviesHome;
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
    <div class="actions">
      <button class="btn primary" id="dPlay">${resume ? 'Resume' : 'Play'}${isSeries && !resume ? ' S' + selectedSeason + ' E' + (eps[0]?.number || 1) : ''}</button>
      ${isSeries ? '' : '<button class="btn" id="dDownload">Download</button>'}
      <button class="btn" id="dFav">${d.isFav ? '★ Favorited' : '☆ Favorite'}</button>
      <button class="btn" id="dBack">← Back</button>
    </div>
    ${d.overview ? `<details class="d-summary"><summary>Synopsis</summary><div class="d-desc">${esc(d.overview)}</div></details>` : ''}
    ${isSeries ? `
      <div class="season-row">${seasons.map((s) => `<button class="chip ${s.number === selectedSeason ? 'active' : ''}" data-season="${s.number}">Season ${s.number}</button>`).join('')}</div>
      <div class="ep-grid">${eps.map((ep) => `<button class="ep-btn ${ep.watched ? 'watched' : ''}" data-ep="${ep.number}">${ep.number}</button>`).join('')}</div>
    ` : ''}`;
  dv.querySelector('#dBack').onclick = () => backToMoviesHome();
  if (!isSeries) dv.querySelector('#dDownload').onclick = () => openMovieDownload(d);
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
    if (isSeries) {
      const match = /\sS(\d+)\sE(\d+)$/i.exec(resume?.title || '');
      playEpisode(d, match ? Number(match[1]) : selectedSeason, match ? Number(match[2]) : eps[0]?.number || 1, resume);
    }
    else playEpisode(d, 0, 0, resume);
  };
  dv.querySelectorAll('[data-season]').forEach((b) => {
    b.onclick = () => { selectedSeason = Number(b.dataset.season); renderDetails(d); };
  });
  dv.querySelectorAll('[data-ep]').forEach((b) => {
    b.onclick = () => playEpisode(d, selectedSeason, Number(b.dataset.ep));
  });
}
const movieDialog = $('movieDownload');
let movieDialogSession = 0;
let movieSaving = false;

function closeMovieDownload() {
  if (movieSaving) {
    $('movieDownloadClose').disabled = true;
    window.api.cancelMovie();
    return;
  }
  movieDialogSession++;
  movieDialog.close();
}
$('movieDownloadClose').onclick = closeMovieDownload;
movieDialog.oncancel = event => { event.preventDefault(); closeMovieDownload(); };
window.api.onMovieProgress(({ received, total }) => {
  const bar = $('movieDownloadBar');
  bar.classList.remove('hidden');
  if (total > 0) {
    bar.max = total;
    bar.value = received;
  } else bar.removeAttribute('value');
  $('movieDownloadStatus').textContent = total
    ? 'Downloading… ' + Math.floor(received * 100 / total) + '%'
    : 'Downloading… ' + (received / 1048576).toFixed(1) + ' MB';
});

async function openMovieDownload(movie) {
  const session = ++movieDialogSession;
  const options = $('downloadQualities'), status = $('movieDownloadStatus'), close = $('movieDownloadClose');
  options.replaceChildren();
  $('downloadTitle').textContent = movie.title;
  $('movieDownloadBar').classList.add('hidden');
  close.disabled = false;
  close.textContent = 'Cancel';
  status.textContent = 'Looking for available qualities…';
  movieDialog.showModal();
  try {
    const labels = await window.api.movieQualities({ subjectId: movie.subjectId, se: 0, ep: 0, detailPath: movie.detailPath });
    if (session !== movieDialogSession) return;
    status.textContent = labels.length ? 'Select download quality' : 'No downloadable quality is available for this movie.';
    labels.forEach((label, index) => {
      const button = document.createElement('button');
      button.className = 'btn';
      button.textContent = label;
      button.onclick = async () => {
        if (movieSaving) return;
        movieSaving = true;
        options.replaceChildren();
        status.textContent = 'Choose where to save the movie…';
        try {
          const result = await window.api.saveMovie(index, movie.title);
          status.textContent = result.canceled ? 'Download canceled.' : 'Saved · ' + result.name;
          if (!result.canceled && result.librarySaved) {
            const open = document.createElement('button');
            open.type = 'button';
            open.className = 'btn';
            open.textContent = 'Open Downloads';
            open.onclick = () => {
              closeMovieDownload();
              toggleDownloads(true);
            };
            options.append(open);
          } else if (!result.canceled) {
            status.textContent += ' · Use Add video in Downloads to list this file.';
          }
        } catch {
          status.textContent = 'Download failed. Check your connection and save location, then try again.';
        } finally {
          movieSaving = false;
          close.disabled = false;
          close.textContent = 'Close';
          $('movieDownloadBar').classList.add('hidden');
          close.focus();
        }
      };
      options.append(button);
    });
    options.firstElementChild?.focus();
  } catch {
    if (session === movieDialogSession) status.textContent = 'Could not load download qualities. Please try again.';
  }
}

let downloadsRequest = 0;
function toggleDownloads(open) {
  $('moviesView').classList.toggle('downloads-open', open);
  $('downloadsView').classList.toggle('hidden', !open);
  $('showDownloads').setAttribute('aria-expanded', String(open));
  if (open) {
    focusIndex = -1;
    renderDownloads();
  }
}

async function renderDownloads() {
  const request = ++downloadsRequest;
  const list = $('downloadsList');
  const status = $('downloadsStatus');
  try {
    const videos = await window.api.listDownloads();
    if (request !== downloadsRequest) return;
    list.replaceChildren();
    status.textContent = videos.length ? '' : 'No saved videos yet.';
    for (const entry of videos) {
      const row = document.createElement('div');
      row.className = 'download-row row';
      const play = document.createElement('button');
      play.className = 'download-play';
      play.textContent = entry.title;
      play.onclick = async () => {
        const action = ++moviePlayRequest;
        try {
          const source = await window.api.playDownload(entry.id);
          if (action !== moviePlayRequest) return;
          if (source.error) { status.textContent = source.error; return; }
          await window.api.setMediaHeaders(null);
          if (action !== moviePlayRequest) return;
          clearMovieCaptions();
          playSource(source.url, { title: source.title, meta: { kind: 'download' } });
          $('statusBar').textContent = 'Playing saved video: ' + source.title;
          status.textContent = '';
        } catch { status.textContent = 'Could not open the saved video.'; }
      };
      const size = document.createElement('span');
      size.className = 'meta';
      size.textContent = (entry.bytes / 1048576).toFixed(1) + ' MB';
      const remove = document.createElement('button');
      remove.className = 'btn';
      remove.textContent = 'Remove';
      remove.title = 'Remove from Downloads list';
      remove.onclick = async () => {
        try { await window.api.removeDownload(entry.id); renderDownloads(); }
        catch { status.textContent = 'Could not remove the video from the list.'; }
      };
      row.append(play, size, remove);
      list.append(row);
    }
  } catch {
    if (request === downloadsRequest) status.textContent = 'Could not load saved videos.';
  }
}
$('showDownloads').onclick = () => toggleDownloads($('downloadsView').classList.contains('hidden'));
$('closeDownloads').onclick = () => { toggleDownloads(false); $('showDownloads').focus(); };
$('addDownloadedVideo').onclick = async () => {
  try { if (await window.api.addDownloadedVideo()) renderDownloads(); }
  catch { $('downloadsStatus').textContent = 'Could not add the selected video.'; }
};

function backToMoviesHome() {
  detailsRequest++;
  moviePlayRequest++;
  $('detailsView').classList.add('hidden');
  const showResults = $('movieSearch').value.trim() && $('movieResults').children.length;
  $('movieResults').classList.toggle('hidden', !showResults);
  $('moviesHome').classList.toggle('hidden', Boolean(showResults));
  currentDetails = null;
}
async function playEpisode(d, season, episode, resume) {
  const isSeries = d.type === 'series' || (d.seasons && d.seasons.length > 0);
  const label = isSeries ? `${d.title} S${season} E${episode}` : d.title;
  const request = ++moviePlayRequest;
  const action = $('dPlay');
  if (action) { action.disabled = true; action.textContent = 'Loading…'; }
  let failed = true;
  $('statusBar').textContent = 'Loading: ' + label + '…';
  try {
    const r = await window.api.mbPlay({ subjectId: d.subjectId, se: season, ep: episode, detailPath: d.detailPath });
    if (request !== moviePlayRequest) return;
    if (!r || r.error || !(r.sources && r.sources.length)) {
      toast('No playable streams found');
      $('statusBar').textContent = 'No streams for ' + label;
      return;
    }
    const cwKey = 'mb:' + d.subjectId + ':' + season + ':' + episode;
    suppressedProgress = '';
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
    if (request !== moviePlayRequest) return;
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
    failed = false;
  } catch (e) {
    if (request !== moviePlayRequest) return;
    toast('Playback failed: ' + e.message);
    $('statusBar').textContent = 'Playback failed';
  } finally {
    if (action?.isConnected && request === moviePlayRequest) {
      action.disabled = false;
      action.textContent = failed ? 'Retry' : 'Playing';
      if (failed) action.onclick = () => playEpisode(d, season, episode, resume);
    }
  }
}
let moviePlayRequest = 0;
function stepPlayback(delta) {
  if (current?.kind !== 'tv' || !current.channel) { stepEpisode(delta); return; }
  const list = filtered.some(channel => channel.url === current.channel.url) ? filtered : channels;
  const index = list.findIndex(channel => channel.url === current.channel.url);
  if (index < 0 || list.length < 2) return;
  const next = list[(index + delta + list.length) % list.length];
  focusIndex = filtered.findIndex(channel => channel.url === next.url);
  playChannel(next);
  renderChannelList();
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
  focusIndex = tab === 'tv' ? filtered.findIndex(channel => channel.url === current?.channel?.url) : -1;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('tvView').classList.toggle('hidden', tab !== 'tv');
  $('moviesView').classList.toggle('hidden', tab !== 'movies');
  state.lastTab = tab;
  saveStateSoon();
  if (tab === 'movies' && !$('movieRails').children.length) loadMovieHome();
}
document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => switchTab(t.dataset.tab); });
$('tvSearch').addEventListener('input', () => applyChannelFilter());
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
function closeHeaderMenu() {
  $('headerMenu').classList.add('hidden');
  $('headerMore').setAttribute('aria-expanded', 'false');
}
$('headerMore').onclick = () => {
  const hiding = !$('headerMenu').classList.contains('hidden');
  if (hiding) { closeHeaderMenu(); return; }
  $('headerMenu').classList.remove('hidden');
  $('headerMore').setAttribute('aria-expanded', 'true');
  $('headerMenu').querySelector('button')?.focus();
};
$('headerMenu').querySelectorAll('[data-button]').forEach(button => {
  button.onclick = () => {
    closeHeaderMenu();
    $(button.dataset.button).click();
  };
});

// ---------- clock ----------
function tickClock() {
  const d = new Date();
  $('clock').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
setInterval(tickClock, 10000);
setInterval(async () => {
  const session = liveBuffer;
  if (session) {
    try {
      const status = await window.api.liveBufferStatus();
      if (session === liveBuffer && status) {
        mediaBytes += Math.max(0, status.bytes - session.bytes);
        session.bytes = status.bytes;
        if (status.message && session.active) $('statusBar').textContent = status.message;
      }
    } catch (_) {}
  }
  const now = performance.now();
  const mbps = (mediaBytes - lastNetworkBytes) * 8 / Math.max(1, now - lastNetworkTime) / 1000;
  $('network').textContent = `${mbps.toFixed(1)} Mbps / ${Math.round(mediaBytes / 1e6)} MB`;
  lastNetworkBytes = mediaBytes;
  lastNetworkTime = now;
}, 1000);

// ---------- keyboard navigation ----------
function visibleRows() {
  const active = document.querySelector('.tab.active').dataset.tab;
  if (active === 'tv') return [...$('channelList').querySelectorAll('.row')];
  if (!$('downloadsView').classList.contains('hidden')) return [...$('downloadsList').querySelectorAll('.download-play')];
  if (!$('detailsView').classList.contains('hidden')) return [...$('detailsView').querySelectorAll('.ep-btn, #dPlay')];
  if (!$('movieResults').classList.contains('hidden')) return [...$('movieResults').querySelectorAll('.row')];
  return [...document.querySelectorAll('.card')];
}
function moveFocus(delta) {
  const rows = visibleRows();
  if (!rows.length) return;
  focusIndex = Math.max(0, Math.min(rows.length - 1, (focusIndex < 0 ? 0 : focusIndex + delta)));
  rows.forEach((r, i) => r.classList.toggle('focused', i === focusIndex));
  rows[focusIndex].focus({ preventScroll: true });
  rows[focusIndex].scrollIntoView({ block: 'nearest' });
}
document.addEventListener('keydown', (e) => {
  if (movieDialog.open || $('removeContinue').open) return;
  if (document.fullscreenElement) showPlayerBar();
  const inInput = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
  if (e.key === 'Escape') {
    if (!$('headerMenu').classList.contains('hidden')) { closeHeaderMenu(); $('headerMore').focus(); return; }
    if (!$('popupMenu').classList.contains('hidden')) { closePopup(); return; }
    if (!$('arrangeMenu').classList.contains('hidden')) { closeArrangeMenu(); return; }
    if (document.fullscreenElement) { document.exitFullscreen(); return; }
    if (state.lastTab === 'movies' && !$('downloadsView').classList.contains('hidden')) { $('closeDownloads').click(); return; }
    if (state.lastTab === 'movies' && !$('detailsView').classList.contains('hidden')) { backToMoviesHome(); return; }
    return;
  }
  if (inInput) {
    if (e.key === 'ArrowDown') { e.preventDefault(); document.activeElement.blur(); focusIndex = 0; moveFocus(0); }
    if (e.key === 'Enter') { document.activeElement.blur(); }
    return;
  }
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); if (!document.fullscreenElement) { if (e.shiftKey) moveFocusedChannel(1); else moveFocus(1); } break;
    case 'ArrowUp': e.preventDefault(); if (!document.fullscreenElement) { if (e.shiftKey) moveFocusedChannel(-1); else moveFocus(-1); } break;
    case 'ArrowRight': if (document.activeElement === video || document.activeElement === document.body) { seekBy(10); } break;
    case 'ArrowLeft': if (document.activeElement === video || document.activeElement === document.body) { seekBy(-10); } break;
    case 'Enter': {
      if (document.activeElement.closest('button')) break;
      if (document.fullscreenElement) { e.preventDefault(); playPause(); break; }
      const rows = visibleRows();
      if (rows[focusIndex]) { e.preventDefault(); rows[focusIndex].click(); }
      break;
    }
    case ' ': e.preventDefault(); playPause(); break;
    case 'f': case 'F': $('btnFull').click(); break;
    case 'p': case 'P': togglePiP(); break;
    case 'c': case 'C': toggleCC(); break;
    case 'q': case 'Q': showQualityMenu(); break;
    case '+': case '=': video.volume = Math.min(1, video.volume + 0.1); video.muted = false; toast('Volume: ' + Math.round(video.volume * 100) + '%'); break;
    case '-': case '_': video.volume = Math.max(0, video.volume - 0.1); toast('Volume: ' + Math.round(video.volume * 100) + '%'); break;
    case 'm': case 'M': video.muted = !video.muted; toast(video.muted ? 'Muted' : 'Sound on'); break;
    case 'l': case 'L': setListHidden(!state.listHidden, true); break;
  }
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#headerMenu, #headerMore')) closeHeaderMenu();
  if (!$('popupMenu').classList.contains('hidden') && !$('popupMenu').contains(e.target) && !e.target.closest('#btnQuality, #btnAudio')) closePopup();
  if (!$('arrangeMenu').classList.contains('hidden') && !$('arrangeMenu').contains(e.target) && e.target.id !== 'arrangeBtn') closeArrangeMenu();
});

// ---------- in-app installer updates ----------
let pendingUpdate = null;
let downloadedTag = null;

function releaseNotesText(source) {
  // Template contents stay inert. Only plain text is copied into the dialog.
  const template = document.createElement('template');
  template.innerHTML = source;
  if (/&lt;\/?(?:p|ol|ul|li|h[1-6])\b/i.test(source) && !template.content.childElementCount) {
    template.innerHTML = template.content.textContent;
  }
  const content = template.content;
  content.querySelectorAll('script,style,template,iframe,svg').forEach(node => node.remove());
  content.querySelectorAll('li').forEach(item => {
    const list = item.parentElement;
    item.prepend(list?.tagName === 'OL' ? (Array.from(list.children).indexOf(item) + 1) + '. ' : '• ');
  });
  content.querySelectorAll('br,li').forEach(node => node.after('\n'));
  content.querySelectorAll('p,ul,ol,pre,h1,h2,h3,h4,h5,h6,div').forEach(node => node.after('\n\n'));
  return content.textContent.replace(/\r\n?/g, '\n').replace(/\n[ \t]+\n/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function renderReleaseNotes(box, source) {
  box.replaceChildren();
  let sections, details, section;
  const text = releaseNotesText(source).split(/^\s*code signing policy\b/im)[0];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || /\bREADME(?:\.md)?\b/i.test(line)) continue;
    if (/^\d+[.)]\s+/.test(line)) {
      if (!sections) sections = box.appendChild(document.createElement('ol'));
      section = sections.appendChild(document.createElement('li'));
      section.appendChild(document.createElement('strong')).textContent = line.replace(/^\d+[.)]\s+/, '');
      details = null;
    } else if (/^[•*-]\s+/.test(line)) {
      if (!details) details = (section || box).appendChild(document.createElement('ul'));
      details.appendChild(document.createElement('li')).textContent = line.slice(1).trimStart();
    } else {
      box.appendChild(document.createElement('p')).textContent = line;
      sections = details = section = null;
    }
  }
  if (box.childElementCount) {
    const title = document.createElement('h3');
    title.textContent = 'Is update mein kya naya hai?';
    box.prepend(title);
  }
}

function showUpdateDialog(update) {
  if (pendingUpdate?.tag === update.tag) return;
  pendingUpdate = update;
  const ready = downloadedTag === update.tag;
  $('updText').textContent = `Naya version aa gaya hai (${update.tag}).`;
  const notes = $('updNotes');
  renderReleaseNotes(notes, update.notes || '');
  notes.scrollTop = 0;
  notes.classList.toggle('hidden', !notes.textContent);
  $('updProgress').classList.add('hidden');
  $('updDone').classList.toggle('hidden', !ready);
  $('updDownload').classList.toggle('hidden', ready);
  $('updLater').classList.toggle('hidden', ready);
  $('updInstall').classList.toggle('hidden', !ready);
  $('updClose').classList.toggle('hidden', !ready);
  $('updateDialog').classList.remove('hidden');
  $(ready ? 'updInstall' : 'updDownload').focus();
}
function hideUpdateDialog() { $('updateDialog').classList.add('hidden'); pendingUpdate = null; }

$('updLater').onclick = hideUpdateDialog;
$('updClose').onclick = hideUpdateDialog;
$('updInstall').onclick = async () => {
  if (downloadedTag !== pendingUpdate?.tag) return;
  $('updInstall').disabled = true;
  $('updClose').disabled = true;
  try {
    clearTimeout(saveTimer);
    if (!await window.api.saveState(state)) throw new Error('Settings save nahi ho sakin.');
    await window.api.installUpdate();
  } catch (e) {
    toast('Update install nahi ho saka: ' + e.message);
    $('updInstall').disabled = false;
    $('updClose').disabled = false;
  }
};
$('updDownload').onclick = async () => {
  if (!pendingUpdate) return;
  const { tag } = pendingUpdate;
  $('updDownload').classList.add('hidden');
  $('updLater').classList.add('hidden');
  $('updProgress').classList.remove('hidden');
  $('updBar').value = 0;
  $('updPct').textContent = 'Download ho raha hai… 0%';
  try {
    await window.api.downloadUpdate(tag);
    downloadedTag = tag;
    $('updProgress').classList.add('hidden');
    const done = $('updDone');
    done.textContent = 'Update tayyar hai. Install & Restart app ko dobara kholega.';
    done.classList.remove('hidden');
    $('updInstall').classList.remove('hidden');
    $('updClose').classList.remove('hidden');
    $('updInstall').focus();
  } catch (e) {
    $('updProgress').classList.add('hidden');
    toast('Download fail ho gaya: ' + e.message);
    $('updDownload').classList.remove('hidden');
    $('updLater').classList.remove('hidden');
    $('updDownload').focus();
  }
};
window.api.onUpdateProgress((pct) => {
  $('updBar').value = pct;
  $('updPct').textContent = pct >= 100 ? 'Download mukammal. Signature check ho rahi hai…' : `Download ho raha hai… ${pct}%`;
});
window.api.onUpdateAvailable((update) => showUpdateDialog(update));
$('checkUpdate').onclick = async () => {
  toast('Update check ho raha hai…');
  try {
    const r = await window.api.checkUpdate();
    if (r && r.available) showUpdateDialog(r);
    else if (r && r.reason === 'up-to-date') toast('App up to date hai.');
    else if (r && r.reason === 'unsupported') toast('Updates installed Windows version mein available hain.');
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
  const { version } = await window.api.paths();
  $('version').textContent = `v${version}`;
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
  // Dev-only screenshot-test hooks: IPTV_OPEN_QUALITY=<ms> opens the
  // Quality menu after <ms>; IPTV_QUALITY_LEVEL=<n> picks HLS level n
  // through the same code path as the menu.
  if (env.openQuality) { const ms = Number(env.openQuality) || 9000; setTimeout(() => showQualityMenu(), ms); }
  if (env.qualityLevel !== '' && env.qualityLevel != null) { const idx = Number(env.qualityLevel); setTimeout(() => setTvLevel(idx), 12000); }
})();
