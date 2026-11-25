# IPTV — Desktop UI / Design Spec

Port of the Android TV app (`sadique6571/IPTV`, Kotlin Views, no Compose) to a
desktop (Electron) app. This spec covers **only the TV/desktop layout**
(side-by-side). Phone portrait layout (player stacked above the list) is
documented only where it differs, and is out of scope for the desktop build.

**Sources read (no source files were modified):**
- `app/src/main/kotlin/com/sadique/iptv/UiKit.kt` (561 lines) — palette, shapes, builders
- `app/src/main/kotlin/com/sadique/iptv/MainActivity.kt` (2224 lines) — layout, player chrome, keys
- `ChannelBrowser.kt`, `Playback.kt`, `MoviesSection.kt`, `MoviesSidebar.kt`,
  `MoviesTabs.kt`, `MoviesHome.kt`, `MoviesRails.kt`, `MovieDetails.kt`,
  `ChannelSearch.kt` — browse pane, player visibility, movies UI
- `app/src/main/assets/verified-channels.m3u` — 109 channels

**Units.** All sizes below are Android `dp` / `sp` as written in the code.
The app targets a 1920×1080 TV at xhdpi, i.e. a **960×540 dp logical canvas**,
so **1 dp = 2 px** on that screen. For the desktop build, design in dp and
render at `scale = windowWidthPx / 960` (2.0× at 1920×1080). `sp` behaves like
dp here (no user font scaling on TV).

**Font.** No custom font is declared anywhere in the code — everything is the
Android default typeface (Roboto on most devices), `BOLD` for headings/names.
Desktop equivalent: system sans (Roboto if bundled, else Inter / system-ui).
Letter spacing is only set in two places: app title `0.03em`, LIVE badge `0.08em`.

---

## 1. Layout — TV / desktop (side-by-side)

### 1.1 Root

```
┌──────────────────────────────────────────────────────────────┐
│ rootView (vertical) — background: demoBackground()           │
│  padding: 32dp sides, 10dp top, 12dp bottom (TV overscan)    │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ headerView (bright glass panel, 20dp radius)             │ │
│ │  [icon 44dp] IPTV 28sp  v2.0.23.71  [Live TV] [Playlists] │ │
│ │  [Import M3U] [Xtream] [Update]        500 Kbps/30 MB    │ │
│ └──────────────────────────────────────────────────────────┘ │
│  8dp gap                                                     │
│ ┌──────────────────────┐ 14dp ┌───────────────────────────┐ │
│ │ libraryPane 320dp    │ gap  │ playerPane (weight 1)     │ │
│ │  search field        │      │  screen: 16:9 video card  │ │
│ │  categories panel    │      │  (fills remaining height) │ │
│ │  catalog title       │      │                           │ │
│ │  channel list        │      │                           │ │
│ └──────────────────────┘      └───────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

Derived widths at 960 dp logical: root content = 960 − 64 = **896 dp**.
Library **320 dp**, gap **14 dp**, player pane = 896 − 320 − 14 = **562 dp**
wide; the 16:9 screen inside it is 562 × 316 dp.

- `splitPane` is horizontal on TV (and on landscape phones/tablets).
  Portrait phones stack the player above the list — not relevant to desktop.
- The header is hidden on phones in landscape; on TV it is always visible
  windowed, hidden in fullscreen.
- `rootView` background is `demoBackground()` (see §2.4) — the whole window
  is the glowing navy gradient, never a flat color.

### 1.2 Header / status bar

- One rounded panel: `brightGlassShape(20)`, padding `16dp` sides / `8dp` vertical.
- Deterministic height: **64 dp on TV** (48 dp pill + 16 dp padding),
  60 dp otherwise (44 dp icon + 16 dp padding). The Movies overlay offsets
  from this height (see §7).
- Contents, left → right:
  1. Launcher icon `ImageView`, **44×44 dp**, `FIT_CENTER`.
  2. Title `"IPTV"`, **28 sp bold**, color `textColor`, letter-spacing `0.03em`,
     padding `12dp` left / `16dp` right.
  3. Installed-build label, **12 sp**, color `muted2` (e.g. `v2.0.23.71`),
     top padding `6dp`, right padding `12dp`.
  4. **"Live TV" pill** (`backToTvButton`) — visible ONLY while the Movies
     section is open. Icon + text, `topPillButton` style (see §3.3).
     Action: close Movies **and stop a playing movie**.
  5. TV-only action pills (icon + visible text, `topPillButton`):
     **Playlists**, **Import M3U**, **Xtream**, **Update** — each with
     `8dp` right margin.
  6. Network label, right-aligned, **12 sp** `muted2`, weight 1:
     `"500 Kbps/30 MB"` — current speed + today's usage, refreshed **once
     per second** while visible. Initial text `"0 Kbps/0 B"`.
- Header bottom margin: **8 dp**.

### 1.3 Left pane (library / browse pane)

Top → bottom:

1. **Channel search field** — inline `EditText`, always visible, above both
   browse levels. `hint "Search channels…"`, **15 sp** (TV), text `textColor`,
   hint `muted2`, search icon at start (10 dp gap, tinted `muted`),
   `minimumHeight 52 dp` (TV), padding `16dp` sides / `8dp` vertical,
   background `glassStateList(24)` (glass, cyan 2 dp ring on focus).
   Bottom margin **8 dp**. Typing filters live, globally across all channels.
   See §5.4.
2. **Categories panel** (TV only) — `brightGlassPanel(12)`: bright glass,
   20 dp radius, 12 dp internal padding. Contains the category nav items
   (see §5.2). The panel is a `ScrollView`; it is one of two browse levels
   (see §6.1). Starts hidden — the app opens on the channels level (All).
3. **Catalog title** — `label("", 14sp, accent)` i.e. **14 sp cyan**,
   top margin `6dp`, bottom margin `2dp`. Text: `"<source> · <count>"`
   e.g. `"Checked streams · 109"`, plus `" · <query>"` while searching.
   Sources: `Checked streams` (built-in), playlist name (M3U),
   `Favorites`, `Recent`.
4. **Search clear row** — visible only while a query is active:
   `"Search: \"<query>\""` (14 sp TV / 13 sp phone, `muted`, max 1 line,
   ellipsized) + a `"Saaf karein"` button (close icon) at the right.
   Bottom margin `4dp`.
5. **Channel list** — `ScrollView` containing a vertical `LinearLayout` of
   channel rows (see §5.1). Weight 1 (fills remaining height).
   Lazy: first **16 rows** built, then **+12** when scrolling to within
   2× viewport height of the bottom.

### 1.4 Right pane (player pane)

- `playerPane` has left padding = pane gap (**14 dp** TV).
- `screen`: `FrameLayout`, background **`#060B28`**, **24 dp rounded corners**
  windowed (clipped via outline provider), **square corners (0 dp) in
  fullscreen and in mini-player mode**. A 1 dp border ring is drawn over the
  video edges: stroke **`#6696ACFF`**, same 24 dp radius (squares with the card).
