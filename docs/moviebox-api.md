# MovieBox API — JavaScript-ready spec

Source of truth (read verbatim, do not modify):
- `~/workspace/iptv-fix/app/src/main/kotlin/com/sadique/iptv/MovieBox.kt` (1075 lines)
- `~/workspace/iptv-fix/app/src/main/kotlin/com/sadique/iptv/MovieBoxSeries.kt` (446 lines)
- `~/workspace/iptv-fix/app/src/main/kotlin/com/sadique/iptv/MovieFeed.kt` (36 lines)
- `~/workspace/iptv-fix/app/src/main/kotlin/com/sadique/iptv/MovieBoxFeeds.kt` (212 lines)

> Scope note: this spec covers ONLY what those four files do. Anything the
> Kotlin code does not show (e.g. the byte format of an `.srt` file, the
> server-side meaning of a field) is marked **UNCLEAR — not in code** rather
> than guessed. All Kotlin snippets below are copied verbatim.

---

## 0. How the client works at a glance

From the file header of `MovieBox.kt`:

```kotlin
/**
 * MovieBox movie + series resolver (v2.0.27 adds series).
 *
 * MovieBox is an aggregator: it hosts nothing, it resolves a playable file
 * per title at play time. Its links are signed and expire within hours, so
 * they can never sit in a static M3U file — this client resolves them live,
 * the way the MovieBox app itself does, using the same signed API the
 * open-source MovieBox-TUI client (mesamirh/MovieBox-Tui, v0.1.29)
 * documents. Flow verified live from this sandbox 2026-11-18 (visitor
 * login, search, play-info, details/resourceDetectors).
 *
 * How a movie becomes playable:
 *  1. Visitor login (no account) → JWT, valid 7 days, kept in prefs.
 *  2. Search → subjects (movies + series with hasResource only; adult
 *     and CAM titles filtered out).
 *  3. Details → dubs (Hindi is usually a separate subject), subtitles,
 *     resourceDetectors (the real signed mp4 files, one per resolution).
 *  4. play-info/v2 → DASH manifest (decoded from the signCookie policy) or
 *     a direct file; resource list + resource-position/v2 recovers files
 *     whose listing link is only the placeholder clip.
 *  5. The old resource/play-info endpoints often return a 22-second
 *     "upgrade" placeholder clip (macdn.aoneroom.com/other/…mp4) — those
 *     URLs are filtered out everywhere (isDeprecationNoticeUrl).
 *
 * All requests are signed (HMAC-MD5 x-tr-signature, x-client-token,
 * x-client-build) and rotate across 7 hosts with backoff on 429. All
 * signing/endpoint code lives in this one file, so an API change is a
 * one-file fix.
 *
 * Only HttpURLConnection + org.json + javax.crypto — no new dependency.
 * Every method here is blocking: callers must run it off the main thread.
 */
```

Key consequences for a JS re-implementation:

- Every signed mobile-API call needs a fresh visitor JWT (Section 2) plus
  per-request HMAC-MD5 signing (Section 3). The H5 web endpoints
  (Sections 5.5, 6) need **no** signing and **no** JWT — only `User-Agent`,
  `Accept: application/json` and a `Referer`.
- Resolved video URLs are signed and expire within hours — never cache
  them across sessions; resolve at play time.
- All signed calls are blocking in Kotlin (8 s connect / 15 s read
  timeouts, 4 MB response cap — see Section 9).

---

## 1. Base hosts / URLs

### 1.1 Mobile API — path prefix

```kotlin
internal const val BASE = "/wefeed-mobile-bff"
```

`BASE` is a **path prefix only**, not a full URL. Every signed endpoint is
`HOST + BASE + <endpoint-path>`, e.g. `https://api6.aoneroom.com/wefeed-mobile-bff/subject-api/search/v2`.

### 1.2 Mobile API — the 7 hosts (in rotation order)

```kotlin
private val HOSTS = arrayOf(
    "https://api6.aoneroom.com",
    "https://api5.aoneroom.com",
    "https://api4.aoneroom.com",
    "https://api4sg.aoneroom.com",
    "https://api3.aoneroom.com",
    "https://api6sg.aoneroom.com",
    "https://api.inmoviebox.com",
)
```

Rotation / retry behaviour is in Section 10.1. There is no single
canonical host; the client tries them in order starting at
`activeHostIdx` (initially `0`), wrapping modulo 7.

### 1.3 Website H5 API — two different web hosts

There are **two distinct web hosts** in the code — do not conflate them:

| Use | Host / base | In code |
|---|---|---|
| H5 play endpoint (series fallback) | `https://vidiomoviebox.xyz/wefeed-h5api-bff/subject/play` | `MovieBoxSeries.kt`, `h5PlayStreams()` |
| Caption endpoint | `https://themoviebox.xyz/wefeed-h5api-bff/subject/caption` | `MovieBox.kt`, `englishCaptionUrl()` |
| Detail page (Referer target) | `https://themoviebox.xyz/movies/<detailPath>?id=<subjectId>&type=/movie/detail&detailSe=&detailEp=&lang=en` | `MovieBox.kt`, `detailPageUrl()` |
| H5 player page (Referer for H5 play) | `https://vidiomoviebox.xyz/player/<detailPath>` | `MovieBoxSeries.kt`, `h5PlayStreams()` |

> **DISCREPANCY — task brief vs code:** the task brief cites the caption
> endpoint as `GET https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/caption?...`.
> The code does **not** use `h5-api.aoneroom.com` anywhere. It uses
> `https://themoviebox.xyz/wefeed-h5api-bff/subject/caption`. The
> `h5-api.aoneroom.com` host appears only in a memory note (2026-11-23),
> not in the source. For a JS re-implementation, use the code's host
> (`themoviebox.xyz`); treat `h5-api.aoneroom.com` as unverified.

### 1.4 Stream Referer (movies)

```kotlin
private const val STREAM_REFERER = "https://sportslive.wine"
```

Used only for play-info streams (Section 5.2). Series file requests use
the detail-page URL instead (Section 5.4 / 8).

---

## 2. Visitor login (no account) → JWT

### 2.1 Endpoint

```kotlin
private fun ensureToken(): String {
    if (cachedToken.isNullOrBlank() && !loadSession()) {
        val data = requestHosts("POST", "$BASE/user-api/visitor-login", "{}", null)
        val token = data.optString("token").orEmpty()
        if (token.isBlank()) throw IOException("MovieBox login failed: no token.")
        saveSession(token)
    }
    return cachedToken!!
}
```

- **Method:** `POST`
- **Full URL:** `<one of the 7 hosts>/wefeed-mobile-bff/user-api/visitor-login`
  (e.g. `https://api6.aoneroom.com/wefeed-mobile-bff/user-api/visitor-login`)
- **Body:** the literal string `"{}"` (an empty JSON object), sent as
  `application/json`.
- **Auth header:** **none** — `token` is `null` for this call, so no
  `Authorization` header is sent. The call **is** still signed
  (Section 3): `signedHeaders()` runs with `token == null`.
- **Host rotation:** goes through `requestHosts()` (Section 10.1), so it
  rotates hosts and retries on 403/406/407/429/500/502/503/504 exactly
  like any other call.

### 2.2 Token response shape

The code reads only one field from the response `data` object:

```kotlin
val token = data.optString("token").orEmpty()
```

`requestHosts()` already unwraps the envelope (Section 10.1): it parses
the whole JSON body, checks `code == 0`, and returns
`json.optJSONObject("data") ?: json`. So the login response is expected
to be:

```json
{
  "code": 0,
  "message": "<string, ignored unless code != 0>",
  "data": {
    "token": "<JWT string>"
  }
}
```

No other field of the login response is read by the code. The token is a
JWT — the code proves this by decoding its payload (Section 2.3).

### 2.3 Token storage, expiry, refresh

```kotlin
private fun loadSession(): Boolean {
    val token = prefs.getString(KEY_TOKEN, null).orEmpty()
    if (token.isBlank()) return false
    val exp = prefs.getLong(KEY_TOKEN_EXP, 0)
    val created = prefs.getLong(KEY_TOKEN_CREATED, 0)
    val now = System.currentTimeMillis() / 1000
    val valid = if (exp > 0) now + 60 < exp else now < created + 7 * 24 * 3600
    if (!valid) return false
    cachedToken = token
    return true
}

private fun saveSession(token: String) {
    val exp = parseJwtExp(token)
    val now = System.currentTimeMillis() / 1000
    prefs.edit()
        .putString(KEY_TOKEN, token)
        .putLong(KEY_TOKEN_EXP, exp)
        .putLong(KEY_TOKEN_CREATED, now)
        .apply()
    cachedToken = token
}

private fun clearSession() {
    cachedToken = null
    prefs.edit()
        .remove(KEY_TOKEN).remove(KEY_TOKEN_EXP).remove(KEY_TOKEN_CREATED)
        .apply()
}

private fun parseJwtExp(token: String): Long {
    return try {
        val parts = token.split(".")
        if (parts.size < 2) return 0
        val payload = String(Base64.decode(parts[1], Base64.URL_SAFE), Charsets.UTF_8)
        JSONObject(payload).optLong("exp", 0)
    } catch (_: Exception) {
        0
    }
}
```

Preference keys (Android `SharedPreferences` file `"moviebox"`):

```kotlin
private const val KEY_TOKEN = "mb_token"
private const val KEY_TOKEN_EXP = "mb_token_exp"
private const val KEY_TOKEN_CREATED = "mb_token_created"
```

Rules for JS:

- `exp` is read from the JWT payload's `exp` claim (second dot-segment,
  base64url-decoded, JSON-parsed, `exp` as seconds-since-epoch). If the
  JWT has no usable `exp` (`0`), fall back to **7 days from creation**
  (`created + 7 * 24 * 3600`).
- A token is valid only if `now + 60 < exp` (60-second safety margin) or,
  in the no-`exp` fallback, `now < created + 7 days`. Otherwise re-login.
- The file header says the JWT is "valid 7 days".
- On HTTP 401 or API `code == 441`, the session is cleared and the
  request is retried once with a fresh login (Section 10.1).
- Additionally, the server may push a **new token in a response header**
  (Section 2.4) — the client absorbs it and overwrites the stored token.

### 2.4 Token refresh via the `x-user` response header

```kotlin
private fun absorbXUser(headers: Map<String, String>) {
    val raw = headers["x-user"].orEmpty()
    if (raw.isEmpty()) return
    val token = try {
        JSONObject(raw).optString("token", "")
    } catch (_: Exception) {
        ""
    }
    if (token.isNotEmpty() && token != cachedToken) saveSession(token)
}
```

- After **every** signed call, if the response carries an `x-user`
  header, it is parsed as JSON and its `token` field (if non-empty and
  different from the cached token) replaces the stored session
  (including re-parsing `exp` and resetting `created` to now).
- Header names are lower-cased before lookup
  (`it.key.lowercase(Locale.US)` in `httpCall`), so match `x-user`
  case-insensitively in JS.
- **UNCLEAR — not in code:** when the server sends `x-user`, or whether
  the new token has a different expiry. The code just trusts it.

---

## 3. Request signing — the full algorithm

This is the heart of the mobile API. Every signed call (including the
visitor login, which has no JWT yet) goes through `signedHeaders()` →
`sign()` → `canonicalString()` + `buildTag()`. All three functions are
quoted verbatim below.

### 3.1 The signed headers (exact names and values)

```kotlin
private fun signedHeaders(
    method: String,
    url: String,
    body: String?,
    token: String?,
): Map<String, String> {
    val ts = System.currentTimeMillis()
    val clientToken = "$ts,${md5Hex(ts.toString().reversed().toByteArray(Charsets.UTF_8))}"
    val buildTag = buildTag(ts)
    val signature = sign(method, url, body, ts)
    val headers = mutableMapOf(
        "User-Agent" to USER_AGENT,
        "Accept" to "application/json",
        "Content-Type" to "application/json",
        "Connection" to "keep-alive",
        "x-client-token" to clientToken,
        "x-tr-signature" to signature,
        "x-client-build" to buildTag,
        "x-client-info" to clientInfoJson(buildTag),
        "x-client-status" to "0",
        "x-forwarded-for" to spoofedIp,
    )
    if (!token.isNullOrBlank()) headers["Authorization"] = "Bearer $token"
    return headers
}
```

Header table (names are sent exactly as written here — note the mixed
case; `HttpURLConnection` preserves them):

| Header | Value | Notes |
|---|---|---|
| `User-Agent` | `USER_AGENT` (Section 9.1) | constant |
| `Accept` | `application/json` | constant |
| `Content-Type` | `application/json` | constant, even for GETs with no body |
| `Connection` | `keep-alive` | constant |
| `x-client-token` | `"<ts>,<md5hex>"` | see 3.2 |
| `x-tr-signature` | `"<ts>\|2\|<base64>"` | see 3.3 |
| `x-client-build` | `buildTag(ts)` | see 3.5 |
| `x-client-info` | JSON string (Section 3.6) | embeds the same `buildTag` |
| `x-client-status` | `0` | constant string |
| `x-forwarded-for` | `spoofedIp` | random per client instance, see 9.4 |
| `Authorization` | `Bearer <JWT>` | **only** when a token exists; omitted for visitor login |

`ts` is `System.currentTimeMillis()` — **milliseconds** since epoch, as a
decimal string. The same `ts` is used in `x-client-token`,
`x-tr-signature` and `buildTag` for a given request; generate it once per
request.

### 3.2 `x-client-token`

```kotlin
val clientToken = "$ts,${md5Hex(ts.toString().reversed().toByteArray(Charsets.UTF_8))}"
```

- Take the decimal `ts` string, **reverse its characters**
  (e.g. `1764051234567` → `7654321504671`).
- MD5-hash the reversed string as UTF-8 bytes, hex-encode lowercase
  (Section 3.7).
- Value: `"<ts>,<md5hex>"` — a comma, no spaces.

JS equivalent:

```js
const ts = Date.now().toString();
const clientToken = `${ts},${md5Hex(Buffer.from([...ts].reverse().join(''), 'utf8'))}`;
```

### 3.3 `x-tr-signature` — HMAC-MD5

```kotlin
private fun sign(method: String, url: String, body: String?, ts: Long): String {
    val canonical = canonicalString(method, url, body, ts)
    val mac = Mac.getInstance("HmacMD5")
    mac.init(SecretKeySpec(SECRET_BYTES, "HmacMD5"))
    val sig = Base64.encodeToString(
        mac.doFinal(canonical.toByteArray(Charsets.UTF_8)),
        Base64.NO_WRAP,
    )
    return "$ts|2|$sig"
}
```

- Algorithm: **HMAC-MD5** (`"HmacMD5"`).
- Key: `SECRET_BYTES` — the 30-byte array in Section 3.4 (raw bytes, not
  a hex/base64 string).
- Message: the canonical string from Section 3.5, UTF-8 encoded.
- Output encoding: **standard Base64, NO_WRAP** — i.e. plain base64 with
  `=` padding, no line breaks. In Node.js: `hmac.digest('base64')`.
  It is **not** hex and **not** base64url.
- Final header value: `"<ts>|2|<base64-signature>"` — pipe-separated,
  the middle field is the literal `2`.

JS equivalent:

```js
import crypto from 'node:crypto';
const sig = crypto.createHmac('md5', Buffer.from(SECRET_BYTES))
  .update(canonical, 'utf8').digest('base64');
const xTrSignature = `${ts}|2|${sig}`;
```

### 3.4 `SECRET_BYTES` — the HMAC key (exact, verbatim)

```kotlin
// HMAC-MD5 key, from the canonical MovieBox-TUI client
// (mesamirh/MovieBox-Tui) — the same 30-byte secret in both repos.
private val SECRET_BYTES = byteArrayOf(
    0xef.toByte(), 0xa8.toByte(), 0x91.toByte(), 0x97.toByte(),
    0x4e.toByte(), 0xec.toByte(), 0xd3.toByte(), 0x14.toByte(),
    0x8d.toByte(), 0xf6.toByte(), 0x3a.toByte(), 0xa6.toByte(),
    0x11.toByte(), 0x60.toByte(), 0x2d.toByte(), 0xef.toByte(),
    0xd1.toByte(), 0x01.toByte(), 0x25.toByte(), 0x9b.toByte(),
    0xa5.toByte(), 0x21.toByte(), 0x02.toByte(), 0x2c.toByte(),
    0x57.toByte(), 0xae.toByte(), 0x05.toByte(), 0x66.toByte(),
    0xbd.toByte(), 0x8e.toByte(),
)
```

30 bytes, in order, as hex:

```
ef a8 91 97 4e ec d3 14 8d f6 3a a6 11 60 2d ef
d1 01 25 9b a5 21 02 2c 57 ae 05 66 bd 8e
```

JS literal:

```js
const SECRET_BYTES = Buffer.from([
  0xef, 0xa8, 0x91, 0x97, 0x4e, 0xec, 0xd3, 0x14,
  0x8d, 0xf6, 0x3a, 0xa6, 0x11, 0x60, 0x2d, 0xef,
  0xd1, 0x01, 0x25, 0x9b, 0xa5, 0x21, 0x02, 0x2c,
  0x57, 0xae, 0x05, 0x66, 0xbd, 0x8e,
]);
```

### 3.5 `canonicalString` — the exact signed message

```kotlin
private fun canonicalString(method: String, url: String, body: String?, ts: Long): String {
    val (path, query) = try {
        val uri = URI(url)
        uri.rawPath.orEmpty() to uri.rawQuery.orEmpty()
    } catch (_: Exception) {
        url to ""
    }
    val sorted = sortedQuery(query)
    val canonicalUrl = if (sorted.isEmpty()) path else "$path?$sorted"
    val (bodyHash, bodyLength) = if (body != null) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val truncated = if (bytes.size > 102400) bytes.copyOf(102400) else bytes
        md5Hex(truncated) to bytes.size.toString()
    } else {
        "" to ""
    }
    return listOf(
        method.uppercase(Locale.US),
        "application/json",
        "application/json",
        bodyLength,
        ts.toString(),
        bodyHash,
        canonicalUrl,
    ).joinToString("\n")
}
```

The canonical string is **7 lines joined with `\n`** (no trailing newline):

```
<HTTP_METHOD_UPPERCASE>
application/json
application/json
<bodyLength>
<ts>
<bodyHash>
<canonicalUrl>
```

Field-by-field:

1. **Method** — upper-cased with US locale, e.g. `GET`, `POST`.
2. Literal `application/json`.
3. Literal `application/json` (again — the code repeats it; this is not a
   typo in this spec, it is in the source twice).
4. **bodyLength** — the byte length of the full body as a decimal string
   (`bytes.size.toString()`), **or empty string when `body == null`**
   (GET requests). Note: the length is of the *full* body even when the
   hash is computed over a truncated copy.
5. **ts** — the same millisecond timestamp as decimal string.
6. **bodyHash** — lowercase hex MD5 of the body UTF-8 bytes, **truncated
   to the first 102400 bytes** if the body is longer
   (`bytes.copyOf(102400)`); **empty string when `body == null`**.
7. **canonicalUrl** — path + sorted query (see below). The URL used here
   is the **full request URL including host** (e.g.
   `https://api6.aoneroom.com/wefeed-mobile-bff/subject-api/search/v2`),
   but only its `rawPath` and `rawQuery` survive: the scheme/host are
   discarded. If URI parsing fails, the whole URL string is used as the
   path and the query is empty.

Query sorting (`sortedQuery`):

```kotlin
private fun sortedQuery(rawQuery: String): String {
    if (rawQuery.isEmpty()) return ""
    return rawQuery.split("&").mapNotNull { part ->
        val eq = part.indexOf('=')
        if (eq < 0) return@mapNotNull null
        urlDecode(part.substring(0, eq)) to urlDecode(part.substring(eq + 1))
    }.sortedBy { it.first }.joinToString("&") { (k, v) -> "$k=$v" }
}
```

- Split the raw query on `&`; drop any part with no `=` in it.
- URL-decode key and value (Java `URLDecoder.decode(..., "UTF-8")` —
  i.e. `+` decodes to a space, `%XX` decodes; on decode failure the
  original string is kept).
- Sort by **key only** (stable sort; duplicate keys keep their original
  relative order — Kotlin `sortedBy` is stable).
- Re-join as `key=value` pairs with `&`. Values are **not** re-encoded —
  the decoded values are placed raw into the canonical URL.

Example (GET search details):

```
GET
application/json
application/json

1764051234567

/wefeed-mobile-bff/subject-api/get?subjectId=abc123
```

Example (POST search, body `{"keyword":"the body","page":1,"perPage":15,"subjectType":0}`):

```
POST
application/json
application/json
62
1764051234567
<md5hex of the exact body bytes>
/wefeed-mobile-bff/subject-api/search/v2
```