- The video surface fills the pane (weight 1). Overlays inside `screen`,
  in z-order: video surface → border ring → meta chip (top-left) →
  number overlay (top-center) → status line (top-center) → fav button
  (top-right) → quality button (bottom-right) → top bar (top, full width)
  → overlay bar / player bar (bottom-right) → Up Next card (bottom-right,
  above the bar) → seek indicator (center) → buffering spinner (center).
- **Fullscreen (TV):** header + library hidden, root padding **0**,
  player padding **0**, corners square — video fills the whole 1920×1080.
  No rotation / system-UI hiding on TV (that is phone-only).
- **Mini player** (a movie playing windowed with the Movies browser open):
  - TV: side-by-side like Live TV — Movies browser **55%** of available
    width on the left, player **45%** on the right, both fixed, square
    corners, flush (player-pane padding 0). At 896 dp available width:
    player ≈ **403 dp**, browser ≈ **493 dp**.
  - Phone: player on top, 16:9, at most **40% of display height**
    (432 px on 1920×1080), browser below, docked/square/flush.
  - Header stays visible in mini-player mode (it carries the "Live TV"
    button); player controls are **pinned** (no auto-hide) so fullscreen
    is always one tap away.
- While a movie plays on a side-by-side screen, the **browse pane hides**
  (the video gets the space); channels keep it (you surf during those).
  A finished movie brings the browse pane back.

### 1.5 Movies overlay

- A full-screen overlay view (`moviesView`) added on top of the Live TV
  layout in a `FrameLayout` — opening it never detaches the player underneath.
  Built lazily on first open, not at startup.
- Padding: **32 dp sides / 20 dp vertical** (TV), background `demoBackground()`.
- It sits **below the header**: top margin = root top padding (10 dp)
  + header height (64 dp TV) = **74 dp**; in mini-player TV mode it is
  also inset to the left 55% (see §1.4).
- No header row inside the browser — the app status bar above it already
  carries "Live TV".
- TV two-pane inside the overlay: **sidebar 300 dp** + content with
  **16 dp** left margin. Phone: single scrolling column (out of scope).
- Focus trap while open: `libraryPane` gets `FOCUS_BLOCK_DESCENDANTS`
  (the status bar and mini-player controls stay reachable). See §6.5.

---

## 2. Color palette

Quoted verbatim from `UiKit.kt` (`0xAARRGGBB` → `#AARRGGBB` / `#RRGGBB`).

### 2.1 Base palette ("Qwen HarmonyOS palette")

| Token | Hex | Used for |
|---|---|---|
| `bg0` | `#091120` | Background gradient, darkest stop |
| `bg1` | `#101E32` | Background gradient, middle stop |
| `bg2` | `#202947` | Background gradient, lightest stop |
| `glass` | `#ED172539` | Default glass fill (93% alpha `#172539`) |
| `glassHi` | `#F122354E` | Brighter glass (pressed state, letter tiles) |
| `glassStroke` | `#2496ACFF` | Default glass stroke — 36/255 ≈ **14%** alpha `#96ACFF` |
| `strokeHi` | `#4D96ACFF` | Stronger glass stroke — ≈ **30%** alpha |
| `textColor` | `#F2F6FF` | Primary text |
| `muted` | `#9AA7D6` | Secondary text, unselected chips/nav, icons |
| `muted2` | `#A6B6CE` | Tertiary text (category lines, version, network) |
| `cyan` | `#22D9EE` | **Accent** — focus rings, status text, list counts, selected text |
| `teal` | `#1F8F8E` | CC chip while subtitles are ON (muted teal + white text) |
| `netflixRed` | `#E50914` | Seek-bar progress |
| `blue` | `#3D7BFF` | Gradient end (selected pill), glow color |
| `magenta` | `#E45CFF` | Favorite heart when active, glow color |
| `purple` | `#8B5CFF` | SERIES badge, glow color |
| `liveRed` | `#BC334B` | LIVE badge, favorite heart (movies), corner fav |
| `overlayDark` | `#99060A1E` | Meta chip / overlay pill fill (60% alpha `#060A1E`) |
| `accent` | = `cyan` | Focus strokes, status text, list counts |

Notes: green/amber from the source HarmonyOS palette are **unused** (no 4K/HDR
badges) and not declared. The player screen background is a separate literal
**`#060B28`**.

### 2.2 Glass shapes

- **`glassShape(radiusDp = 22, strokeColor = #4096ACFF, strokeDp = 1)`** —
  the fill for nearly every box (rows, buttons, chips, cards, search fields):
  3-stop vertical gradient **`#A63A5A80` → `#9922354E` → `#99172539`**
  (≈60–65% alpha, light top edge so it reads as a raised panel) +
  1 dp stroke **`#4096ACFF`** (≈25% alpha light blue). Focused variant:
  same fill, **cyan 2 dp** stroke. Pressed: `glassHi` fill + cyan stroke.
- **`brightGlassShape(radiusDp = 20)`** — big panels only (header, category
  pane, Movies sidebar, phone chip-strip panel): gradient
  **`#B3547FAA` → `#993A5A80` → `#992C4A6E`** (≈60–70% alpha) +
  **2 dp stroke `#8C22D9EE`** (≈55% alpha cyan), lighter top sheen.
  This is what makes panels read as frosted glass over the glowing background.
- **`gradientPill(radiusDp = 25)`** — selected/active state: horizontal
  gradient **`#22D9EE → #3D7BFF`** (cyan → blue), white text.
- **`glassStateList(radiusDp)`** — search fields, icon buttons:
  focused = `glassShape(radius, cyan, 2)`; pressed = `glassShape(radius, strokeHi, 1)`;
  rest = `glassShape(radius)`.
- **`navItemBackground()`** — category items: focused = glass + cyan 2 dp;
  selected = `gradientPill(16)`; pressed = glass + `strokeHi` 1 dp; rest = glass.
- **`rowBackground(playing)`** — channel/movie rows: focused = glass(16) +
  cyan 2 dp; pressed = `glassHi` + cyan; rest = `gradientPill(16)` if playing
  else `glassShape(16)`.

### 2.3 Focus / selected states (universal)