> JS pitfall: `bodyLength`/`bodyHash` must be computed from the exact
> bytes that are sent. `JSON.stringify()` in JS must produce the same
> string the Kotlin `JSONObject.toString()` produces (compact, no spaces,
> insertion order). The Kotlin code builds bodies with `JSONObject.put`
> in a fixed order — replicate that exact key order and compact form
> (see each endpoint's body in Sections 4–7).

### 3.6 `buildTag` — `x-client-build`

```kotlin
private fun buildTag(ts: Long): String {
    val stamp = "${ts / 1000}${String.format(Locale.US, "%03d", ts % 1000)}000${Random.nextInt(1000)}"
    val hash = md5Hex((CERT_SHA256 + "oneroom" + stamp).toByteArray(Charsets.UTF_8))
    return "$stamp.$hash"
}
```

With:

```kotlin
private const val CERT_SHA256 =
    "03d4b741632d136bc23e2de4c6adcdb7712f1980b619c183221801730bbd0410"
```

- `stamp` = `<ts/1000 as integer seconds>` + `<ts%1000 zero-padded to 3 digits>` + literal `000` + `<random integer 0..999, NOT zero-padded>`.
  Example: `ts = 1764051234567` → seconds `1764051234`, ms `567` →
  stamp starts `1764051234567000` + e.g. `42` → `176405123456700042`.
  Note the stamp is a plain concatenation, not a formatted timestamp.
- `hash` = lowercase hex MD5 (UTF-8) of the string
  `CERT_SHA256 + "oneroom" + stamp`, i.e.
  `"03d4b741632d136bc23e2de4c6adcdb7712f1980b619c183221801730bbd0410oneroom<stamp>"`.
- Return value: `"<stamp>.<hash>"` — a dot separates stamp and hash.
- `Random.nextInt(1000)` is Kotlin's `kotlin.random.Random` — in JS use
  `Math.floor(Math.random() * 1000)` (0–999 inclusive). The value is
  **not** zero-padded, so stamps vary in length (3–5 trailing digits
  after the fixed `000`).
- The same `buildTag` value is sent as `x-client-build` **and** embedded
  in `x-client-info` as `"X-Client-Build":"<buildTag>"` (Section 3.7).

### 3.7 `x-client-info` JSON

```kotlin
private fun clientInfoJson(buildTag: String): String =
    "{\"package_name\":\"com.community.oneroom\",\"version_name\":\"3.0.03.0529.03\"," +
        "\"version_code\":50020044,\"os\":\"android\",\"os_version\":\"11\",\"install_ch\":\"ps\"," +
        "\"device_id\":\"$deviceId\",\"install_store\":\"ps\",\"gaid\":\"$gaid\",\"brand\":\"Redmi\"," +
        "\"model\":\"2201117TY\",\"system_language\":\"en\",\"net\":\"NETWORK_WIFI\",\"region\":\"US\"," +
        "\"timezone\":\"Asia/Kolkata\",\"sp_code\":\"40401\",\"X-Play-Mode\":\"2\"," +
        "\"X-Client-Build\":\"$buildTag\"}"
```

The exact JSON string sent (key order as written; no spaces):

```json
{"package_name":"com.community.oneroom","version_name":"3.0.03.0529.03","version_code":50020044,"os":"android","os_version":"11","install_ch":"ps","device_id":"<deviceId>","install_store":"ps","gaid":"<gaid>","brand":"Redmi","model":"2201117TY","system_language":"en","net":"NETWORK_WIFI","region":"US","timezone":"Asia/Kolkata","sp_code":"40401","X-Play-Mode":"2","X-Client-Build":"<buildTag>"}
```

Constants inside it (Section 9): package `com.community.oneroom`,
version `3.0.03.0529.03` / code `50020044`, OS Android 11, brand `Redmi`,
model `2201117TY`, language `en`, net `NETWORK_WIFI`, region `US`,
timezone `Asia/Kolkata`, `sp_code` `40401`, `X-Play-Mode` `2`.
`device_id` and `gaid` are per-install random values (Section 9.3) that
must be persisted across launches.

### 3.8 `md5Hex` helper

```kotlin
private fun md5Hex(bytes: ByteArray): String {
    val digest = MessageDigest.getInstance("MD5").digest(bytes)
    return digest.joinToString("") { String.format(Locale.US, "%02x", it.toInt() and 0xff) }
}
```

Lowercase hex MD5, two digits per byte, zero-padded. JS:
`crypto.createHash('md5').update(bytes).digest('hex')`.

---

## 4. Search and subject details

### 4.1 Search — `POST /wefeed-mobile-bff/subject-api/search/v2`

```kotlin
private fun searchPage(query: String, page: Int): List<Movie> {
    val body = JSONObject().apply {
        put("keyword", query)
        put("page", page)
        put("perPage", 15)
        put("subjectType", 0)
    }.toString()
    val data = request("POST", "$BASE/subject-api/search/v2", body)
    val results = data.optJSONArray("results") ?: return emptyList()
    val movies = mutableListOf<Movie>()
    for (i in 0 until results.length()) {
        val subjects = results.optJSONObject(i)?.optJSONArray("subjects") ?: continue
        for (j in 0 until subjects.length()) {
            parseSearchMovie(subjects.optJSONObject(j))?.let { movies += it }
        }
    }
    return movies
}
```

- **Body** (exact key order, compact JSON):
  `{"keyword":"<query>","page":<page>,"perPage":15,"subjectType":0}`
  `subjectType: 0` means "all types" in the request; the response is
  filtered client-side to types 1 and 2 (Section 4.3).
- **Response shape** (after the `data` envelope is unwrapped):

```json
{
  "results": [
    { "subjects": [ { "<subject object>" }, "..." ] },
    "..."
  ]
}
```

  `data.results` is an array of groups; each group has a `subjects`
  array. Missing `results` → empty list. Groups without `subjects` are
  skipped.

- **Client-side pagination wrapper** (`search()`):

```kotlin
fun search(query: String, page: Int = 1): List<Movie> {
    // The API ranks exact matches first and pages at 15: a related
    // title ("Sardar Ji" for "sardar") can sit on page 2-3, so fetch
    // up to 3 pages, dedupe, and rank substring matches first
    // (stable — the API order survives inside each group).
    val seen = mutableSetOf<String>()
    val all = mutableListOf<Movie>()
    for (p in page..page + 2) {
        val batch = searchPage(query, p)
        for (movie in batch) {
            if (seen.add(movie.subjectId)) all += movie
        }
        if (batch.size < 15) break
    }
    val q = query.lowercase()
    return all.sortedWith(compareByDescending { it.title.lowercase().contains(q) })
}
```

  Fetches up to 3 pages starting at `page` (default 1), stops early
  when a page returns fewer than 15 items, dedupes by `subjectId`,
  then stable-sorts so titles containing the (lower-cased) query come
  first.

### 4.2 Subject details — `GET /wefeed-mobile-bff/subject-api/get`

```kotlin
fun details(subjectId: String): Details {
    val data = request("GET", "$BASE/subject-api/get?subjectId=${urlEncode(subjectId)}", null)
    val subject = data.optJSONObject("subject") ?: data
    ...
}
```

- **Method:** `GET`, no body. `subjectId` is URL-encoded with Java
  `URLEncoder.encode(value, "UTF-8")` (so spaces become `+`; see
  Section 9.5).
- **Response shape:** `data.subject` if present, otherwise `data`
  itself is treated as the subject object. The subject object fields
  read by the code:

| Field (fallbacks in order) | Meaning / use |
|---|---|
| `subjectId` / `id` (string or number, via `idString`) | title id |
| `title` (default `"Unknown"`) | title |
| `subjectType` / `stype` (default `1`) | `1` = movie, `2` = series (`isSeries = stype == 2`) |
| `releaseDate` / `year` | year extracted by regex `(19\|20)\d\d` (first match) |
| `cover.url` / `coverUrl` / `poster` / `pic` | poster URL |
| `genre` / `genres` (array or comma-separated string) | genre list; adult genres block the title |
| `description` / `intro` | synopsis |
| `imdbRatingValue` / `rating` (number → `"%.1f"` US locale; string as-is) | rating string |
| `director` | director |
| `stars` | cast |
| `duration` (number or numeric string, via `longValue`) | runtime in seconds (`durationSec`) |
| `dubs` (array) | see below |
| `resourceDetectors` (on `data` first, then on `subject`) | stream sources (Section 5.1) |
| `detailUrl` | web slug source — see `detailPath` below |

- **Dubs** — each element of `subject.dubs`:

```kotlin
val dubsArr = subject.optJSONArray("dubs")
if (dubsArr != null) {
    for (i in 0 until dubsArr.length()) {
        val d = dubsArr.optJSONObject(i) ?: continue
        val dubId = idString(d, "subjectId", "id").orEmpty()
        if (dubId.isEmpty()) continue
        val language = d.optString("lanName", d.optString("language", d.optString("lang", "Unknown")))
        val label = d.optString("title", d.optString("name", language))
        dubs += Dub(dubId, language, label)
    }
}
```

  A dub is `{ subjectId, language, label }` where `language` is
  `lanName`/`language`/`lang` and `label` is `title`/`name`/language.
  Hindi is usually a **separate subject** (a dub entry points at another
  `subjectId`).

- **`detailPath`** — the web slug, derived from `detailUrl`:

```kotlin
val detailPath = subject.optString("detailUrl", "")
    .substringAfterLast("/").substringBefore("?").trim()
```

  e.g. `detailUrl = ".../the-body-hindi-AMlsju1DK46"` →
  `detailPath = "the-body-hindi-AMlsju1DK46"`. This slug is required for
  the H5 play endpoint and the caption endpoint (Sections 5.5, 6).
  If `detailUrl` is absent, `detailPath` is `""` and the H5/caption
  steps are skipped.

- **Detail page URL** (built from `detailPath`, used as a Referer):

```kotlin
internal fun detailPageUrl(subjectId: String, detailPath: String): String =
    "https://themoviebox.xyz/movies/$detailPath?id=$subjectId&type=/movie/detail&detailSe=&detailEp=&lang=en"
```

  Note: `type=/movie/detail` is sent literally (the `/` is **not**
  percent-encoded), and `detailSe` / `detailEp` are empty. `subjectId`
  and `detailPath` are interpolated raw (not URL-encoded) here.

- **Returned `Details` model:**

```kotlin
data class Details(
    val movie: Movie,
    val description: String = "",
    val rating: String = "",
    val director: String = "",
    val stars: String = "",
    val durationSec: Long = 0,
    val genres: List<String> = emptyList(),
    val dubs: List<Dub> = emptyList(),
    val subtitles: List<Subtitle> = emptyList(),
    internal val detectors: JSONArray? = null,
    val detailPath: String = "",
)
```

  `subtitles` here come from `parseSubtitles(detectors)` — the
  `extCaptions` inside `resourceDetectors` (see Section 6.3). These are
  **not** the English caption used by the player; the player uses the
  caption endpoint (Section 6).

### 4.3 Subject parsing / filtering (`parseSearchMovie`)

Every subject from search, feeds and lists passes through this filter.
A subject is **dropped** (returns `null`) if any of these hold:

```kotlin
internal fun parseSearchMovie(s: JSONObject?): Movie? {
    if (s == null) return null
    val id = idString(s, "subjectId", "id").orEmpty()
    if (id.isEmpty()) return null
    // Movies (subjectType 1) and series (subjectType 2) both show;
    // anything else (shorts, games) is not a title this app plays.
    val stype = s.optLong("subjectType", s.optLong("stype", 1))
    if (stype != 1L && stype != 2L) return null
    if (!s.optBoolean("hasResource", false)) return null
    val title = s.optString("title", s.optString("name", "")).orEmpty()
    if (title.isEmpty()) return null
    if (isCamTitle(title) || isAdultTitle(title)) return null
    val genres = stringList(s, "genre", "genres")
    if (genres.any { isAdultGenre(it) }) return null
    val year = extractYear(
        s.optString("releaseDate", s.optString("year", s.optString("releaseInfo", ""))),
    )
    val poster = s.optJSONObject("cover")?.optString("url", "")
        ?: s.optString("coverUrl", s.optString("poster", s.optString("pic", "")))
    return Movie(
        subjectId = id,
        title = title,
        year = year,
        posterUrl = poster.orEmpty(),
        isHindi = title.contains("hindi", ignoreCase = true),
        isSeries = stype == 2L,
    )
}
```

- Missing/empty id; `subjectType`/`stype` not 1 or 2;
  `hasResource` not `true`; empty title; CAM title; adult title; any
  adult genre.
- The returned `Movie` model:

```kotlin
data class Movie(
    val subjectId: String = "",
    val title: String = "",
    val year: String = "",
    val posterUrl: String = "",
    val isHindi: Boolean = false,
    val isSeries: Boolean = false,
)
```

  `isHindi` is a case-insensitive substring check for `"hindi"` in the
  title. `year` is the first `(19|20)\d\d` match in
  `releaseDate`/`year`/`releaseInfo`, else `""`.

- CAM / adult filters (verbatim):

```kotlin
private val CAM_TITLE_REGEX = Regex(
    "(?i)\\b(cam|hdcam|hdts|hd-ts|camrip|cam-rip|tsrip|telesync|telecine|hdtc|predvd)\\b" +
        "|\\bhd\\s*-?\\s*cam\\b",
)
private val ADULT_TITLE_REGEX = Regex(
    "(?i)\\b(xxx|porn|porno|erotic|erotica|hentai)\\b|\\bsex\\s+tape\\b|18\\+",
)
private val ADULT_GENRES =
    setOf("adult", "erotic", "erotica", "porn", "pornography", "xxx", "hentai")
```

  `isAdultGenre` also matches any genre containing `"adult"`,
  `"erotic"` or `"porn"` (case-insensitive, trimmed). `details()` throws
  `BlockedException("Ye title dikhaya nahi ja sakta.")` for adult/CAM
  titles instead of returning them.

---

## 5. How playable streams are resolved

The resolved-stream model:

```kotlin
data class MovieStream(
    val url: String,
    val resolution: Int = 0,
    val codec: String = "",
    val sizeBytes: Long = 0,
    val durationSec: Long = 0,
    val headers: Map<String, String> = emptyMap(),
    val isDash: Boolean = false,
    val id: String = "",
    val subtitleUrl: String = "",
) {
    val label: String get() = if (resolution > 0) "${resolution}p" else "Auto"
}
```

- `label` is `"1080p"` / `"720p"` / … from `resolution`, or `"Auto"`
  when `resolution == 0`.
- `headers` are the HTTP headers the **player** must send when fetching
  that file (typically `User-Agent`, sometimes `Referer` and `Cookie`).
- `id` is the play-response stream id; only play-info/H5 streams have
  one — it keys the caption lookup (Section 6).
- `subtitleUrl` is filled in afterwards by `attachEnglishCaptions()`.

### 5.1 Source 1 — `resourceDetectors` (primary for movies)

`resourceDetectors` arrives inside the details response (`data` first,
then `subject`). Each detector either has a `resolutionList` array or a
single `downloadUrl`:

```kotlin
// 1. resourceDetectors — the real signed mp4 files (primary source).
val detectors = details.detectors
if (detectors != null) {
    for (i in 0 until detectors.length()) {
        val det = detectors.optJSONObject(i) ?: continue
        val resList = det.optJSONArray("resolutionList")
        if (resList != null && resList.length() > 0) {
            for (j in 0 until resList.length()) {
                parseDetectorItem(resList.optJSONObject(j))?.let { add(it) }
            }
            continue
        }
        // No resolution list — a single downloadUrl entry.
        val downloadUrl = det.optString("downloadUrl", "").orEmpty()
        if (downloadUrl.isEmpty()) continue
        val source = det.optString("resourceLink", "").orEmpty()
        add(
            MovieStream(
                url = downloadUrl,
                resolution = resolutionFromSourceLink(source),
                codec = det.optString("codecName", ""),
                sizeBytes = longValue(det, "firstSize"),
                headers = mapOf("User-Agent" to USER_AGENT),
            ),
        )
    }
}
```

`parseDetectorItem` (movies — skips anything not `se == 0 && ep == 0`):

```kotlin
private fun parseDetectorItem(item: JSONObject?): MovieStream? {
    if (item == null) return null
    // Movies are se 0 / ep 0; skip anything else.
    if (longValue(item, "se") != 0L || longValue(item, "ep") != 0L) return null
    val url = item.optString("resourceLink", item.optString("url", "")).orEmpty()
    if (url.isEmpty() || isDeprecationNoticeUrl(url)) return null
    val title = item.optString("title", item.optString("fileName", "")).orEmpty()
    if (isCamTitle(title)) return null
    return MovieStream(
        url = url,
        resolution = longValue(item, "resolution").toInt(),
        codec = item.optString("codecName", item.optString("codec", "")),
        sizeBytes = longValue(item, "size"),
        durationSec = longValue(item, "duration"),
        headers = mapOf("User-Agent" to USER_AGENT),
    )
}
```

Item fields: `resourceLink`/`url`, `resolution` (int, e.g. 1080),
`codecName`/`codec`, `size` (bytes), `duration` (seconds), `se`/`ep`,
`title`/`fileName`. For the single-`downloadUrl` form, resolution is
guessed from the `resourceLink` string by `resolutionFromSourceLink()`
(see Section 9.5) and size comes from `firstSize`, not `size`.

### 5.2 Source 2 — play-info/v2 (DASH or direct file)

```kotlin
// 2. play-info/v2 — DASH manifest (via signCookie) or a direct file.
try {
    val playInfo = request(
        "GET",
        "$BASE/subject-api/play-info/v2?subjectId=${urlEncode(details.movie.subjectId)}",
        null,
    )
    val playStreams = playInfo.optJSONArray("streams")
    if (playStreams != null) {
        val displayRes = playInfo.optString("displayResolutions", "")
        for (i in 0 until playStreams.length()) {
            parsePlayInfoStream(playStreams.optJSONObject(i), displayRes)?.let { add(it) }
        }
    }
} catch (_: IOException) {
    // play-info is a fallback source — detectors may already have files.
}
```

- **Endpoint (movie):**
  `GET /wefeed-mobile-bff/subject-api/play-info/v2?subjectId=<urlEncoded>`
- **Endpoint (episode):**
  `GET /wefeed-mobile-bff/subject-api/play-info/v2?subjectId=<urlEncoded>&se=<season>&ep=<episode>`
  (Section 8.2).
- **Response shape:**

```json
{
  "streams": [
    {
      "id": "<play stream id — keys captions>",
      "url": "<direct mp4 URL, or a placeholder/notice URL>",
      "signCookie": "<CloudFront/urlprefix cookie string — see 5.2.1>",
      "resolutions": "1080,720,480",
      "codecName": "h264",
      "size": 1234567890,
      "duration": 5400
    }
  ],
  "displayResolutions": "1080,720,480"
}
```

- `parsePlayInfoStream` (verbatim):

```kotlin
internal fun parsePlayInfoStream(stream: JSONObject?, displayResolutions: String): MovieStream? {
    if (stream == null) return null
    val signCookie = stream.optString("signCookie", "").orEmpty()
    val streamUrl = stream.optString("url", "").orEmpty()
    val manifest = resolveDashManifest(signCookie)
    val (url, isDash) = when {
        manifest != null -> manifest to true
        !isDeprecationNoticeUrl(streamUrl) && streamUrl.startsWith("http") -> streamUrl to false
        else -> return null
    }
    val resolutions = stream.optString("resolutions", displayResolutions).orEmpty()
        .split(",").mapNotNull { it.trim().toIntOrNull() }.filter { it > 0 }
    val maxRes = resolutions.maxOrNull() ?: 1080
    val headers = mutableMapOf("Referer" to STREAM_REFERER, "User-Agent" to USER_AGENT)
    if (signCookie.isNotEmpty()) {
        val cleanCookie = signCookie.trimEnd(';').split(';')
            .map { it.trim() }.filter { it.isNotEmpty() }.joinToString("; ")
        headers["Cookie"] = cleanCookie
    }
    return MovieStream(
        url = url,
        resolution = maxRes,
        codec = stream.optString("codecName", stream.optString("codec", "")),
        sizeBytes = longValue(stream, "size"),
        durationSec = longValue(stream, "duration"),
        headers = headers,
        isDash = isDash,
        id = stream.optString("id", "").orEmpty(),
    )
}
```

  Rules:
  - If `signCookie` yields a DASH manifest (Section 5.2.1), the stream
    is DASH (`isDash = true`) and the manifest URL is used — the direct
    `url` is ignored.
  - Otherwise the direct `url` is used if it is non-empty, starts with
    `http`, and is not a notice URL.
  - `resolution` is the **maximum** of the comma-separated `resolutions`
    list (falling back to the top-level `displayResolutions`), defaulting
    to `1080` when the list is empty. A play-info stream therefore
    represents the best quality of that stream entry, not one entry per
    quality.
  - Player headers: `Referer: https://sportslive.wine` and
    `User-Agent: <USER_AGENT>`, plus `Cookie: <signCookie cleaned>` when
    `signCookie` is non-empty. Cookie cleaning: trim trailing `;`,
    split on `;`, trim each part, drop empties, re-join with `"; "`.

#### 5.2.1 DASH manifest from `signCookie`

```kotlin
private fun resolveDashManifest(signCookie: String): String? {
    for (part in signCookie.split(";")) {
        val trimmed = part.trim()
        val urlPrefixIdx = trimmed.indexOf("urlprefix=")
        if (urlPrefixIdx >= 0) {
            val prefixPart = trimmed.substring(urlPrefixIdx + "urlprefix=".length)
            val b64Token = prefixPart.substringBefore(':').trim()
            val normalized = b64Token.map { when (it) { '-' -> '+'; '_' -> '/'; else -> it } }
                .joinToString("")
            val decoded = decodeBase64Padded(normalized) ?: continue
            toDashMpd(String(decoded, Charsets.UTF_8))?.let { return it }
        }
        if (trimmed.startsWith("CloudFront-Policy=")) {
            val policyRaw = trimmed.substring("CloudFront-Policy=".length).trim()
            val normalized = policyRaw.map {
                when (it) { '-' -> '+'; '_' -> '='; '~' -> '/'; else -> it }
            }.joinToString("")
            val decoded = decodeBase64Padded(normalized) ?: continue
            val resource = try {
                JSONObject(String(decoded, Charsets.UTF_8))
                    .optJSONArray("Statement")?.optJSONObject(0)?.optString("Resource", "")
            } catch (_: Exception) {
                null
            }.orEmpty()
            if (resource.isNotEmpty()) toDashMpd(resource)?.let { return it }
        }
    }
    return null
}

private fun toDashMpd(urlStr: String): String? {
    val base = urlStr.trimEnd('*').trimEnd('/')
    if (base.isEmpty()) return null
    if (!base.startsWith("http://") && !base.startsWith("https://")) return null
    if ("/dash/" !in base) return null
    return "$base/index.mpd"
}

private fun decodeBase64Padded(s: String): ByteArray? {
    return try {
        val padded = s + "=".repeat((4 - s.length % 4) % 4)
        Base64.decode(padded, Base64.DEFAULT)
    } catch (_: IllegalArgumentException) {
        null
    }
}
```

- Split `signCookie` on `;`, examine each part:
  - **`urlprefix=`**: take the substring after `urlprefix=`, then the
    part before the first `:`; URL-safe base64 → standard base64
    (`-` → `+`, `_` → `/`); pad with `=` to a multiple of 4; base64-decode;
    interpret as UTF-8; pass to `toDashMpd()`.
  - **`CloudFront-Policy=`**: the value is base64 with a non-standard
    alphabet: `-` → `+`, `_` → `=`, `~` → `/` (verbatim from the code —
    note `_` maps to `=` here, unlike the `urlprefix` branch where `_`
    maps to `/`); pad to a multiple of 4; decode; parse as JSON; take
    `Statement[0].Resource`; pass to `toDashMpd()`.
- `toDashMpd()`: strip trailing `*` characters, then trailing `/`
  characters; reject if empty, not starting with `http://`/`https://`,
  or not containing `/dash/`; otherwise return `"<base>/index.mpd"`.
- First successful part wins; any failure in a part moves to the next.

### 5.3 Source 3 — resource list (+ recovery)

```kotlin
// 3. Resource list (+ recovery for placeholder links).
try {
    val resData = request(
        "GET",
        "$BASE/subject-api/resource?subjectId=${urlEncode(details.movie.subjectId)}&page=1&perPage=20",
        null,
    )
    val items = resData.optJSONArray("list")
    if (items != null) {
        for (i in 0 until items.length()) {
            val item = items.optJSONObject(i) ?: continue
            if (longValue(item, "se") != 0L || longValue(item, "ep") != 0L) continue
            val parsed = parseResourceItem(item)
            if (parsed != null) {
                add(parsed)
                continue
            }
            // Placeholder link — try to recover the real file.
            val link = item.optString("resourceLink", item.optString("url", "")).orEmpty()
            val resourceId = idString(item, "resourceId", "id").orEmpty()
            if (resourceId.isEmpty() || !isDeprecationNoticeUrl(link)) continue
            recoverResource(
                details.movie.subjectId,
                resourceId,
                link,
                longValue(item, "resolution").toInt(),
                item.optString("codecName", item.optString("codec", "")),
                longValue(item, "size"),
            )?.let { add(it) }
        }
    }
} catch (_: IOException) {
    // Same: best-effort fallback.
}
```

- **Endpoint (movie):**
  `GET /wefeed-mobile-bff/subject-api/resource?subjectId=<id>&page=1&perPage=20`
- **Response:** `data.list[]` — items with `resourceLink`/`url`,
  `resourceId`/`id`, `resolution`, `codecName`/`codec`, `size`,
  `duration`, `se`, `ep`, `fileName`/`title`.
- Movies skip any item with `se != 0 || ep != 0`.
- `parseResourceItem` is the same shape as `parseDetectorItem` but
  without the `se`/`ep` check (the caller already filtered):

```kotlin
internal fun parseResourceItem(item: JSONObject): MovieStream? {
    val url = item.optString("resourceLink", item.optString("url", "")).orEmpty()
    if (url.isEmpty() || isDeprecationNoticeUrl(url)) return null
    val title = item.optString("fileName", item.optString("title", "")).orEmpty()
    if (isCamTitle(title)) return null
    return MovieStream(
        url = url,
        resolution = longValue(item, "resolution").toInt(),
        codec = item.optString("codecName", item.optString("codec", "")),
        sizeBytes = longValue(item, "size"),
        durationSec = longValue(item, "duration"),
        headers = mapOf("User-Agent" to USER_AGENT),
    )
}
```

- **Recovery — `resource-position/v2`:**

```kotlin
internal fun recoverResource(
    subjectId: String,
    resourceId: String,
    failUrl: String,
    origResolution: Int,
    origCodec: String,
    origSize: Long,
    season: Int = 0,
    episode: Int = 0,
): MovieStream? {
    val query = listOf(
        "subjectId" to subjectId,
        "resourceId" to resourceId,
        "failUrl" to failUrl,
        "failCode" to "404",
        "resourceNum" to "0",
        "isVip" to "true",
    ).joinToString("&") { (k, v) -> "$k=${urlEncode(v)}" }
    val data = try {
        request("GET", "$BASE/subject-api/resource-position/v2?$query", null)
    } catch (_: IOException) {
        return null
    }
    val items = data.optJSONArray("list") ?: return null
    for (i in 0 until items.length()) {
        val item = items.optJSONObject(i) ?: continue
        if (idString(item, "resourceId", "id").orEmpty() != resourceId) continue
        if (longValue(item, "se").toInt() != season ||
            longValue(item, "ep").toInt() != episode
        ) continue
        val url = item.optString("resourceLink", item.optString("url", "")).orEmpty()
        if (url.isEmpty() || isDeprecationNoticeUrl(url)) continue
        if (!url.startsWith("http")) continue
        val res = longValue(item, "resolution").toInt()
        return MovieStream(
            url = url,
            resolution = if (res > 0) res else origResolution,
            codec = item.optString("codecName", item.optString("codec", origCodec)),
            sizeBytes = longValue(item, "size").takeIf { it > 0 } ?: origSize,
            durationSec = longValue(item, "duration"),
            headers = mapOf("User-Agent" to USER_AGENT),
        )
    }
    return null
}
```

  - **Endpoint:**
    `GET /wefeed-mobile-bff/subject-api/resource-position/v2?subjectId=<id>&resourceId=<id>&failUrl=<urlEncoded>&failCode=404&resourceNum=0&isVip=true`
    (all values URL-encoded with `URLEncoder`; query built in exactly
    this order).
  - Only attempted when the resource-list link **is** a notice URL and a
    `resourceId` exists.
  - The returned `list[]` item must have the **same** `resourceId` and
    matching `se`/`ep` (movies: `0`/`0`; episodes: the requested
    season/episode — see Section 8.2 for the untagged-recovery fallback).
  - Recovered resolution/codec/size fall back to the original item's
    values when the recovered item omits them.

### 5.4 Movie stream ordering, dedupe and the duration filter

```kotlin
fun streams(details: Details): List<MovieStream> {
    val found = mutableListOf<MovieStream>()
    val seen = mutableSetOf<String>()
    fun add(stream: MovieStream) {
        if (stream.url.isEmpty() || !stream.url.startsWith("http")) return
        if (isDeprecationNoticeUrl(stream.url)) return
        val base = stream.url.substringBefore('?')
        if (!seen.add(base)) return
        found += stream
    }
    ...
    if (found.isEmpty()) throw IOException("Is movie ke liye koi playable link nahi mila.")
    val runtime = details.durationSec
    val matched = if (runtime > 0) {
        found.filter { it.durationSec <= 0 || (it.durationSec * 2 >= runtime && it.durationSec * 2 <= runtime * 3) }
    } else {
        found
    }
    val usable = if (matched.isNotEmpty()) matched else found
    val captioned = attachEnglishCaptions(usable, details.movie.subjectId, details.detailPath)
    return captioned.sortedWith(
        compareByDescending<MovieStream> { it.resolution }
            .thenBy { it.isDash } // direct mp4 before DASH at the same resolution
            .thenByDescending { it.sizeBytes },
    )
}
```

- **Dedupe:** by URL stripped of its query string
  (`url.substringBefore('?')`); first occurrence wins. Notice URLs are
  dropped at `add()` time, as are non-`http(s)` URLs.
- **Source order tried:** detectors → play-info/v2 → resource list (+
  recovery). Sources 2 and 3 are best-effort: an `IOException` there is
  swallowed.
- **Duration filter (movies only):** when the known `durationSec` is
  `> 0`, keep streams whose `durationSec` is `<= 0` (unknown) or in the
  range `[runtime/2, runtime*3/2]` — the code writes it as
  `durationSec * 2 >= runtime && durationSec * 2 <= runtime * 3`. If
  that filter empties the list, the unfiltered list is used instead.
  (Rationale in the code: drop entries "whose length wildly mismatches
  the known runtime … when better options exist".)
- **Final sort:** resolution descending, then direct MP4 before DASH at
  the same resolution (`isDash` ascending: `false` < `true`), then
  `sizeBytes` descending.
- **Captions** are attached after filtering/sorting (Section 6.2).
- Episodes use the same `add()`/dedupe/sort but **no** duration filter
  (Section 8.2).

### 5.5 H5 play endpoint (series last resort — and the task's headline endpoint)

```kotlin
private fun MovieBox.h5PlayStreams(
    subjectId: String,
    season: Int,
    episode: Int,
    detailPath: String,
): List<MovieBox.MovieStream> {
    val url = "https://vidiomoviebox.xyz/wefeed-h5api-bff/subject/play" +
        "?subjectId=${urlEncode(subjectId)}&se=$season&ep=$episode"
    val referer = "https://vidiomoviebox.xyz/player/$detailPath"
    val text = try {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "GET"
            connection.connectTimeout = 8000
            connection.readTimeout = 15000
            connection.setRequestProperty("User-Agent", USER_AGENT)
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Referer", referer)
            if (connection.responseCode !in 200..299) return emptyList()
            connection.inputStream.bufferedReader().use { it.readText() }
        } finally {
            connection.disconnect()
        }
    } catch (_: IOException) {
        return emptyList()
    }
    val data = try {
        JSONObject(text).optJSONObject("data")
    } catch (_: Exception) {
        null
    } ?: return emptyList()
    val streams = data.optJSONArray("streams") ?: return emptyList()
    ...
}
```

Full request spec:

- **Method:** `GET`
- **URL:**
  `https://vidiomoviebox.xyz/wefeed-h5api-bff/subject/play?subjectId=<urlEncoded>&se=<season>&ep=<episode>`
  (`se`/`ep` are plain integers, not encoded.)
- **Signing:** **none** — no `x-client-token`, `x-tr-signature`,
  `x-client-build`, `x-client-info`, `Authorization`, or
  `x-forwarded-for`. The comment says "the web frontend proxies the H5
  BFF".
- **Headers sent:** exactly three:
  - `User-Agent: <USER_AGENT>` (Section 9.1)
  - `Accept: application/json`
  - `Referer: https://vidiomoviebox.xyz/player/<detailPath>` — the
    **player-page URL**, with the title's exact `detailPath` slug.
    "A wrong or missing slug returns no streams."
- **Timeouts:** 8 s connect, 15 s read (same as the mobile client).
- **Failure behaviour:** any non-2xx status, `IOException`, bad JSON,
  missing `data`, or missing `streams` → returns an **empty list**,
  never throws.
- **Response shape:**

```json
{
  "data": {
    "streams": [
      {
        "id": "<play stream id>",
        "url": "<signed mp4 URL>",
        "resolutions": "1080,720",
        "codecName": "h264",
        "size": 1234567890,
        "duration": 2700
      }
    ]
  }
}
```

  (Field names are those read by the parsing loop below; the code does
  not document any other fields.)

- **Parsing loop** (verbatim):

```kotlin
val out = mutableListOf<MovieBox.MovieStream>()
for (i in 0 until streams.length()) {
    val row = streams.optJSONObject(i) ?: continue
    val streamUrl = row.optString("url", "").orEmpty()
    if (streamUrl.isEmpty() || !streamUrl.startsWith("http")) continue
    if (isDeprecationNoticeUrl(streamUrl)) continue
    val resolution = row.optString("resolutions", "")
        .split(",").firstOrNull()?.trim()?.toIntOrNull() ?: 0
    out += MovieBox.MovieStream(
        url = streamUrl,
        resolution = resolution,
        codec = row.optString("codecName", ""),
        sizeBytes = longValue(row, "size"),
        durationSec = longValue(row, "duration"),
        // The file request needs the detail-page Referer, not just
        // User-Agent: without it the CDN answers 429 (the `referer`
        // above is only for the play-API call). Verified live
        // 2026-11-23: the phone browser plays with this Referer.
        headers = mapOf(
            "User-Agent" to USER_AGENT,
            "Referer" to seriesFileReferer(subjectId, detailPath),
        ),
        // Play-response stream id — the caption endpoint keys
        // subtitles by it.
        id = row.optString("id", "").orEmpty(),
    )
}
return out
```

  Differences from play-info parsing:
  - `resolution` is the **first** element of the comma-separated
    `resolutions` string (not the max), or `0` if unparseable.
  - No `signCookie` / DASH handling, no `Cookie` header.
  - Player headers for the returned streams: `User-Agent` **plus**
    `Referer: <detailPageUrl(subjectId, detailPath)>`
    (`https://themoviebox.xyz/movies/<detailPath>?id=<id>&type=/movie/detail&detailSe=&detailEp=&lang=en`)
    — a **different** Referer from the one sent to the play API itself
    (`vidiomoviebox.xyz/player/<detailPath>`). Both are required:
    the play-API Referer to get streams, the detail-page Referer to
    actually fetch the files (the CDN answers 429 without it).
  - Verified live 2026-11-23 for The Body [Hindi] S1 E1+E2: 480p +
    1080p MP4s.

- **When it runs:** only inside `episodeStreams()` (Section 8.2, step 5),
  only when every mobile source returned nothing **and**
  `detailPath` is non-blank. It is **not** used for movies.

---

## 6. Captions (English subtitles)

There are two subtitle mechanisms in the code — do not mix them up:

| Mechanism | Source | Used for |
|---|---|---|
| `parseSubtitles(detectors)` | `extCaptions[]` inside `resourceDetectors` from the details response | `Details.subtitles` list (display only; the player does not use it for CC) |
| `englishCaptionUrl()` + `attachEnglishCaptions()` | H5 caption endpoint, called at resolve time | The player's CC track (`MovieStream.subtitleUrl`) |

### 6.1 Caption endpoint — exact request

```kotlin
internal fun englishCaptionUrl(streamId: String, subjectId: String, detailPath: String): String? {
    val url = "https://themoviebox.xyz/wefeed-h5api-bff/subject/caption" +
        "?format=MP4&id=${urlEncode(streamId)}&subjectId=${urlEncode(subjectId)}" +
        "&detailPath=${urlEncode(detailPath)}"
    val text = try {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "GET"
            connection.connectTimeout = 8000
            connection.readTimeout = 15000
            connection.setRequestProperty("User-Agent", USER_AGENT)
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty(
                "X-Client-Info",
                "{\"timezone\":\"${java.util.TimeZone.getDefault().id}\"}",
            )
            connection.setRequestProperty("Referer", detailPageUrl(subjectId, detailPath))
            if (connection.responseCode !in 200..299) return null
            connection.inputStream.bufferedReader().use { it.readText() }
        } finally {
            connection.disconnect()
        }
    } catch (_: IOException) {
        return null
    }
    ...
}
```

- **Method:** `GET`
- **URL:**
  `https://themoviebox.xyz/wefeed-h5api-bff/subject/caption?format=MP4&id=<urlEncoded streamId>&subjectId=<urlEncoded>&detailPath=<urlEncoded>`
  — query params in exactly this order: `format`, `id`, `subjectId`,
  `detailPath`. `format` is the literal `MP4`. `id` is the play-response
  stream id (`MovieStream.id`); `detailPath` is the web slug.
- **Signing:** **none** (comment: "No signing is needed").
- **Headers sent:** exactly four:
  - `User-Agent: <USER_AGENT>`
  - `Accept: application/json`
  - `X-Client-Info: {"timezone":"<device timezone id>"}` — note this is
    a **different, minimal** `X-Client-Info` from the signed-request one
    (Section 3.7): just the timezone, e.g.
    `{"timezone":"Asia/Kolkata"}`. The value is the device's default
    timezone id (`TimeZone.getDefault().id`).
  - `Referer: <detailPageUrl(subjectId, detailPath)>`
    (`https://themoviebox.xyz/movies/<detailPath>?id=<id>&type=/movie/detail&detailSe=&detailEp=&lang=en`)
- **Timeouts:** 8 s connect, 15 s read.
- **Failure:** non-2xx, `IOException`, bad JSON, or missing
  `data.captions` → `null` (no caption; CC stays off).

### 6.2 English selection + attachment

```kotlin
val captions = try {
    JSONObject(text).optJSONObject("data")?.optJSONArray("captions")
} catch (_: Exception) {
    null
} ?: return null
for (i in 0 until captions.length()) {
    val cap = captions.optJSONObject(i) ?: continue
    if (!cap.optString("lan", "").equals("en", ignoreCase = true)) continue
    val capUrl = cap.optString("url", "").orEmpty()
    if (capUrl.isNotEmpty() && capUrl.startsWith("http")) return capUrl
}
return null
```

- **Response shape:**

```json
{
  "data": {
    "captions": [
      { "lan": "en", "url": "https://.../something.srt" },
      { "lan": "hi", "url": "https://.../something-else.srt" }
    ]
  }
}
```

  (Only `lan` and `url` are read. Other fields, if any, are ignored.)
- **Selection:** the **first** caption whose `lan` equals `"en"`
  (case-insensitive) **and** whose `url` is non-empty and starts with
  `http`. All other languages are ignored. Verified live 2026-11-23:
  The Body S1E1 returns 9 captions including English.
- **Attachment** (`attachEnglishCaptions`):

```kotlin
internal fun attachEnglishCaptions(
    streams: List<MovieBox.MovieStream>,
    subjectId: String,
    detailPath: String,
): List<MovieBox.MovieStream> {
    if (streams.isEmpty() || detailPath.isBlank()) return streams
    val firstId = streams.firstOrNull { it.id.isNotEmpty() }?.id ?: return streams
    val captionUrl = englishCaptionUrl(firstId, subjectId, detailPath) ?: return streams
    return streams.map { if (it.subtitleUrl.isEmpty()) it.copy(subtitleUrl = captionUrl) else it }
}
```

  - One caption call per title/episode, using the **first stream with a
    non-empty `id`** (detector/resource streams have no play id, so if
    no stream has an id, no caption call is made at all).
  - The same caption URL is copied onto **every** stream of that
    title/episode (captions are per-episode, shared across qualities).
  - The signed caption URL "expires in ~7 days, so it is resolved fresh
    at resolve time, like the video streams" (code comment).
  - If the title has no English caption (e.g. Overgeared S1E1), the
    streams are returned unchanged and CC stays off.

### 6.3 Detector subtitles (`extCaptions`) — reference only

```kotlin
private fun parseSubtitles(detectors: JSONArray?): List<Subtitle> {
    if (detectors == null) return emptyList()
    val seen = mutableSetOf<String>()
    val out = mutableListOf<Subtitle>()
    for (i in 0 until detectors.length()) {
        val captions = detectors.optJSONObject(i)?.optJSONArray("extCaptions") ?: continue
        for (j in 0 until captions.length()) {
            val cap = captions.optJSONObject(j) ?: continue
            val url = cap.optString("url", "").orEmpty()
            if (url.isEmpty() || "aa348f2541d13ffe" in url) continue
            val size = longValue(cap, "size")
            if (size in 1..50) continue
            val name = cap.optString("lanName", cap.optString("lan", "Unknown"))
            if (name.equals("in", ignoreCase = true) && size <= 100) continue
            if (!seen.add(url)) continue
            out += Subtitle(name, url)
        }
    }
    return out
}
```

- Each `extCaptions[]` entry: `url`, `size` (bytes), `lanName`/`lan`.
- Dropped: empty URL; URL containing `aa348f2541d13ffe`; `size` in
  1..50 bytes; language `"in"` with `size <= 100`; duplicate URLs.
- **UNCLEAR — not in code:** what the `aa348f2541d13ffe` substring or
  the tiny-size filters correspond to server-side. Replicate literally.

### 6.4 SRT format

**UNCLEAR — not in code.** The Kotlin code never downloads or parses
the `.srt` file itself: it only returns the caption URL, and the player
(ExoPlayer, outside these four files) attaches it as a text track.
No SRT parsing, timing format, encoding, or language-tag handling
appears in these files. A JS player must fetch the `.srt` URL itself
and parse standard SubRip (`.srt`) text; do not assume anything beyond
"the URL ends in / points at an `.srt` file" from this spec.

---

## 7. Home feed rails (`MovieBoxFeeds.kt` + `MovieFeed.kt`)

### 7.1 `homeFeed(tabId)` — the tab-operating feed

```kotlin
/** One tab of the home feed (tabId 0 = main home, 2 = Movies, 5 = Indian
 * Web Series, 19 = Western TV Series; tabId 9 is ADULT — never used). */
internal fun MovieBox.homeFeed(tabId: Int): List<HomeSection> {
    val data = try {
        request("GET", "$BASE/tab-operating?page=1&tabId=$tabId&version=", null)
    } catch (_: IOException) {
        return emptyList()
    }
    val items = data.optJSONArray("items") ?: return emptyList()
    ...
}
```

- **Endpoint:**
  `GET /wefeed-mobile-bff/tab-operating?page=1&tabId=<tabId>&version=`
  — note `version=` is present but **empty**.
- **Tab ids:** `0` = main home, `2` = Movies, `5` = Indian Web Series,
  `19` = Western TV Series. `9` is ADULT and is never used.
- **Response shape:** `data.items[]` — each item is a section ("group"):

```json
{
  "items": [
    {
      "title": "<section title>",
      "subjects": [ { "<subject>" } ],
      "banner": { "banners": [ { "subject": { "<subject>" } } ] },
      "customData": { "items": [ { "subject": { "<subject>" } } ] }
    }
  ]
}
```

  - Section title: `title` / `name` / `moduleTitle` / `tabName`
    (first non-empty, in that order).
  - Subjects come from three places, all parsed through
    `parseSearchMovie` (so adult/CAM/no-resource filtering applies):
    plain `subjects[]`; banner carousel `banner.banners[].subject`;
    custom rows `customData.items[].subject`.
  - Deduped by `subjectId`; sections with no surviving subjects are
    dropped. Returns `List<HomeSection(title, movies)>`:

```kotlin
internal data class HomeSection(val title: String, val movies: List<MovieBox.Movie>)
```

  - Any `IOException` → empty list (best-effort).

### 7.2 The rail functions (all best-effort, empty list on failure)

**New Movies — `newMovies()`:**

```kotlin
internal fun MovieBox.newMovies(): List<MovieBox.Movie> {
    // 1. Catalogue list, newest first.
    try {
        val body = JSONObject().apply {
            put("tabId", 2)
            put("page", 1)
            put("perPage", 20)
            put("classify", "All")
            put("country", "All")
            put("genre", "All")
            put("sort", "Newest")
            put("year", "All")
        }.toString()
        val data = request("POST", "$BASE/subject-api/list", body)
        val list = subjectsFrom(data).filter { !it.isSeries }
        if (list.isNotEmpty()) return list.sortedByYearDesc().take(20)
    } catch (_: IOException) {
        // Fall through to the home-feed fallback.
    }
    // 2. Home feed movies from the last two release years.
    val feed = (homeFeed(0) + homeFeed(2)).flatMap { it.movies }
    val recent = feed.filter { !it.isSeries && (it.year == "2026" || it.year == "2025") }
        .distinctBy { it.subjectId }
        .sortedByYearDesc()
    if (recent.isNotEmpty()) return recent.take(20)
    // 3. Whatever the home feed has — better than an empty section.
    return feed.filter { !it.isSeries }.distinctBy { it.subjectId }.sortedByYearDesc().take(20)
}
```

  - Primary: `POST /wefeed-mobile-bff/subject-api/list` with body
    `{"tabId":2,"page":1,"perPage":20,"classify":"All","country":"All","genre":"All","sort":"Newest","year":"All"}`
    (exact key order), movies only (`!isSeries`), sorted by year
    descending client-side, top 20.
  - Fallback 2: home feed tabs 0 + 2, movies from release years
    `2026` or `2025` only (hard-coded year strings in the code),
    deduped, year-desc, top 20.
  - Fallback 3: same feed, any year, deduped, year-desc, top 20.

**Genre browse — `moviesByGenre(genre)`:**

```kotlin
internal fun MovieBox.moviesByGenre(genre: String): List<MovieBox.Movie> {
    return try {
        val body = JSONObject().apply {
            put("tabId", 2)
            put("page", 1)
            put("perPage", 20)
            put("classify", "All")
            put("country", "All")
            put("genre", genre)
            put("sort", "Newest")
            put("year", "All")
        }.toString()
        val data = request("POST", "$BASE/subject-api/list", body)
        subjectsFrom(data).filter { !it.isSeries }.take(20)
    } catch (_: IOException) {
        emptyList()
    }
}
```

  Same `subject-api/list` endpoint, with `genre` replaced by the
  requested genre. **Note:** unlike `newMovies()`, this one does **not**
  sort by year — it returns the server order, top 20.

**Trending Now — `trending()`:**

```kotlin
internal fun MovieBox.trending(): List<MovieBox.Movie> {
    return try {
        val body = JSONObject().apply { put("page", 1); put("perPage", 20) }.toString()
        val data = request("POST", "$BASE/subject-api/trending/v2", body)
        subjectsFrom(data).filter { !it.isSeries }.take(20)
    } catch (_: IOException) {
        emptyList()
    }
}
```

  - `POST /wefeed-mobile-bff/subject-api/trending/v2`, body
    `{"page":1,"perPage":20}`, movies only, top 20. This is also the
    source of the Netflix-style Top 10 rail (the UI takes the first 10).

**Top Picks for You — `curatedPicks()`:**

```kotlin
internal fun MovieBox.curatedPicks(): List<MovieBox.Movie> {
    val bodies = listOf(
        "$BASE/subject-api/daily-movie-rec" to JSONObject().toString(),
        "$BASE/subject-api/top-rec" to
            JSONObject().apply { put("page", 1); put("perPage", 20) }.toString(),
    )
    for ((path, body) in bodies) {
        try {
            val data = request("POST", path, body)
            val list = subjectsFrom(data).filter { !it.isSeries }
            if (list.isNotEmpty()) return list.take(20)
        } catch (_: IOException) {
            continue
        }
    }
    return emptyList()
}
```

  - Try in order: `POST /wefeed-mobile-bff/subject-api/daily-movie-rec`
    with body `{}` (empty JSON object), then
    `POST /wefeed-mobile-bff/subject-api/top-rec` with body
    `{"page":1,"perPage":20}`. First non-empty result wins (movies only,
    top 20).

**Recommended — `recommended()`** (same sources, different order; used
by older code paths — see 7.3):

```kotlin
internal fun MovieBox.recommended(): List<MovieBox.Movie> {
    val bodies = listOf(
        "$BASE/subject-api/trending/v2" to
            JSONObject().apply { put("page", 1); put("perPage", 20) }.toString(),
        "$BASE/subject-api/daily-movie-rec" to JSONObject().toString(),
        "$BASE/subject-api/top-rec" to
            JSONObject().apply { put("page", 1); put("perPage", 20) }.toString(),
    )
    for ((path, body) in bodies) {
        try {
            val data = request("POST", path, body)
            val list = subjectsFrom(data).filter { !it.isSeries }
            if (list.isNotEmpty()) return list.take(20)
        } catch (_: IOException) {
            continue
        }
    }
    val sections = homeFeed(0)
    val trending = sections.firstOrNull { it.title.contains("rend", ignoreCase = true) }
        ?: sections.firstOrNull()
    return trending?.movies?.filter { !it.isSeries }?.take(20) ?: emptyList()
}
```

  - Tries trending → daily-movie-rec → top-rec, then falls back to the
    home-feed tab 0 section whose title contains `"rend"`
    (case-insensitive), else the first section.

**Series rail — `seriesFeed()`:**

```kotlin
internal fun MovieBox.seriesFeed(): List<MovieBox.Movie> {
    val feed = (homeFeed(0) + homeFeed(5) + homeFeed(19)).flatMap { it.movies }
    return feed.filter { it.isSeries }.distinctBy { it.subjectId }.take(20)
}
```

  - Home feed tabs 0 + 5 + 19, series only (`isSeries`), deduped by
    `subjectId`, top 20.

### 7.3 How the rails are composed on the home screen (`MovieFeed.kt`)

```kotlin
internal fun MainActivity.loadMovieFeed() {
    if (movieFeedLoaded || movieFeedLoading) return
    movieFeedLoading = true
    val request = ++movieFeedRequest
    imports.execute {
        val fresh = movieBox.newMovies()
        val trend = movieBox.trending()
        val picks = movieBox.curatedPicks()
        val series = movieBox.seriesFeed()
        runOnUiThread {
            if (isDestroyed || request != movieFeedRequest) return@runOnUiThread
            movieFeedLoading = false
            movieFeedLoaded = true
            movieFeedTrending = trend
            movieFeedPicks = picks
            movieFeedRecommended = (trend + picks).distinctBy { it.subjectId }
            // New Release must genuinely differ from Trending / Top Picks
            // (v2.0.37): drop any title already in those rails, newest
            // first by release year.
            val pickIds = movieFeedRecommended.map { it.subjectId }.toSet()
            movieFeedNew = fresh.filter { it.subjectId !in pickIds }
                .sortedByDescending { it.year.toIntOrNull() ?: 0 }
            movieFeedSeries = series
            if (moviesOpen && !movieResultsAreSearch) renderCurrentMoviesTab()
        }
    }
}
```

- Loads **once per app run**, in the background; a failed load leaves
  the sections out (the feed functions already fall back internally).
- Four parallel-ish calls: `newMovies()`, `trending()`,
  `curatedPicks()`, `seriesFeed()`. (Note: `recommended()` is **not**
  called here — "Recommended" is composed client-side.)
- Composition:
  - `Trending` = `trending()` as-is.
  - `Top Picks` = `curatedPicks()` as-is.
  - `Recommended` = `trending + curatedPicks`, deduped by `subjectId`.
  - `New Release` = `newMovies()` minus anything already in
    Recommended, sorted by release year descending (unknown year = 0,
    sorts last).
  - `Series` = `seriesFeed()` as-is.
- The file header adds: "Nothing is re-fetched while the app runs."

### 7.4 `subjectsFrom()` — shared response parsing for list endpoints

```kotlin
private fun MovieBox.subjectsFrom(data: JSONObject): List<MovieBox.Movie> {
    val out = mutableListOf<MovieBox.Movie>()
    val results = data.optJSONArray("results")
    if (results != null) {
        for (i in 0 until results.length()) {
            val subjects = results.optJSONObject(i)?.optJSONArray("subjects") ?: continue
            for (j in 0 until subjects.length()) {
                parseSearchMovie(subjects.optJSONObject(j))?.let { out += it }
            }
        }
        if (out.isNotEmpty()) return out
    }
    for (key in listOf("list", "subjects", "items", "data")) {
        val arr = data.optJSONArray(key) ?: continue
        for (i in 0 until arr.length()) {
            parseSearchMovie(arr.optJSONObject(i))?.let { out += it }
        }
        if (out.isNotEmpty()) return out
    }
    return out
}
```

- First tries the grouped shape `results[].subjects[]` (same as search);
  if that yields nothing, tries flat arrays under `list`, `subjects`,
  `items`, `data` in that order, returning at the first key that yields
  any subject. All subjects go through `parseSearchMovie`.

---

## 8. Series model

### 8.1 Model classes

```kotlin
/** One season of a series, with its episodes (titles when the API gives them). */
data class Season(
    val number: Int,
    val name: String = "",
    val episodes: List<EpisodeRef> = emptyList(),
) {
    val episodeCount: Int get() = episodes.size
}

data class EpisodeRef(val number: Int, val title: String = "")
```

- Seasons and episodes are numbered with plain integers (`se`, `ep`),
  1-based in practice. Episode titles are optional — when the API
  gives no titles, episodes are just numbers (`EpisodeRef(number = n)`).
- `isSeries` is set from the subject: `stype == 2L` (Section 4.2).

### 8.2 Season discovery — `seasons(subjectId)`

```kotlin
internal fun MovieBox.seasons(subjectId: String): List<MovieBox.Season> {
    // 1. season-info endpoint.
    try {
        val data = request(
            "GET",
            "$BASE/subject-api/season-info?subjectId=${urlEncode(subjectId)}",
            null,
        )
        val parsed = parseSeasons(data)
        if (parsed.isNotEmpty()) return parsed
    } catch (_: IOException) {
        // Fall through to the resource-list derivation.
    }
    // 2. Derive seasons from the resource list's se/ep tags.
    val pairs = mutableSetOf<Pair<Int, Int>>()
    for (page in 1..2) {
        try {
            val data = request(
                "GET",
                "$BASE/subject-api/resource?subjectId=${urlEncode(subjectId)}&page=$page&perPage=20",
                null,
            )
            val items = data.optJSONArray("list") ?: break
            if (items.length() == 0) break
            for (i in 0 until items.length()) {
                val item = items.optJSONObject(i) ?: continue
                val se = longValue(item, "se").toInt()
                val ep = longValue(item, "ep").toInt()
                if (se > 0 && ep > 0) pairs += se to ep
            }
        } catch (_: IOException) {
            break
        }
    }
    return pairs.groupBy({ it.first }, { it.second })
        .map { (se, eps) ->
            MovieBox.Season(
                number = se,
                episodes = eps.sorted().distinct()
                    .map { MovieBox.EpisodeRef(number = it) },
            )
        }
        .sortedBy { it.number }
}
```

- **Step 1:** `GET /wefeed-mobile-bff/subject-api/season-info?subjectId=<id>`.
  Parsed by `parseSeasons()` (below). If it yields anything, that wins.
- **Step 2 (fallback):** derive the structure from the resource list's
  own `se`/`ep` tags — `GET /wefeed-mobile-bff/subject-api/resource?subjectId=<id>&page=<1..2>&perPage=20`,
  up to 2 pages, stopping early on an empty page or an error. Only
  pairs with `se > 0 && ep > 0` count. Group by season, sort episode
  numbers, dedupe, sort seasons ascending. Episode titles are empty in
  this path.

`parseSeasons()` (defensive — several key spellings):

```kotlin
internal fun parseSeasons(data: JSONObject): List<MovieBox.Season> {
    val arrays = listOfNotNull(
        data.optJSONArray("seasons"),
        data.optJSONArray("seasonList"),
        data.optJSONArray("list"),
    )
    val seasons = mutableListOf<MovieBox.Season>()
    for (arr in arrays) {
        for (i in 0 until arr.length()) {
            val s = arr.optJSONObject(i) ?: continue
            val number = longKeys(s, "se", "season", "seasonNumber", "index").toInt()
            if (number <= 0) continue
            val name = s.optString("name", s.optString("title", s.optString("seasonName", "")))
            val episodes = mutableListOf<MovieBox.EpisodeRef>()
            val epArr = s.optJSONArray("episodes")
                ?: s.optJSONArray("episodeList")
                ?: s.optJSONArray("eps")
            if (epArr != null) {
                for (j in 0 until epArr.length()) {
                    val e = epArr.optJSONObject(j)
                    val epNum = if (e == null) epArr.optInt(j, 0) else
                        longKeys(e, "ep", "episode", "episodeNumber", "index").toInt()
                    if (epNum <= 0) continue
                    episodes += MovieBox.EpisodeRef(
                        number = epNum,
                        title = e?.optString("title", e.optString("name", "")).orEmpty(),
                    )
                }
            } else {
                val count = longKeys(s, "episodeCount", "epCount", "totalEpisode", "count", "maxEp").coerceIn(0L, 5000L).toInt()
                for (n in 1..count) episodes += MovieBox.EpisodeRef(number = n)
            }
            if (episodes.isNotEmpty()) {
                seasons += MovieBox.Season(number = number, name = name, episodes = episodes.sortedBy { it.number })
            }
        }
        if (seasons.isNotEmpty()) return seasons.sortedBy { it.number }
    }
    return emptyList()
}
```

- Season arrays tried in order: `seasons`, `seasonList`, `list` — the
  first array that yields at least one season wins.
- Season number keys (first non-zero wins): `se`, `season`,
  `seasonNumber`, `index`. Seasons with number `<= 0` are skipped.
- Season name: `name` / `title` / `seasonName`.
- Episodes: array under `episodes` / `episodeList` / `eps`; episode
  number keys (first non-zero): `ep`, `episode`, `episodeNumber`,
  `index`; a bare integer element is used as-is (`epArr.optInt(j, 0)`).
  Episode title: `title` / `name`. Episodes with number `<= 0` skipped.
- If there is no episode array, the count keys `episodeCount` /
  `epCount` / `totalEpisode` / `count` / `maxEp` (first non-zero,
  clamped to 0..5000) generate episodes `1..count` with empty titles.
- Seasons with no episodes are dropped. Result sorted by season number.

```kotlin
/** First non-zero long among several key spellings (the API is not
 * consistent about se/season/ep/episode naming). */
private fun longKeys(obj: JSONObject, vararg keys: String): Long {
    for (key in keys) {
        val v = obj.optLong(key, 0L)
        if (v != 0L) return v
    }
    return 0L
}
```

### 8.3 Episode stream resolution — `episodeStreams(subjectId, season, episode)`

```kotlin
internal fun MovieBox.episodeStreams(subjectId: String, season: Int, episode: Int): List<MovieBox.MovieStream> =
    episodeStreams(details(subjectId), season, episode)
```

The details overload reuses already-fetched `Details` (no second
details call). Steps, in order — stop at the first step that yields
streams, except steps 4–5 which only run when `found` is still empty:

```kotlin
internal fun MovieBox.episodeStreams(
    details: MovieBox.Details,
    season: Int,
    episode: Int,
): List<MovieBox.MovieStream> {
    var providerSentNotice = false
    val found = mutableListOf<MovieBox.MovieStream>()
    val seen = mutableSetOf<String>()
    fun add(stream: MovieBox.MovieStream) {
        if (stream.url.isEmpty() || !stream.url.startsWith("http")) return
        if (isDeprecationNoticeUrl(stream.url)) return
        val base = stream.url.substringBefore('?')
        if (!seen.add(base)) return
        found += stream
    }
    val fileReferer = seriesFileReferer(details.movie.subjectId, details.detailPath)
    // 1. resourceDetectors ...
    // 2. play-info/v2 with se/ep ...
    // 3. Resource list with se/ep (+ recovery) ...
    // 4. Title-level play-info as a last resort, S1 E1 only ...
    // 5. H5 play endpoint ...
    if (found.isEmpty()) {
        if (providerSentNotice) throw IOException("Provider ne S${season} E${episode} ki video ki jagah notice bheja.")
        throw IOException("Is episode ke liye koi playable link nahi mila.")
    }
    val captioned = attachEnglishCaptions(found, details.movie.subjectId, details.detailPath)
    return captioned.sortedWith(
        compareByDescending<MovieBox.MovieStream> { it.resolution }
            .thenBy { it.isDash }
            .thenByDescending { it.sizeBytes },
    )
}
```

**Step 1 — `resourceDetectors`, files tagged with this season/episode.**
Same detector walk as movies (Section 5.1), but each item must match
the requested `se`/`ep` (see `matchesEpisode` below), and the returned
streams carry headers `{User-Agent, Referer: <detailPageUrl>}` instead
of User-Agent only. A detector item is tried two ways: its
`resolutionList[]` entries, then the detector itself as a single
`downloadUrl` entry:

```kotlin
private fun MovieBox.parseEpisodeDetectorItem(
    item: JSONObject?,
    parent: JSONObject,
    season: Int,
    episode: Int,
    referer: String,
): MovieBox.MovieStream? {
    if (item == null) return null
    if (!matchesEpisode(item, parent, season, episode)) return null
    val url = episodeUrl(item) ?: return null
    val title = item.optString("title", item.optString("fileName", "")).orEmpty()
    if (isCamTitle(title)) return null
    return MovieBox.MovieStream(
        url = url,
        resolution = longValue(item, "resolution").toInt(),
        codec = item.optString("codecName", item.optString("codec", "")),
        sizeBytes = longValue(item, "size"),
        durationSec = longValue(item, "duration"),
        headers = mapOf("User-Agent" to USER_AGENT, "Referer" to referer),
    )
}
```

```kotlin
private fun MovieBox.episodeUrl(row: JSONObject): String? =
    listOf("downloadUrl", "resourceLink", "url").asSequence()
        .map { row.optString(it).trim() }
        .firstOrNull { (it.startsWith("https://") || it.startsWith("http://")) && !isDeprecationNoticeUrl(it) }
```

  URL keys tried in order: `downloadUrl`, `resourceLink`, `url` — first
  one that is an `http(s)` URL and not a notice URL.

```kotlin
internal fun matchesEpisode(item: JSONObject, parent: JSONObject?, season: Int, episode: Int): Boolean {
    fun number(vararg names: String): Int? {
        for (record in listOfNotNull(item, parent)) {
            for (name in names) {
                if (record.has(name) && !record.isNull(name)) return record.optInt(name, -1)
            }
        }
        return null
    }
    return number("se", "season", "seasonNumber") == season &&
        number("ep", "episode", "episodeNumber") == episode
}
```

  The season/episode number is looked up in the item first, then the
  parent object, under the keys `se`/`season`/`seasonNumber` and
  `ep`/`episode`/`episodeNumber`. Both must equal the requested values
  exactly (`null` — key absent everywhere — does **not** match).

**Step 2 — play-info/v2 with `se`/`ep`:**

```kotlin
// 2. play-info/v2 with se/ep — DASH manifest or a direct file.
try {
    val playInfo = request(
        "GET",
        "$BASE/subject-api/play-info/v2?subjectId=${urlEncode(details.movie.subjectId)}&se=$season&ep=$episode",
        null,
    )
    val playStreams = playInfo.optJSONArray("streams")
    if (playStreams != null) {
        val displayRes = playInfo.optString("displayResolutions", "")
        for (i in 0 until playStreams.length()) {
            val row = playStreams.optJSONObject(i) ?: continue
            if (isDeprecationNoticeUrl(row.optString("url"))) providerSentNotice = true
            parsePlayInfoStream(row, displayRes)?.let { add(it) }
        }
    }
} catch (_: IOException) {
    // play-info is a fallback source — detectors may already have files.
}
```

  Same parsing as movies (Section 5.2), including DASH-via-`signCookie`
  and the `Referer: https://sportslive.wine` + `Cookie` headers from
  `parsePlayInfoStream`. If a stream row's `url` is a notice URL,
  `providerSentNotice` is set (used for the error message at the end).

**Step 3 — resource list with `se`/`ep`, paginated, with recovery:**

```kotlin
// 3. Resource list with se/ep (+ recovery for placeholder links).
// Paginated: the API may ignore the se/ep filter, and a long series
// has far more than one page of files — the wanted episode's files
// may sit on page 2+. Stop as soon as the episode is found.
try {
    for (page in 1..5) {
        if (found.isNotEmpty()) break
        val resData = request(
            "GET",
            "$BASE/subject-api/resource?subjectId=${urlEncode(details.movie.subjectId)}&se=$season&ep=$episode&page=$page&perPage=20",
            null,
        )
        val items = resData.optJSONArray("list") ?: break
        if (items.length() == 0) break
        for (i in 0 until items.length()) {
            val item = items.optJSONObject(i) ?: continue
            // The API may ignore the se/ep filter — check client-side.
            if (!matchesEpisode(item, null, season, episode)) continue
            val resourceId = idString(item, "resourceId", "id").orEmpty()
            if (resourceId.isNotBlank() && detectors != null) {
                for (index in 0 until detectors.length()) {
                    val detector = detectors.optJSONObject(index) ?: continue
                    if (!sameEpisodeFile(detector, item, season, episode)) continue
                    parseEpisodeDetectorItem(detector, item, season, episode, fileReferer)?.let { add(it) }
                }
            }
            val parsed = parseEpisodeDetectorItem(item, item, season, episode, fileReferer)
            if (parsed != null) {
                add(parsed)
                continue
            }
            val link = item.optString("resourceLink", item.optString("url", "")).orEmpty()
            if (!isDeprecationNoticeUrl(link)) continue
            providerSentNotice = true
            if (resourceId.isEmpty()) continue
            (recoverResource(
                details.movie.subjectId, resourceId, link,
                longValue(item, "resolution").toInt(),
                item.optString("codecName", item.optString("codec", "")),
                longValue(item, "size"), season, episode,
            ) ?: recoverResource(
                details.movie.subjectId, resourceId, link,
                longValue(item, "resolution").toInt(),
                item.optString("codecName", item.optString("codec", "")),
                longValue(item, "size"), 0, 0,
            ))?.let { add(it) }
        }
    }
} catch (_: IOException) {
    // Same: best-effort fallback.
}
```

  - **Endpoint:**
    `GET /wefeed-mobile-bff/subject-api/resource?subjectId=<id>&se=<s>&ep=<e>&page=<1..5>&perPage=20`
  - Pages 1–5, stops as soon as any stream is found, or on an empty
    page / missing `list`.
  - The API may ignore the `se`/`ep` filter, so every item is checked
    client-side with `matchesEpisode`.
  - For each matching item, the code first tries to match it to a
    detector by `resourceId` (`sameEpisodeFile`):

```kotlin
internal fun sameEpisodeFile(detector: JSONObject, row: JSONObject, season: Int, episode: Int): Boolean {
    val id = row.optString("resourceId")
    return id.isNotBlank() && id != "0" && id != "null" && id == detector.optString("resourceId") &&
        matchesEpisode(row, null, season, episode) && matchesEpisode(detector, row, season, episode)
}
```

  - Then the item itself is parsed as an episode detector item.
  - If the item's link is a notice URL, recovery is attempted **twice**:
    first with the exact `(season, episode)`, then with `(0, 0)` —
    because "the position endpoint often returns the recovered file
    without se/ep tags (0/0), which the exact check rejects … resourceId
    already pins the exact file, so an untagged recovery is safe to
    accept."

**Step 4 — title-level play-info, S1 E1 only:**

```kotlin
// 4. Title-level play-info as a last resort, S1 E1 only: some
// single-episode / movie-like series attach their only file to
// the title instead of the episode, so the se/ep play-info
// returns just the notice clip. Only runs when every episode
// source failed, so it can only turn the error below into a
// playable stream. Restricted to S1 E1 because the title-level
// endpoint most plausibly resolves to the first episode.
if (found.isEmpty() && season == 1 && episode == 1) {
    try {
        val playInfo = request(
            "GET",
            "$BASE/subject-api/play-info/v2?subjectId=${urlEncode(details.movie.subjectId)}",
            null,
        )
        ... // same parsePlayInfoStream loop as step 2
    } catch (_: IOException) {
        // Still nothing — fall through to the error below.
    }
}
```

  Same endpoint as the movie play-info call (no `se`/`ep` params).

**Step 5 — H5 play endpoint:** Section 5.5. Only when `found` is still
empty **and** `detailPath` is non-blank.

**Failure:** if still empty at the end:

- `providerSentNotice == true` →
  `IOException("Provider ne S<season> E<episode> ki video ki jagah notice bheja.")`
- otherwise →
  `IOException("Is episode ke liye koi playable link nahi mila.")`

**Final sort (episodes):** resolution desc, direct MP4 before DASH,
size desc — same as movies — but **no duration filter**.

**Series file Referer:**

```kotlin
private fun seriesFileReferer(subjectId: String, detailPath: String): String =
    detailPageUrl(subjectId, detailPath)
```

  i.e. the same `https://themoviebox.xyz/movies/<detailPath>?id=<id>&type=/movie/detail&detailSe=&detailEp=&lang=en`.
  The file CDN "refuses series requests without one (HTTP 429)".

---

## 9. Constants needed to replicate requests from Node.js

### 9.1 User-Agent

```kotlin
internal const val USER_AGENT =
    "com.community.oneroom/50020044 (Linux; U; Android 11; en_US; " +
        "2201117TY; Build/RP1A.200720.011; Cronet/135.0.7012.3)"
```

Full value (single line):

```
com.community.oneroom/50020044 (Linux; U; Android 11; en_US; 2201117TY; Build/RP1A.200720.011; Cronet/135.0.7012.3)
```

This exact string is sent as `User-Agent` on **every** request type:
signed mobile calls, H5 play, captions, and as the player header on
every resolved stream.

### 9.2 Other fixed constants

```kotlin
private const val STREAM_REFERER = "https://sportslive.wine"
private const val CERT_SHA256 =
    "03d4b741632d136bc23e2de4c6adcdb7712f1980b619c183221801730bbd0410"
private const val MAX_RESPONSE_BYTES = 4 * 1024 * 1024
```

- `STREAM_REFERER`: `https://sportslive.wine` — Referer on play-info
  streams (movies and episodes).
- `CERT_SHA256`: `03d4b741632d136bc23e2de4c6adcdb7712f1980b619c183221801730bbd0410`
  — used only inside `buildTag` (Section 3.6). It is a hex string
  constant, not a certificate the client validates.
- `MAX_RESPONSE_BYTES`: `4194304` (4 MiB) — responses are read capped at
  this size; the remainder is discarded.

### 9.3 Per-install identifiers (generate once, persist)

```kotlin
private val deviceId: String = prefs.getString(KEY_DEVICE_ID, null)
    ?: randomHex(32).also { prefs.edit().putString(KEY_DEVICE_ID, it).apply() }
private val gaid: String = prefs.getString(KEY_GAID, null)
    ?: randomUuid().also { prefs.edit().putString(KEY_GAID, it).apply() }
private val spoofedIp: String = randomSpoofedIp()
```

```kotlin
private const val KEY_DEVICE_ID = "mb_device_id"
private const val KEY_GAID = "mb_gaid"
```

```kotlin
private fun randomHex(len: Int): String {
    val chars = "0123456789abcdef"
    return (1..len).map { chars[Random.nextInt(16)] }.joinToString("")
}

private fun randomUuid(): String =
    "${randomHex(8)}-${randomHex(4)}-${randomHex(4)}-${randomHex(4)}-${randomHex(12)}"

private fun randomSpoofedIp(): String {
    val prefixes = arrayOf(
        "103.241", "49.36", "117.195", "106.198", "122.162",
        "157.32", "182.70", "103.58", "27.60", "59.90",
    )
    return "${prefixes[Random.nextInt(prefixes.size)]}.${Random.nextInt(1, 254)}.${Random.nextInt(1, 254)}"
}
```

- **`deviceId`**: 32 lowercase hex characters (e.g. `a3f9…`), generated
  once per install and persisted under `mb_device_id`. Sent in
  `x-client-info` as `"device_id"`.
- **`gaid`**: a UUID-shaped string `8-4-4-4-12` hex, **but generated from
  plain random hex, not a real UUID v4** (no version/variant bits are
  forced). Generated once, persisted under `mb_gaid`. Sent in
  `x-client-info` as `"gaid"`.
- **`spoofedIp`**: generated **fresh on every client construction**
  (not persisted): one of the 10 prefixes
  `103.241, 49.36, 117.195, 106.198, 122.162, 157.32, 182.70, 103.58, 27.60, 59.90`
  plus two octets each in `1..253` (Kotlin `Random.nextInt(1, 254)` is
  1-inclusive, 254-exclusive). Sent as `x-forwarded-for` on every signed
  request.
- In JS, persist `deviceId`, `gaid` and the JWT (`mb_token`,
  `mb_token_exp`, `mb_token_created`) in local storage / a file; generate
  a new `spoofedIp` per process start.

### 9.4 Timeouts and transport details

```kotlin
connection.connectTimeout = 8000
connection.readTimeout = 15000
connection.instanceFollowRedirects = true
```

- Signed calls (`httpCall`): 8 s connect, 15 s read, redirects followed.
- H5 play and caption calls: same 8 s / 15 s.
- No explicit redirect handling beyond the platform default.
- `Content-Type: application/json` is sent even on GETs; a body is only
  written when `body != null` (`connection.doOutput = true` then the
  UTF-8 bytes are written).

### 9.5 Small helpers a JS port must replicate exactly

```kotlin
internal fun urlEncode(value: String): String = try {
    URLEncoder.encode(value, "UTF-8")
} catch (_: Exception) {
    value
}

private fun urlDecode(value: String): String = try {
    URLDecoder.decode(value, "UTF-8")
} catch (_: Exception) {
    value
}
```

- **Warning — Java `URLEncoder` ≠ `encodeURIComponent`:** Java encodes
  a space as `+` (not `%20`), encodes `~` as `%7E` (JS leaves `~`
  unencoded), and leaves `*` unencoded… precisely: Java `URLEncoder`
  encodes everything except `a-z A-Z 0-9 . - * _`, and space → `+`.
  `encodeURIComponent` encodes space as `%20` and leaves `~` alone.
  For query values that can contain spaces or `~`, replicate Java's
  behaviour (`encodeURIComponent(v).replace(/%20/g, '+')` is close but
  still differs on `~`, `!`, `'`, `(`, `)` — see MDN's fixed
  `encodeURIComponent` recipe). In practice `subjectId`s are numeric
  strings and `detailPath`s are URL-safe slugs, so the difference rarely
  matters — but the canonical-string query sorting (Section 3.5) uses
  `URLDecoder`, where `+` decodes to a space.
- `idString(obj, ...keys)`: first non-empty value among the keys, where
  the value may be a JSON string **or** a JSON number (numbers are
  stringified). Returns `null` if none.
- `longValue(obj, key)`: JSON number → `long`; numeric string →
  parsed long; anything else / missing / null → `0`.
- `stringList(obj, ...keys)`: first key present wins; a JSON array →
  its non-empty string elements; a plain string → split on `,`, trim,
  drop empties.
- `extractYear(value)`: `Regex("(19|20)\\d\\d").find(value)?.value.orEmpty()`
  — first 19xx/20xx year in the string.
- `resolutionFromSourceLink(link)`: scans the upper-cased link for a
  `P` preceded by 3–4 digits and returns those digits as the resolution
  (e.g. `…1080P…` → `1080`); `0` if none found:

```kotlin
private fun resolutionFromSourceLink(link: String): Int {
    val upper = link.uppercase(Locale.US)
    var idx = upper.indexOf('P')
    while (idx >= 0) {
        var start = idx
        while (start > 0 && upper[start - 1].isDigit()) start--
        val digits = upper.substring(start, idx)
        if (digits.length in 3..4) return digits.toIntOrNull() ?: 0
        idx = upper.indexOf('P', idx + 1)
    }
    return 0
}
```

### 9.6 Node.js reference sketch (signing only)

```js
import crypto from 'node:crypto';

const BASE = '/wefeed-mobile-bff';
const USER_AGENT = 'com.community.oneroom/50020044 (Linux; U; Android 11; en_US; 2201117TY; Build/RP1A.200720.011; Cronet/135.0.7012.3)';
const CERT_SHA256 = '03d4b741632d136bc23e2de4c6adcdb7712f1980b619c183221801730bbd0410';
const SECRET_BYTES = Buffer.from([
  0xef, 0xa8, 0x91, 0x97, 0x4e, 0xec, 0xd3, 0x14,
  0x8d, 0xf6, 0x3a, 0xa6, 0x11, 0x60, 0x2d, 0xef,
  0xd1, 0x01, 0x25, 0x9b, 0xa5, 0x21, 0x02, 0x2c,
  0x57, 0xae, 0x05, 0x66, 0xbd, 0x8e,
]);

const md5Hex = (buf) => crypto.createHash('md5').update(buf).digest('hex');

function sortedQuery(rawQuery) {
  if (!rawQuery) return '';
  return rawQuery.split('&')
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq < 0) return null;
      // Java URLDecoder: '+' -> space, %XX decoded
      const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };
      return [dec(part.slice(0, eq)), dec(part.slice(eq + 1))];
    })
    .filter(Boolean)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) // stable in modern JS
    .map(([k, v]) => `${k}=${v}`).join('&');
}

function canonicalString(method, url, body, ts) {
  let path = url, query = '';
  try { const u = new URL(url); path = u.pathname; query = u.search.slice(1); } catch { /* keep whole url as path */ }
  const sorted = sortedQuery(query);
  const canonicalUrl = sorted ? `${path}?${sorted}` : path;
  let bodyHash = '', bodyLength = '';
  if (body !== null && body !== undefined) {
    const bytes = Buffer.from(body, 'utf8');
    bodyHash = md5Hex(bytes.subarray(0, 102400));
    bodyLength = String(bytes.length);
  }
  return [method.toUpperCase(), 'application/json', 'application/json',
          bodyLength, String(ts), bodyHash, canonicalUrl].join('\n');
}

function buildTag(ts, deviceId, gaid) {
  const stamp = `${Math.floor(ts / 1000)}${String(ts % 1000).padStart(3, '0')}000${Math.floor(Math.random() * 1000)}`;
  const hash = md5Hex(Buffer.from(CERT_SHA256 + 'oneroom' + stamp, 'utf8'));
  return `${stamp}.${hash}`;
}

function signedHeaders(method, url, body, token, { deviceId, gaid, spoofedIp }) {
  const ts = Date.now();
  const clientToken = `${ts},${md5Hex(Buffer.from([...String(ts)].reverse().join(''), 'utf8'))}`;
  const tag = buildTag(ts, deviceId, gaid);
  const canonical = canonicalString(method, url, body, ts);
  const sig = crypto.createHmac('md5', SECRET_BYTES).update(canonical, 'utf8').digest('base64');
  const headers = {
    'User-Agent': USER_AGENT,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Connection': 'keep-alive',
    'x-client-token': clientToken,
    'x-tr-signature': `${ts}|2|${sig}`,
    'x-client-build': tag,
    'x-client-info': JSON.stringify({ package_name: 'com.community.oneroom', version_name: '3.0.03.0529.03', version_code: 50020044, os: 'android', os_version: '11', install_ch: 'ps', device_id: deviceId, install_store: 'ps', gaid, brand: 'Redmi', model: '2201117TY', system_language: 'en', net: 'NETWORK_WIFI', region: 'US', timezone: 'Asia/Kolkata', sp_code: '40401', 'X-Play-Mode': '2', 'X-Client-Build': tag }),
    'x-client-status': '0',
    'x-forwarded-for': spoofedIp,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}
```

> Note on `x-client-info`: the Kotlin code builds the JSON by string
> concatenation in a fixed key order. `JSON.stringify` with the object
> literal above preserves insertion order for these string keys in
> modern JS, producing the identical string — but verify byte-for-byte
> against Section 3.7 before shipping.

---

## 10. Known quirks

### 10.1 Host rotation, retry statuses and backoff

```kotlin
private val RETRY_STATUSES = setOf(403, 406, 407, 429, 500, 502, 503, 504)
```

```kotlin
private fun requestHosts(
    method: String,
    path: String,
    body: String?,
    token: String?,
): JSONObject {
    val startIdx = activeHostIdx
    var backoffMs = 50L
    var lastError: String? = null
    for (i in HOSTS.indices) {
        if (i > 0) {
            Thread.sleep(backoffMs)
            backoffMs = 50L
        }
        val idx = (startIdx + i) % HOSTS.size
        val url = HOSTS[idx] + path
        try {
            val (status, headers, text) = httpCall(method, url, body, token)
            absorbXUser(headers)
            if (status in RETRY_STATUSES) {
                activeHostIdx = (idx + 1) % HOSTS.size
                if (status == 429) {
                    backoffMs = headers["retry-after"]?.toLongOrNull()
                        ?.let { (it * 1000).coerceAtMost(3000) } ?: 400L
                }
                lastError = "HTTP $status"
                continue
            }
            if (status == 401) throw AuthException("HTTP 401")
            if (status !in 200..299) throw ApiException("MovieBox HTTP $status")
            activeHostIdx = idx
            val json = JSONObject(text)
            val code = json.optInt("code", 0)
            if (code == 441) throw AuthException("API code 441")
            if (code != 0) throw ApiException("MovieBox error $code: ${json.optString("message")}")
            return json.optJSONObject("data") ?: json
        } catch (e: AuthException) {
            throw e
        } catch (e: ApiException) {
            throw e
        } catch (e: IOException) {
            lastError = e.message
            activeHostIdx = (idx + 1) % HOSTS.size
            continue
        } catch (e: Exception) {
            // Bad JSON from this host — try the next one.
            lastError = e.message
            activeHostIdx = (idx + 1) % HOSTS.size
            continue
        }
    }
    throw HostsExhaustedException("MovieBox: all hosts failed ($lastError)")
}
```

- Tries each of the 7 hosts **at most once** per call, starting at
  `activeHostIdx`, wrapping around. Sleeps 50 ms between hosts.
- On HTTP 429: sleeps `min(Retry-After seconds * 1000, 3000)` ms, or
  400 ms when the header is absent/unparseable, before the next host.
- A host that answers successfully becomes the new `activeHostIdx`
  (sticky host). A host that returns a retry status or throws
  `IOException`/bad JSON advances `activeHostIdx` past it.
- HTTP 401 or API `code == 441` → `AuthException` (not retried across
  hosts); the caller (`request()`) clears the session and retries the
  whole call **once** with a fresh login:

```kotlin
internal fun request(method: String, path: String, body: String?): JSONObject {
    val token = ensureToken()
    try {
        return requestHosts(method, path, body, token)
    } catch (e: AuthException) {
        // Bad/expired token (HTTP 401 or API code 441) — one fresh login.
        clearSession()
        return requestHosts(method, path, body, ensureToken())
    } catch (e: HostsExhaustedException) {
        // A dead token can look like dead hosts (every host 403s) — one
        // fresh login before giving up.
        clearSession()
        return requestHosts(method, path, body, ensureToken())
    }
}
```

- Any other non-2xx status → `ApiException` immediately (no host
  rotation). Any non-zero API `code` (other than 441) → `ApiException`
  with `message` from the body.
- If all 7 hosts fail → `HostsExhaustedException("MovieBox: all hosts failed (<lastError>)")`.
- Response envelope: success requires `code == 0` (or absent, default
  `0`); the returned value is `data` if it is a JSON object, otherwise
  the whole body object. `data` is **not** guaranteed to be an object
  for every endpoint — the code handles that by falling back to the
  whole JSON.
- Response headers are lower-cased by key before use; only the first
  value of a multi-value header is kept.

### 10.2 The notice / placeholder clip (deprecation notice)

```kotlin
/**
 * The 22-second "upgrade" placeholder clip the old endpoints return
 * instead of the real file. Three known file hashes, the notice name,
 * and the whole macdn /other/ directory are placeholders.
 */
internal fun isDeprecationNoticeUrl(url: String): Boolean {
    val lower = url.lowercase(Locale.US)
    return "1c7de0bd3393702d9191801f15f88f8d" in lower ||
        "9a0461bc39da389663bf3dbb17091d3f" in lower ||
        "b164fbfb4347792950bdfbfb563d39d9" in lower ||
        "/notice.mp4" in lower ||
        ("macdn.aoneroom.com" in lower && "/other/" in lower)
}
```

- A URL is a notice if (case-insensitive) it contains any of the three
  hashes `1c7de0bd3393702d9191801f15f88f8d`,
  `9a0461bc39da389663bf3dbb17091d3f`, `b164fbfb4347792950bdfbfb563d39d9`,
  or `/notice.mp4`, or it is on `macdn.aoneroom.com` under `/other/`.
- Notice URLs are filtered **everywhere**: detector parsing, resource
  parsing, play-info parsing, H5 parsing, recovery, and the final
  `add()` dedupe step. A title whose only links are notices resolves to
  "no playable link" (movies) or the provider-sent-notice error
  (episodes, Section 8.3).
- Live example from the project history: for The Body [Hindi] S1E1,
  play-info returned only the notice clip, title-level play-info
  returned 0 streams, the resource list had all 8 episodes but every
  link was the notice clip, and `resource-position/v2` returned 0 items
  for every episode's `resourceId`. Only the H5 endpoint returned real
  files. Do not assume the mobile endpoints will ever return a real
  file for such a title — the H5 fallback exists precisely for this.

### 10.3 Empty results are normal

- Search with no matches → `results` missing or empty → `[]`.
- `play-info/v2` may return `"streams": []` or no `streams` key.
- `resource` may return an empty `list`.
- `season-info` may return nothing parseable → seasons fall back to
  resource-list derivation (Section 8.2).
- `resource-position/v2` may return 0 items for a `resourceId` (see
  10.2) — recovery then returns `null`, not an error.
- Feed endpoints may fail entirely; every feed function returns `[]`
  on `IOException` and the home screen simply omits that rail.
- The caption endpoint may return no `en` caption (e.g. Overgeared
  S1E1) — CC is then off, not an error.
- `details()` throws `BlockedException` for adult/CAM titles; callers
  must distinguish that from a network failure.

### 10.4 Rate limiting / 429s

- 429 is a retry status (Section 10.1): the client moves to the next
  host after `Retry-After` (capped at 3 s) or 400 ms.
- **Series file requests without the detail-page Referer get HTTP 429
  from the file CDN** (`bcdnxw` per the code comment) — this is not
  server rate limiting, it is a missing-Referer refusal. Movies do not
  hit this because play-info streams already carry
  `Referer: https://sportslive.wine`; series detector/H5 streams must
  carry `Referer: <detailPageUrl>` (Sections 5.5, 8.3).
- The file header also notes the sandbox region-blocks the feed hosts
  (`MovieBoxFeeds.kt` header: "these endpoints cannot be verified from
  the sandbox (the hosts region-block it)"), so feed endpoints may
  behave differently by region/IP. The search/details/play endpoints
  were verified live from the sandbox on 2026-11-18.
- **UNCLEAR — not in code:** the exact server-side rate limits (requests
  per minute, per-IP vs per-token). The code only implements the
  reactive backoff above; there is no proactive throttling.

### 10.5 Signed links expire; captions expire

- Video links "are signed and expire within hours" (file header).
- The caption URL "expires in ~7 days" (Section 6.2 comment).
- Both must be resolved fresh at play time. The JWT lasts 7 days
  (Section 2.3) and is the only thing worth persisting.

### 10.6 API inconsistency the code works around

- Field names vary between endpoints: `subjectId`/`id`,
  `subjectType`/`stype`, `se`/`season`/`seasonNumber`,
  `ep`/`episode`/`episodeNumber`, `cover.url` vs `coverUrl`/`poster`/`pic`,
  `genre`/`genres`, `releaseDate`/`year`/`releaseInfo`,
  `codecName`/`codec`, `resourceLink`/`url`/`downloadUrl`,
  `resolutions` vs top-level `displayResolutions`, `dubs[].lanName`/
  `language`/`lang`. The code tries each spelling in a fixed order —
  replicate the order, not just the set.
- The resource endpoint "may ignore the se/ep filter" for series —
  always filter client-side with `matchesEpisode`.
- `subject-api/get` returns the subject under `data.subject`, or as
  `data` itself.
- The `season-info` response shape is "parsed defensively (several key
  spellings)" — the exact live shape was not pinned down in the code.
- `homeFeed` title keys: `title`/`name`/`moduleTitle`/`tabName`.
- `subjectsFrom` tries `results[].subjects[]` first, then flat
  `list`/`subjects`/`items`/`data`.

### 10.7 Things this spec deliberately does NOT claim

- **SRT content format** — not parsed in these files (Section 6.4).
- **What `x-user` tokens are, or when they arrive** (Section 2.4).
- **Server-side rate limits** (Section 10.4).
- **The exact live JSON of `season-info`** beyond the keys
  `parseSeasons` accepts (Section 8.2).
- **Whether `h5-api.aoneroom.com` works as a caption host** — the code
  uses `themoviebox.xyz` (Section 1.3).
- **DASH playback details** — the code only derives the `.mpd` URL;
  segment fetching, DRM (none is referenced in these files), and
  subtitle-track attachment live in the player code, outside these
  four files.

---

## 11. Endpoint index (quick reference)

All mobile endpoints are `POST`/`GET` to `<host>/wefeed-mobile-bff<path>`
with the signed headers of Section 3 (JWT required except login).
H5 endpoints are unsigned.

| # | Method | Path / URL | Body / params | Used by |
|---|---|---|---|---|
| 1 | POST | `/user-api/visitor-login` | `"{}"` | login (2.1) |
| 2 | POST | `/subject-api/search/v2` | `{"keyword","page","perPage":15,"subjectType":0}` | search (4.1) |
| 3 | GET | `/subject-api/get?subjectId=` | — | details (4.2) |
| 4 | GET | `/subject-api/play-info/v2?subjectId=` (+`&se=&ep=` for episodes) | — | streams (5.2, 8.3) |
| 5 | GET | `/subject-api/resource?subjectId=&page=&perPage=20` (+`&se=&ep=` for episodes) | — | streams, seasons fallback (5.3, 8.2, 8.3) |
| 6 | GET | `/subject-api/resource-position/v2?subjectId=&resourceId=&failUrl=&failCode=404&resourceNum=0&isVip=true` | — | recovery (5.3) |
| 7 | GET | `/subject-api/season-info?subjectId=` | — | seasons (8.2) |
| 8 | GET | `/tab-operating?page=1&tabId=&version=` | — | home feed (7.1) |
| 9 | POST | `/subject-api/list` | `{"tabId":2,"page":1,"perPage":20,"classify":"All","country":"All","genre":"All"/<genre>,"sort":"Newest","year":"All"}` | new movies, genre (7.2) |
| 10 | POST | `/subject-api/trending/v2` | `{"page":1,"perPage":20}` | trending (7.2) |
| 11 | POST | `/subject-api/daily-movie-rec` | `{}` | picks, recommended (7.2) |
| 12 | POST | `/subject-api/top-rec` | `{"page":1,"perPage":20}` | picks, recommended (7.2) |
| 13 | GET | `https://vidiomoviebox.xyz/wefeed-h5api-bff/subject/play?subjectId=&se=&ep=` | Referer: `https://vidiomoviebox.xyz/player/<detailPath>`; no signing | episode fallback (5.5) |
| 14 | GET | `https://themoviebox.xyz/wefeed-h5api-bff/subject/caption?format=MP4&id=&subjectId=&detailPath=` | Referer: detail page; `X-Client-Info: {"timezone":"…"}`; no signing | captions (6.1) |

Hosts for rows 1–12 (rotate, Section 10.1):
`api6.aoneroom.com`, `api5.aoneroom.com`, `api4.aoneroom.com`,
`api4sg.aoneroom.com`, `api3.aoneroom.com`, `api6sg.aoneroom.com`,
`api.inmoviebox.com` (all `https://`).