- **Focus:** cyan **2 dp** ring (3 dp on TV for the big Play button and the
  generic `button()` focused state) + **scale 1.03×** over **120 ms**
  (`animateFocusScale`). Focused text/icon turns **white**; unfocused text
  is `muted` (`#9AA7D6`).
- **Selected (active filter/tab/episode):** `gradientPill` (cyan→blue) +
  white text. A selected item keeps the gradient even unfocused.
- **Pressed:** `glassHi` fill + cyan stroke.

### 2.4 Background (`demoBackground()`)

- Base: diagonal gradient (top-left → bottom-right) **`#091120 → #101E32 → #202947`**.
- Four soft radial glows (color, center x/y as fraction of screen, radius as
  fraction of min(w,h)):
  - cyan **`#B322D9EE`** (70% alpha) at (0.88, 0.15), r 0.55
  - blue **`#993D7BFF`** (60%) at (0.05, 0.88), r 0.55
  - purple **`#808B5CFF`** (50%) at (0.05, 0.38), r 0.45
  - indigo **`#735C6CFF`** (45%) at (0.92, 0.75), r 0.50
- Plus **12 bokeh dots**: tiny radial glows (r 0.012–0.03, 50–90% alpha,
  cyan/blue/purple/white) scattered across the screen, e.g. `#B322D9EE` at
  (0.06, 0.30), `#CC7FB8FF` at (0.18, 0.08), `#E6FFFFFF` at (0.78, 0.62).
- The translucent panels let the glow show through — that is the frosted-glass
  effect. Render as layered radial gradients over the base gradient.

### 2.5 Player chrome colors

| Element | Fill / stroke |
|---|---|
| Bottom bar (`overlayBar`) | **`#99000000`** (60% black) + **`#40FFFFFF`** (25% white) rim, **24 dp** radius, elevation 6 dp |
| Top bar (`topBar`) | Vertical gradient **`#99000000 → #00000000`** (fades out downward) |
| Player chips (Prev/Next/Audio/CC/Quality/fullscreen) | **`#E63A3A3E`** frosted grey + **`#26FFFFFF`** (15% white) 1 dp rim, **6 dp** corners; focused: `#CC000000` + cyan 2 dp ring; pressed: `#99000000` + cyan 1 dp |
| CC chip, subtitles ON | Muted teal **`#1F8F8E`** fill + white text (NOT bright cyan) |
| Play/pause disc | Solid **white** circle, dark glyph **`#111111`**; focused: white + cyan 2 dp ring |
| Icon buttons on video (back arrow, −10/+10) | Transparent at rest; focused `#CC000000` + cyan 2 dp ring (24 dp radius); pressed `#99000000` |
| Meta chip (name chip) | `overlayDark` `#99060A1E` + `#1AFFFFFF` 1 dp stroke, **18 dp** radius |
| Status line pill | `overlayDark` + `#1AFFFFFF` 1 dp stroke, **18 dp** radius |
| Seek indicator pill ("−10s") | `overlayDark` + `#1AFFFFFF` 1 dp stroke, **24 dp** radius |
| Up Next card | `#99000000` + `#40FFFFFF` 1 dp stroke, **16 dp** radius, elevation 6 dp |
| Seek bar | Progress **`#E50914`** (red; white while focused), track **`#38FFFFFF`**, thumb solid white **12 dp** circle |
| Buffering spinner | Large, cyan tint |
| Subtitle box | White text on **`#99000000`** (60% black) box, 4 dp radius (toggleable; off = text only) |
| Corner fav button | Glass circle (24 dp radius): focused glass + cyan 2 dp; pressed `glassHi` + cyan |
| Corner quality button | Fill **`#B8070D26`** + `#6622D9EE` 1 dp stroke, 14 dp radius; focused `#B8070D26` + cyan 2 dp; pressed `#CC1E2A66` + cyan 1 dp; text **cyan**, bold |
| Popup menu box | **`#E6000000`** (90% black) + `#26FFFFFF` 1 dp stroke, **10 dp** radius, 6 dp padding, min width **200 dp**; row focus highlight `#2AFFFFFF`, 6 dp radius |
| LIVE badge | **`#BC334B`** fill, white bold text |
| HINDI badge | **cyan `#22D9EE`** fill, white bold text |
| SERIES badge | **purple `#8B5CFF`** fill, white bold text |

---

## 3. Typography

All sizes are `sp` as written in the code (TV value first; phone differs only
where noted). `label()` adds **4 dp** top/bottom padding unless overridden.

| Element | Size | Weight | Color |
|---|---|---|---|
| Header title "IPTV" | **28** (TV) / 22 | Bold, ls 0.03em | `textColor` |
| Installed version label | **12** | — | `muted2` |
| Header network label | **12** | — | `muted2` |
| Top pill buttons | **15** | — | `textColor` |
| Generic `button()` | **15** TV / 14 | — | `textColor` |
| `chip()` (filter/tab/genre) | **15** TV / 14 | — | `muted` → white when focused/selected |
| Category nav item | **16** | — | `muted` → white when focused/selected |
| Catalog title ("Checked streams · 109") | **14** TV / 12 | — | `accent` (cyan) |
| Search clear label | **14** TV / 13 | — | `muted` |
| Channel search input | **15** TV / 14 | — | `textColor` (hint `muted2`) |
| Channel row name | **16** | Bold | `textColor` |
| Channel row category | **12** | — | `muted2` |
| Channel logo letter tile | **20** TV / 18 | Bold | white |
| Playing indicator "♫" | **18** | — | white |
| Row favorite heart "♥/♡" | **19** | — | magenta if fav, else white |
| Meta chip: channel name | **18** TV / 13 | Bold | `textColor` |
| Meta chip: category | **14** TV / 13 | — | `muted2` |
| LIVE badge | **12** | Bold, ls 0.08em | white |
| Status line (buffering/errors) | **15** TV / 13 | — | `accent` (cyan) |
| Number overlay ("Channel 12") | **22** TV / 18 | Bold | `textColor` |
| Top-bar title ("The Body • S1:E1") | **18** TV / 16 | Bold | white |
| Seek time readout ("24:31 / 1:58:00") | **12** | — | white |
| Seek indicator ("−10s") | **16** | — | white |
| −10 / +10 buttons | **12** | — | white |
| Player chips (Prev/Next/Audio/CC/Quality) | **10** | Bold | white |
| Corner fav button "★/☆" | **22** TV / 20 | — | white (magenta when fav) |
| Corner quality button | **16** TV / 14 | Bold | cyan |
| Up Next title | **16** TV / 15 | Bold | white |
| Up Next countdown | **14** TV / 13 | — | `#CCCCCC` |
| Section label (rail headers) | **17** TV / 16 | Bold | `textColor` |
| Movies status label | **15** TV / 13 | — | `muted` |
| Movie search input | **17** TV / 15 | — | `textColor` |
| Movie row title | **17** TV / 16 | Bold | `textColor` |
| Movie row year | **13** | — | `muted2` |
| HINDI / SERIES badges | **11** | Bold | white |
| Poster card title | **14** TV / 13 | Bold | `textColor` |
| Poster card year | **12** | — | `muted2` |
| Continue-row title | **17** TV / 16 | Bold | `textColor` |
| Continue-row sub ("% dekhi · M:SS baaki") | **13** | — | `muted2` |
| Details title | **24** TV / 20 | Bold | `textColor` |
| Details meta | **15** TV / 13 | — | `muted` |
| Details description | **15** TV / 14 | — | `muted` |
| Details section labels (Season/Episodes/Quality) | **15** TV / 13 | Bold | `textColor` |
| Details status line | **15** TV / 13 | — | `muted` |
| Episode number button | **16** TV / 15 | Bold | `muted` → white when focused/selected |
| Play button | **18** TV / 16 | Bold | white |
| Popup menu rows | **15** | — | white (value text `muted2`) |
| Popup checkmark "✓" | **18** | — | cyan |
| CC preview line | **16** | — | white |
| Now-playing bar label | **15** TV / 14 | — | `textColor` |
| Empty-state labels | **16** TV / 14 | — | `muted` |

---

## 4. Player bar

### 4.1 Control order (left → right, exactly as built)

```
[▶/❚❚ disc] [−10] [+10] [━━━━━━━ seek bar ━━━━━━━ 24:31 / 1:58:00] [Prev] [Next] [Audio] [CC] [Quality] [⛶]
```

- The bar is a **single pill** anchored bottom-right of the video
  (margins 8 dp on all sides), `MATCH_PARENT` width for movies,
  `WRAP_CONTENT` for channels (but see §4.3 — channels hide it).
- The top bar is separate: full-width gradient scrim at the top with the
  **back arrow** (drawn: long thin shaft + 45° chevron head, 2 dp white
  stroke, intrinsic 30 dp, 6 dp padding) + **title** (`"Title • S1:E1"`,
  18 sp bold white, max 1 line, ellipsized). Padding 16/16/16/28 dp.
  It shows/hides together with the bottom bar.
- The **fullscreen icon** is drawn in code: four white corner brackets,
  2 dp stroke, round caps, arm 20% of size, gap 14%; intrinsic **28 dp**;
  pointing out when windowed, in when fullscreen.

### 4.2 Sizes

| Control | Size |
|---|---|
| Play/pause disc | **40×40 dp** TV (34 phone); white circle, dark `#111111` glyph |
| −10 / +10 | Plain text 12 sp, padding 6 dp sides / 6 dp vertical TV, height **28 dp**, 1 dp side margins; transparent bg |
| Seek bar | Height **40 dp** TV (36 phone), flex width (weight 1); white 12 dp thumb; see §2.5 for colors |
| Time readout | **12 sp** white, no padding, immediately right of the bar; format `"M:SS / H:MM:SS"` (single combined readout; the old separate remaining-time label is hidden) |
| Prev / Next / Audio / CC / Quality chips | Height **24 dp** TV (20 phone), padding **10 dp** sides / 6 dp vertical TV (2 phone), **10 sp bold** white text, 2 dp side margins, frosted-grey fill, 6 dp corners |
| Fullscreen chip | Height **24 dp** TV (20 phone), 4 dp padding (icon 20 dp inside), 2 dp side margins |
| Bar itself | Padding 6 dp sides, **10 dp vertical** TV (9 phone); 24 dp radius; elevation 6 dp |

Measured proportions (from the demo-matching work): the disc is ~7.4% of bar
height on TV; chips ~4.4% of screen height on TV.

### 4.3 Visibility rules (`applyControlVisibility`)

- **Live channel playing:** the overlay bar is **entirely hidden** — a clean
  video. Only the meta chip (top-left, windowed only), the **fav button**
  (48 dp, top-right) and the **Quality corner button** (bottom-right, only
  when ≥2 video options exist) show. Web channels (YouTube embeds) hide the
  play/pause button too.
- **Movie/series playing:** full bar. Sub-rules:
  - Seek row (bar + time): only when the movie is **seekable**.
  - −10/+10: same condition as the seek row.
  - Prev: only when `episode > 1`; Next: only when `episode < episodeCount`
    of the current season.
  - Audio: always while a movie/series plays.
  - CC: only when the title has an English subtitle (`currentSubtitle != null`).
  - Quality: only when ≥2 adaptive tracks **or** ≥2 stream resolutions exist.
    The chip always reads `"Quality"` (the current quality is shown as the
    checked row inside the popup, not on the chip).
- **Auto-hide:** after **3000 ms** of inactivity the movie controls hide
  (top bar + bottom bar together); subtitles drop their bottom padding from
  20% to 3% of screen height when hidden. On TV, live-channel controls never
  auto-hide (there is no bar to hide). Mini player: controls **pinned**,
  never auto-hide. Scrubbing, web channels, and TV live playback all block
  hiding.
- **Up Next card:** appears in the **last 20 s** of a series episode;
  **10 s countdown** then auto-plays the next episode. Thumb 56×84 dp,
  title 16 sp bold, countdown 14 sp `#CCCCCC`, positioned bottom-right,
  8 dp end margin, **72 dp** bottom margin (above the bar).
- **Seek indicator:** pill showing `"−10s"` / `"+10s"` at screen center
  (48 dp side margins), fades after **~900 ms**.
- **Status overlay:** top-center, 12 dp top margin; appears on buffering
  (`"Buffering…"`) / errors / `"Paused"` / `"Playback ended."`; auto-hides
  when the text is empty. Buffering spinner centered, cyan.
- **Meta chip:** top-left, margins 20 dp start / 12 dp top (TV);
  name 18 sp bold + LIVE badge on one row, category 14 sp below (hidden if
  empty). Hidden in fullscreen and while a movie plays (the top bar carries
  the movie title instead). Max name width = 50% of screen width.

### 4.4 Player popups (CC / Quality / Audio)

Small anchored popups, **never** bottom sheets:

- Box: 90% black `#E6000000`, 1 dp `#26FFFFFF` stroke, **10 dp** corners,
  6 dp padding, **min width 200 dp**, `WRAP_CONTENT` otherwise.
- Positioned **above the anchor chip**, centered on it, clamped to screen
  edges, 8 dp above the chip. Focusable so **Back dismisses** it; outside
  tap dismisses; focus returns to the chip on dismiss; on TV the first row
  gets focus on open.
- Rows: label left (15 sp white), cyan **"✓"** (18 sp) on the right when
  checked; row padding 10 dp sides / 8 dp vertical; focused row gets
  `#2AFFFFFF` fill, 6 dp radius. **Tapping a row applies live and moves the
  checkmark — the popup stays open** until Back/outside tap.
- **CC popup:** live preview line at top (`"Tum yahan kya kar rahe ho?"`,
  16 sp, centered, restyled live) + `English` / `Off` rows + `Size` value
  row (tap cycles **Chhota 16 sp → Medium 20 sp → Bara 24 sp**; default
  Medium 20 sp) + `Black background` toggle row (default **on**).
  Subtitles are **English only** (`lan == "en"`).
- **Quality popup:** one row per available quality (e.g. `1080p`, `720p`,
  `Auto`), checked = current.
- **Audio popup:** one row per audio track/dub.
- The details-screen Quality button also opens the same anchored popup.

---

## 5. Channel list

### 5.1 Channel rows

One glass card per channel (see `rowBackground`):

- Layout: horizontal, centered vertically. **Min height 52 dp** TV (48 phone),
  padding **16 dp** sides / **6 dp** vertical (TV), **8 dp** side margins,
  **3 dp** top/bottom margins (TV), elevation 3 dp, **16 dp** corners.
- **Logo tile:** round, **40×40 dp** TV (44 phone), at the left.
  Logo image (`FIT_CENTER`) over a letter tile: first letter of the name,
  **20 sp bold white** on `glassHi` fill (12 dp radius). If the logo fails
  to load, the letter tile remains.
- **Texts:** name **16 sp bold** `textColor`, max 1 line, ellipsized;
  group/category **12 sp** `muted2`, max 1 line, below the name.
  Text column has weight 1, **12 dp** left margin from the tile.
- **Playing indicator:** `"♫"` **18 sp white**, visible only on the playing
  row (padding 4 dp left / 8 dp right). The playing row's background is the
  cyan→blue `gradientPill`, so the mark is white, not cyan.
- **Favorite heart:** `"♥"` / `"♡"`, **19 sp**, **36×36 dp** TV (48 phone),
  8 dp left margin, fill `#9904081A` + `#1AFFFFFF` 1 dp stroke, 18 dp radius.
  Magenta `#E45CFF` when favorite, white otherwise. **Not D-pad focusable**
  (touch only — remote navigation keeps one stop per row). Tapping toggles
  the favorite; the on-video corner button does the same for the playing channel.
- **Focus:** cyan 2 dp ring + 1.03× scale. **RIGHT from a row** moves onto
  the video's first visible overlay control; the target is re-synced on
  every playback change.
- Content description: `"<name>, <group>"`.

### 5.2 Categories / tabs (TV)

Two browse levels share the one left pane — never both at once:

- **CATEGORIES level:** the `brightGlassPanel(12)` with one `navItem` per
  filter + a Movies item. Items: **16 sp**, left-aligned text + icon
  (8 dp gap, tinted `muted` → white on focus/select), min height **52 dp**
  TV, padding 16 dp sides / 12 dp vertical, **8 dp** side margins,
  **4 dp** bottom margin, 16 dp corners.
- Order and icons: **All** (list), **Favorites** (heart), **Recent**
  (history), **News** (news), **Sports** (sports), **Islamic** (crescent),
  **Kids** (kids), **General** (tv), **M3U** (playlist), then **Movies**
  (movie icon, 4 dp top margin, not a filter — never becomes active).
- Picking a category swaps the pane to its channels; **Back** returns to
  categories. The app starts on the channels level (All).
- Phones instead show one horizontally scrolling chip strip (same 9 filters
  as `chip()`s, 10 dp gaps, inside a `brightGlassPanel(8)`) — not used on desktop.
- Selected filter: gradient pill + white text (`markActiveFilter`).

### 5.3 Filtering rules

`categoryGroups = {news, sports, cricket, islamic, religious, kids, animation}`.

| Filter | Matches (M3U `group-title`, case-insensitive; `;`-separated groups match every part) |
|---|---|
| All | Everything |
| Favorites | Stored favorites list (own order) |
| Recent | Stored recent list (own order) |
| News | `news` |
| Sports | `sports`, `cricket` |
| Islamic | `islamic`, `religious` |
| Kids | `kids`, `animation` |
| General | `general`, `undefined`, **or any group with no own category** (Drama, Music, …) — the catch-all |
| M3U | Imported playlists only (own order) |

- **Ordering** (except Favs/Recent/M3U): 24 pinned Pakistani entertainment
  channels first in a fixed order (Green Entertainment, ARY Digital, Hum TV,
  Geo Entertainment, Aan TV, MUN TV, Express Entertainment, Hum Sitaray,
  A Plus, TV One, PTV Home, Play Entertainment, Bol Entertainment HD,
  Apna Channel, 8XM, aurLife HD, LTN Family, M Entertainment, PTV Global,
  InPlus Pakistan, Falak TV, JooMusic, Discover Pakistan, Paigham Television),
  then PK channels, then other countries, **IN last**; stable sort keeps M3U
  order inside each group.
- **Search** is global: a query searches **all** bundled + imported channels
  regardless of the active filter, by name substring (case-insensitive).
- Empty states (16 sp TV, `muted`): Favs → `"Koi favorite nahi hai — kisi
  channel card par ♥ dabayein."`; Recent → `"Abhi koi recent channel nahi
  hai."`; M3U → `"Koi playlist import nahi hui — Import M3U dabayein."`;
  no search results → `"Koi natija nahi mila — \"<query>\""` + a
  `"← Poori list wapas"` button.

### 5.4 Search

- Inline field above the list (see §1.3). Live filtering on every keystroke;
  the pane switches to the channels level without moving focus (so typing is
  not interrupted). Search clear row + Back both restore the full list.
- The field's hint is `"Search channels…"`. `IME_ACTION_SEARCH`.

### 5.5 Favorites & recent

- Favorites: heart on the row + ★/☆ corner button on the video (48 dp,
  22 sp). Stored persistently (`ChannelStore`).
- Recent: last-played channels, own order, `Recent` filter.
- The playing row is highlighted via `markPlayingRow` without a list rebuild
  (scroll position preserved); favorite toggles rebuild preserving scroll.

---

## 6. Keyboard / remote navigation model

The app is D-pad-first; every focusable view must show the cyan ring +
1.03× scale. Focus is moved by Android's `FocusFinder` plus **explicitly
wired `nextFocus*` links** wherever geometry is unreliable (across scrollers
and pane boundaries).

### 6.1 Focus movement

- **Arrows / D-pad:** move focus spatially (up/down/left/right). Rows are
  one stop each (the heart inside a row is not focusable).
- **Enter / DPAD_CENTER / Numpad Enter:** activate the focused view.
  On a channel row, OK plays the channel. In the list, a channel never
  starts without OK.
- **Focus safety net:** if focus is ever lost (`currentFocus == null`),
  the first UP/DOWN press restores it to the playing row / active category /
  movie controls instead of doing nothing.
- **Explicit links (Live TV):**
  - Row RIGHT → first visible overlay control (play/pause, fav, quality).
  - Fav button DOWN → Quality button; Quality UP → Fav.
  - Player row chain, in visual order: play/pause ↔ −10 ↔ +10 ↔ [seek bar]
    ↔ Prev ↔ Next ↔ Audio ↔ CC ↔ Quality ↔ fullscreen; UP from any row
    button → seek bar; seek bar DOWN → play/pause, UP → top back button;
    top back DOWN → seek bar (or play/pause if not seekable).
  - Up Next card (when visible): fullscreen UP → card; card DOWN → fullscreen.

### 6.2 Number jump

- Digit keys **0–9** (incl. numpad) build a buffer of up to **4 digits**;
  an overlay pill shows `"Channel <N>"` (22 sp bold, top-center).
- Auto-jump **2500 ms** after the last digit; **Enter confirms immediately**.
- The number is the **1-based index in the currently shown list**
  (not a fixed channel number). Out of range → toast
  `"No channel <N> in this list."`
- Disabled while the Movies browser is open and while an `EditText` has focus.

### 6.3 Channel zapping (fullscreen live TV only)

- **UP / DOWN** while fullscreen and a channel is playing: previous / next
  channel in the current list (held keys zap once; repeat is consumed).
- In the list, UP/DOWN just move the selection (no auto-play).
- **OK while fullscreen live:** pause/resume (ExoPlayer holds the position;
  a very long pause falls out of the live window and jumps back to live).
  Status shows `"Paused"`. Skipped for web channels and while a number is
  being typed.

### 6.4 Back behavior (priority order)

1. Movies open + details visible → back to the movies list.
2. Movies open + a See All list visible → back to its tab.
3. Movies open (list level) → close Movies (**stops a movie playing in the
   mini player**, so it never keeps playing behind the channels screen).
4. Fullscreen → exit fullscreen. Movie → mini player (browser reopens at
   details/list, movie keeps playing). Channel → windowed.
5. Search query active → clear the search, restore the full list.
6. TV, channels level → back to the categories level (playback continues).
7. Something playing → stop it. A movie returns to its details screen if
   one was rendered, else to Live TV. (The movie's position is saved to
   Continue Watching first.)
8. Nothing playing → exit the app (system Back).
- While Movies is open, number jumps and channel switching are off — D-pad
  belongs to the open section.

### 6.5 Other navigation rules

- **Touch (phone):** tap video toggles controls; double-tap left/right third
  seeks ∓10 s (movies only); controls auto-hide after 3 s. On TV the controls
  stay visible (D-pad needs them).
- **Seek:** with the seek bar focused, LEFT/RIGHT seek ∓10 s. Dragging the
  bar previews the time; the real seek happens once on release.
- **Focus trap:** while the Movies overlay is open, the library pane takes
  no focus (`FOCUS_BLOCK_DESCENDANTS`) — focus cannot escape behind the
  overlay. The status bar ("Live TV") and mini-player controls stay reachable.
- **EditText focus:** a focused search field can swallow D-pad UP/DOWN on
  some TVs, so the keys are forwarded explicitly (channel search: DOWN moves
  to the first row / categories; movie search: DOWN → first tab, UP → "Live TV").
- **Wake key:** the first D-pad press while movie controls are hidden only
  reveals the controls and focuses play/pause (it is swallowed, not acted on).

---

## 7. Movies / series screens

### 7.1 Movies browser shell

- Full-screen overlay over Live TV (see §1.5). No header row inside — the
  app status bar carries "Live TV".
- **TV sidebar (300 dp, `brightGlassPanel(12)`):** search field on top
  (hint `"Movie ka naam…"`, **17 sp**, min height **56 dp**, padding 18/8,
  radius 28, search icon; keyboard search key runs the search) + vertical
  tab column: **Home, Movies, TV Shows, Genres, My List** (Downloads is
  mobile-only). Tabs are `chip()`s: 15 sp, min height 52 dp, padding 16/12,
  8 dp side/bottom margins, selected = gradient pill + white text.
  Focus links: search DOWN → first tab; first tab UP → search; search UP →
  "Live TV" button; "Live TV" DOWN → search; last tab DOWN → nowhere.
- **Content column:** status label (15 sp `muted`, e.g.
  `"Movie ka naam likh kar search karein — Hindi dubbed bhi milti hai."`)
  + cyan progress spinner + results `ScrollView` (weight 1).
- **Now-playing bar:** shown when a movie is already playing:
  glass(16) panel, padding 16/10, label `"▶ Abhi chal rahi hai: <title>"`
  (15 sp) + a `"Player"` button (play icon) that closes the browser and
  goes fullscreen. Top margin 10 dp.
- **Phone layout** (for reference only): search + tabs scroll with the
  content inside a `brightGlassPanel(12)`; tabs are a horizontal chip row.

### 7.2 Tabs

| Tab | Content |
|---|---|
| Home | **Continue Watching** rows + **Favorites** poster rail only (see §7.3) |
| Movies | Feed "New" list — newest movies first, max 20, as vertical rows |
| TV Shows | Feed series list, max 20, as vertical rows |
| Genres | 15 genre chips + quick-search chips + results (see §7.5) |
| My List | Favorite movies, as vertical rows |
| Downloads | Mobile only |

- Switching a tab clears any search / See All list. Re-rendering (after a
  feed arrival, favorite toggle, Back from details, finished movie) never
  changes the tab.
- Status text per tab: `"<Title> — <N> movies"`, or the empty message
  (e.g. `"Abhi koi Fav Movie nahi hai — movie khol kar ♥ dabayein."`).

### 7.3 Home tab — and a correction about the rails

**The Home tab shows only Continue Watching + Favorites.** The Top 10,
Trending Now, Top Picks for You and New Release rails were **removed in
v2.0.17** ("the user watches via search") — they must NOT be rebuilt on Home.
The feed loaders still exist (`MovieBoxFeeds.kt`: `newMovies()`,
`trending()`, `curatedPicks()`, `recommended()`) and feed the Movies / TV
Shows tabs; the home feed is loaded once per app run in the background.

- **Continue Watching:** rich rows (not a rail — the progress bar needs the
  row): min height **96 dp** TV (88 phone), padding 14/10, glass, elevation
  3 dp. Poster **60×90 dp** TV (56×84 phone), title **17 sp bold** (max 2
  lines), sub-line **13 sp** `muted2`: `"<S1:E3 · >42% dekhi · 12:34 baaki"`,
  cyan progress bar **6 dp** high below the text. An **✕ remove button**
  (44 dp icon button, glass radius 12) at the right; D-pad RIGHT from the
  row reaches it, UP/DOWN from it go to neighbouring rows. Tap resumes the
  movie where it stopped.
  - Positions under **5 s** are ignored (a fresh start is not "continue
    watching"); position is saved every **~10 s** while playing; a finished
    movie removes itself from Continue Watching.
- **Favorites rail:** `buildMoviesRail("♥ Favorites", …)` — section header
  (17 sp bold + "See All ›" button) + horizontal poster cards.
- Home status text: `"Continue Watching · Favorites"` / `"Continue Watching"`
  / `"Favorites"` / `"Abhi koi movie nahi mili — search karke movie dekhein."`

### 7.4 Poster rails and cards

- **Rail:** section header row (label weight 1 + "See All" button with
  chevron icon at end) + horizontal `ScrollView` (no scrollbar) of cards
  with **12 dp** right margins. D-pad LEFT/RIGHT moves between cards (the
  scroller follows the focused card). End stops: LEFT past the first card
  and RIGHT past the last go nowhere.
- **Poster card:** **150 dp wide** TV (120 phone), poster **150×225 dp**
  (2:3), title **14 sp bold** (max 2 lines) with 6 dp top margin, year
  **12 sp** `muted2` + `" · HINDI"` when Hindi-dubbed. Card padding 4 dp,
  glass background, focus scale 1.03×. First **8 cards** (TV) load eagerly,
  the rest on a background pool.
- **See All:** opens a full vertical list of rows over the tab; Back returns
  to the tab. Status: `"<Title> — <N> movies"`.
- **Movie row** (search results, tabs, See All): min height **96 dp** TV
  (88 phone), padding 14/10, glass, elevation 3 dp. Poster **60×90 dp** TV,
  title **17 sp bold** (max 2 lines), year **13 sp** `muted2`, **HINDI**
  badge (11 sp bold white on cyan, radius 8, padding 10/4) and **SERIES**
  badge (same, purple `#8B5CFF`, 8 dp left margin) at the right, then a
  **heart icon button** (44 dp, glass radius 12; red `#BC334B` when favorite,
  `muted` otherwise). D-pad RIGHT from the row reaches the heart; UP/DOWN
  from the heart go to neighbouring rows. Back from details returns focus
  to the row it came from.

### 7.5 Genres tab

- **15 genre chips:** Action, Adventure, Animation, Comedy, Crime,
  Documentary, Drama, Family, Fantasy, Horror, Mystery, Romance, Sci-Fi,
  Thriller, War. Default genre **Action**. Each loads up to 20 movies of
  that genre, newest first.
- **Quick-search chips:** Marvel, DC, Bollywood, Punjabi, Action, Comedy —
  one tap runs a real search for that term.
- Focus chain (explicit): genre chips DOWN → quick chips → first result row;
  quick chips UP → selected genre chip.
- Status: `"Genre chunein — us genre ki movies neeche aayengi."` /
  `"<Genre> — <N> movies"`.

### 7.6 Details screen

Layout (single scrolling column, no poster image — text-only header):

1. **Title** — **24 sp bold** `textColor`.
2. **Meta** — **15 sp** `muted`, `" · "`-joined, only non-empty parts:
   movie: `year · <duration e.g. "1h 30m"> · ★ <rating> · <up to 3 genres>`;
   series: `year · ★ <rating> · <genres> · Series` (no runtime).
3. **Description** — **15 sp** `muted`; description, then blank line,
   `"Director: …"`, blank line, `"Cast: …"`. Top margin 8 dp, bottom 12 dp.
4. **Season row (series only):** label `"Season"` (15 sp bold) + horizontal
   `chip()`s (`"Season 1"`, …), 8 dp gaps. Hidden for movies.
5. **Episode grid (series only):** label `"Episodes"` (15 sp bold) +
   compact number buttons — just the number (`"1"`, `"2"`, …), **8 per row
   on TV** (5 on phone), 8 dp gaps between buttons and rows.
   Button: `episodeNumberButton` — **16 sp bold**, min **64×48 dp** TV
   (56×44 phone), padding 10/8, radius 12, glass; focused = cyan 2 dp ring;
   selected = gradient pill + white text. Tapping loads that episode's
   streams; the episode title shows in the status line
   (`"E3 · <title> load ho raha hai…"`). Status when a season opens:
   `"<N> episodes — episode chunein."`
6. **Quality row (movies only):** label `"Quality"` (15 sp bold) + chips
   (`"1080p"`, `"720p"`, … sorted descending; `"Auto"` if no resolution is
   reported). Default: the **highest** quality. Series hide this row entirely
   — best quality is the default and switching happens in the player.
7. **Status line** — 15 sp `muted`, e.g. `"Stream ready hai · 282 MB —
   Play dabayein."` / `"<N> qualities available · 282 MB — Play dabayein."`
8. **Play button** — full width, **18 sp bold** white, play icon + 8 dp gap,
   min height **56 dp** TV (52 phone), gradient pill radius 28; focused =
   glass + cyan 3 dp ring; pressed = glass + cyan 2 dp; disabled = glass.
   Disabled until streams load; then it takes focus if the user is still on Fav.
9. **Action row** — three equal-width buttons in one row, **56 dp** tall TV
   (52 phone), 8 dp gaps: **Favorite** (heart icon; filled red when favorite),
   **Download** (mobile only — hidden on TV), **Back** (arrow icon, returns
   to the list). Top margin 8 dp; Play has 12 dp top margin.
- **No Audio row** on details (since v2.0.5): dub/audio selection lives in
  the player (Audio button).
- **Focus landing:** opening details focuses the Fav button (always enabled);
  Play takes focus once streams load.
- **Play flow:** Play closes the Movies browser and plays fullscreen in the
  main player (same ExoPlayer). Back from playback returns here if the
  details were rendered, else to Live TV. Continue Watching resumes open
  details directly (no re-render needed).

### 7.7 Series playback extras

- **Prev/Next** in the player bar (see §4.3); **Up Next** card in the last
  20 s with a 10 s auto-play countdown (see §4.3).
- Next-episode streams are pre-resolved in the background while the current
  episode plays (prefetch).
- The episode number stays in the top-bar title (`"The Body • S1:E1"`).
- Subtitles: English only, from a separate caption endpoint at play time;
  hidden entirely for titles with no captions.

---

## 8. M3U analysis — `verified-channels.m3u`

109 channels, 109 `#EXTINF` lines, 109 URLs, **no duplicate names**.
Every entry carries `tvg-country`, `tvg-language`, `tvg-logo`, `group-title`.

### 8.1 Categories (`group-title`) with counts

| group-title | Channels | App category it lands in |
|---|---|---|
| General | **82** | General |
| News | **10** | News |
| Sports | **9** | Sports |
| Kids | **3** | Kids |
| Islamic | **2** | Islamic |
| Drama | **2** | General (no own category) |
| Music | **1** | General (no own category) |

So the TV categories pane shows: All 109, News 10, Sports 9, Islamic 2,
Kids 3, General 85 (82 + Drama 2 + Music 1).

By country: **PK 48, IN 55, CA 3, MY 1, US 1, AU 1**.
By language: **urd 44, hin 36, pan 23, eng 4, tel 1, urd;pan 1**
(Falak TV is `urd;pan` — the only multi-language entry; the parser splits
`;`-separated groups, so it matches both).

### 8.2 URL schemes

- **https: 96, http: 13.**
- **99 URLs end in `.m3u8`** (mostly `master.m3u8`, `index.m3u8`,
  `playlist.m3u8`, `chunks.m3u8`); **10 have no file extension** (see §8.3).
- Common hosts: `live.msnetworks.net` (many PK channels, `…/master.m3u8`),
  `cdn4.mjunoon.tv:8087` / `vodzong.mjunoon.tv:8087` (`…/streamtest/…/
  chunks.m3u8` or `playlist.m3u8`), `fta.ektv.in`, Akamai
  (`*.akamaized.net`), CloudFront (`*.cloudfront.net`), `tangotv.in`,
  `cdn.rabta.stream`, `cdn.pishow.tv`, `amagi.tv` playouts.
- Non-standard ports in use: **:9981, :4456, :8087, :8080, :8000**.
- Logos: **108 https** URLs, **1 local asset** (`Manoranjan TV` →
  `asset:logo_manoranjan_tv` — the desktop build needs a bundled fallback
  logo for this entry).

### 8.3 Unusual URLs (desktop player must handle these)

1. **YouTube live pages (3)** — not media streams; the app plays them via a
   WebView / `yt-live:` resolver with re-resolve polling:
   - 92 News → `https://www.youtube.com/@92NewsHDtv/live`
   - City 41 → `https://www.youtube.com/@City41/live`
   - Express News → `https://www.youtube.com/@ExpressNewspkofficial/live`
   Desktop needs an embedded web view (or a yt-dlp-style resolver) for these;
   a plain HLS player will fail.
2. **Raw streams with no extension (7)** — plain HTTP, IP hosts with ports:
   - `http://103.86.132.58:9981/stream/channelid/<id>` — MUN TV, ARUJ TV,
     ARY Zindagi, ARY Musik
   - `http://175.107.244.52:4456/play/a06i|a02z|a06z` — Geo Kahani,
     Aaj Entertainment, Geo Super
   - Plus `http://116.90.120.149:8000/play/a0s8/index.m3u8` (Discover Pakistan)
     and `http://146.59.253.52:8080/hindihitshd/index.m3u8` (Hindi Hits SD)
     and `http://cdn12.henico.net:8080/live/sadatv/index.m3u8` (SADA TV)
     and `http://cdn6.live247stream.com/gaundapunjab/tv/playlist.m3u8`
     (Gaunda Punjab TV) — all **plain http**, so the desktop build must
     allow insecure (non-TLS) streams; a strict HTTPS-only policy breaks
     13 channels.
3. **Signed token URLs (3)** — Akamai `hdnts` query strings with a shared
   token (`st=1735898689~exp=1835898688~acl=*~hmac=…`):
   Boogle Bollywood, Wah Punjabi, WOW Kidz. They must be passed to the
   player **verbatim, query string included**. Note the token has an expiry
   (`exp=1835898688` ≈ 2028) — if playback fails after that date, the M3U
   needs a refresh, not a player fix.
4. **SMIL URLs (4)** — `…/smil:<name>.smil/playlist.m3u8` on Akamai/YuppTV
   origins (Boogle Bollywood, Wah Punjabi, WOW Kidz, Okey — Okey also has
   `?id=3`).
5. **GitHub-hosted playlists (3)** — `raw.githubusercontent.com/
   amazeyourself/adaptive-streams/…/*.m3u8` (Colors, Colors Cineplex,
   Zee Cinema APAC). These are indirection playlists, not direct streams.
6. **DVR playlist** — Hum TV uses `playlist_dvr.m3u8` (5centscdn) — a DVR
   window exists; the app deliberately ignores DVR seek on live channels
   (seek bar is movies-only).

---

## 9. Open questions / things NOT in the code (do not guess)

1. **Exact font:** no custom font is declared; the desktop build should use
   the system sans and visually verify against the TV screenshots.
2. **Channel logos:** loaded at runtime from the `tvg-logo` URLs (108 https +
   1 local asset). No bundled logo set exists in the repo besides the one
   `asset:logo_manoranjan_tv` reference; the desktop build needs its own
   disk cache + letter-tile fallback (first letter, `glassHi` fill).
3. **Movies data source:** movies/series come from a network API (MovieBox)
   at runtime — no static catalogue in the repo. The desktop build reuses
   the same API calls (`MovieBox.kt` / `MovieBoxFeeds.kt`), it cannot ship
   a static list.
4. **Update flow:** the header "Update" button checks GitHub releases and
   downloads an APK — desktop needs its own updater (out of scope for the
   UI spec).
5. **Xtream / Playlists / Import M3U:** header actions open dialogs/flows
   (`PlaylistDialogs.kt`, `Xtream.kt`) whose exact UI was not in the files
   read; they are secondary to the TV/desktop port and need a separate pass.
6. **Volume UI:** there is no volume slider in the player bar (the old one
   was removed with the tiles); volume is a system/remote concern on TV.
   Desktop should map volume to keyboard/system volume, not invent a slider.
7. **Playback speed:** lives in the overlay pill for movies only (per a code
   comment) — no visible speed control was found in the files read; verify
   before porting.
8. **Subtitle styling edge cases:** subtitle size options are fixed at
   16/20/24 sp; the subtitle bottom-padding fractions (0.20 with controls,
   0.03 without) are ExoPlayer `SubtitleView` behavior to reproduce.
