import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';

console.log('[BOOT] Stream service starting...');

/* ── M3U8 URL rewriter ────────────────────────────────────────── */
function resolveUrl(url, base) {
  try {
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('//')) return 'https:' + url;
    return new URL(url, base).href;
  } catch { return url; }
}

function rewriteM3u8(content, originalUrl, proxyBase) {
  const baseUrl = originalUrl.substring(0, originalUrl.lastIndexOf('/') + 1);
  return content.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    // Rewrite URI="..." in tags (#EXT-X-KEY, #EXT-X-MAP, etc.)
    if (trimmed.startsWith('#') && /URI="/.test(trimmed)) {
      return trimmed.replace(/URI="([^"]+)"/g, (_, uri) => {
        const abs = resolveUrl(uri, baseUrl);
        return `URI="${proxyBase}${encodeURIComponent(abs)}"`;
      });
    }
    // Rewrite URL lines (variant playlists, segments)
    if (!trimmed.startsWith('#') && !trimmed.startsWith('<')) {
      const abs = resolveUrl(trimmed, baseUrl);
      return `${proxyBase}${encodeURIComponent(abs)}`;
    }
    return line;
  }).join('\n');
}

const app = express();

// Render/Vercel terminate TLS at their edge; trust the X-Forwarded-Proto so
// rewritten /api/proxy URLs keep the correct https:// scheme.
app.set('trust proxy', true);

// Configure CORS for production
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:3001',
  'https://streamlyvercelin.vercel.app',
];
const frontendUrl = process.env.FRONTEND_URL;
if (frontendUrl) {
  allowedOrigins.push(...frontendUrl.split(',').map(u => u.trim()).filter(Boolean));
}

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS blocked for origin: ${origin}`));
    }
  },
  methods: ['GET', 'POST'],
}));
app.use(express.json());

const PORT = process.env.PORT || 3001;

let browser = null;
let browserBusy = false;
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getBrowser() {
  // Force a fresh launch if cached browser is closed or a launch failed before
  if (!browser || !browser.isConnected()) {
    if (browser) { try { await browser.close(); } catch {} browser = null; }
    const commonArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ];
    const tryLaunch = async (opts) => chromium.launch(opts);
    try {
      browser = await tryLaunch({ headless: true, args: commonArgs });
    } catch (launchErr) {
      // Local dev fallback: connect to a system Chrome/Chromium install
      try {
        browser = await tryLaunch({ headless: true, channel: 'chrome', args: commonArgs });
      } catch (chromeErr) {
        try {
          browser = await tryLaunch({ headless: true, channel: 'chromium', args: commonArgs });
        } catch (chromiumErr) {
          throw new Error(`No usable browser: ${launchErr.message.split('\n')[0]} / ${chromeErr.message.split('\n')[0]}`);
        }
      }
    }
    browser.on('disconnected', () => { browser = null; });
  }
  return browser;
}

function getCineSrcUrl(tmdbId, type, season, episode) {
  if (type === 'tv' && season && episode) {
    return `https://cinesrc.st/embed/tv/${tmdbId}?s=${season}&e=${episode}&color=%230A84FF&autoplay=true&controls=false`;
  }
  return `https://cinesrc.st/embed/movie/${tmdbId}?color=%230A84FF&autoplay=true&controls=false`;
}

/* Detect whether a provider CDN allows the browser to fetch it directly
   (CORS-open). If it does, hls.js plays straight from the CDN — no segment
   relay through this server, which removes the Render-free-tier bottleneck
   that otherwise starves the buffer and causes pauses/reloads. */
async function detectCorsOpen(masterUrl) {
  try {
    const origin = (process.env.FRONTEND_URL || '').split(',')[0]?.trim() || 'https://streamlyvercelin.vercel.app';
    const host = new URL(masterUrl).hostname;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13; SM-S901B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
      Origin: origin,
    };
    if (/bright67|movieboxnoob/.test(host)) {
      headers['Referer'] = 'https://cinesrc.st/';
      headers['Origin'] = origin;
    }
    const res = await fetch(masterUrl, { headers, signal: AbortSignal.timeout(7000) });
    if (!res.ok) return false;
    const acao = (res.headers.get('access-control-allow-origin') || '').toLowerCase();
    if (acao !== '*' && acao !== origin.toLowerCase()) return false;
    // Confirm a real media payload (a variant/segment) also allows cross-origin
    // reads — master-level CORS alone isn't enough.
    const text = await res.text();
    const firstMedia = text.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
    if (!firstMedia) return false;
    const segUrl = new URL(firstMedia, masterUrl).href;
    const seg = await fetch(segUrl, {
      headers: { Range: 'bytes=0-1023', ...headers },
      signal: AbortSignal.timeout(7000),
    });
    const segAcao = (seg.headers.get('access-control-allow-origin') || '').toLowerCase();
    return segAcao === '*' || segAcao === origin.toLowerCase();
  } catch {
    return false;
  }
}

app.get('/api/stream', async (req, res) => {
  const { tmdbId, type = 'movie', season, episode } = req.query;

  if (!tmdbId) {
    return res.status(400).json({ error: 'tmdbId is required' });
  }

  const cacheKey = `${type}:${tmdbId}:${season || ''}:${episode || ''}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    console.log(`[STREAM] Cache hit for ${cacheKey}`);
    return res.json({ ...cached.data, cached: true });
  }

// Serialize access to the shared browser (Render Free tier has limited RAM)
    while (browserBusy) {
      await new Promise(r => setTimeout(r, 200));
    }
    browserBusy = true;
    let context = null;
    let page = null;
    try {
      const b = await getBrowser();
      const cinesrcUrl = getCineSrcUrl(tmdbId, type, season, episode);
      console.log(`[STREAM] Extracting tmdbId=${tmdbId} type=${type}`);

      const capturedUrls = [];
      const subtitleUrls = [];        // subtitle VTT URLs from subs.bright67.online
      const thumbnailUrls = [];       // thumbnail VTT URLs
      const providerSeq = [];         // ordered provider names CineSrc walks through
      const distinctHosts = new Set(); // distinct CDN hosts that emitted streams
      const PROVIDER_NAMES = ['nebula','lisbon','surge','spark','storm','aurora','rush','blizzard','mist','thunder','wave','paris','luna','sturm','brisa'];
      // Session-Key Encrypted (SKE) streams — e.g. the "thunder" fallback CDN
      // (ice.bright67.online) which serves content behind CineSrc's proof-of-work
      // session. These need the real browser session to decrypt, so a direct
      // m3u8 can never be extracted; flag them so the caller can fall back to a
      // native iframe player instead of waiting the full cycle.
      const skeStreams = new Set();
      const startTime = Date.now();

    const openContext = async () => {
      if (context) await context.close().catch(() => {});
      context = await b.newContext();
      page = await context.newPage();
      page.on('request', (request) => {
        const url = request.url();
        // Capture m3u8 streams
        if (/m3u8|\.mpd|manifest/i.test(url) && !url.includes('cinesrc.st')) {
          capturedUrls.push(url);
          try { distinctHosts.add(new URL(url).hostname); } catch {}
          // ice.bright67/?m3u8=<token> — session-key-encrypted (thunder class).
          if (url.includes('ice.bright67') || /[?&]m3u8=/.test(url)) skeStreams.add(url);
        }
        // Capture subtitle VTT files
        if (url.includes('subs.bright67.online') && (url.includes('.vtt') || url.includes('format=vtt') || url.includes('search?id='))) {
          subtitleUrls.push(url);
        }
        // Capture thumbnail sprite sheets
        if (url.includes('thumbnails.vtt') || url.includes('thumbnails/')) {
          thumbnailUrls.push(url);
        }
      });
      // Record the provider names CineSrc displays in its "Trying streaming
      // servers…" status, so we can report the full server cycle it attempted.
      await page.addInitScript((names) => {
        window.__providerSeq = [];
        const scan = () => {
          const t = (document.body ? document.body.innerText : '' ).toLowerCase();
          for (const p of names) {
            if (new RegExp('\\b' + p + '\\b|⭐\\s*' + p).test(t) && !window.__providerSeq.includes(p)) {
              window.__providerSeq.push(p);
            }
          }
        };
        const mo = new MutationObserver(scan);
        const start = () => { scan(); mo.observe(document.body, { childList: true, subtree: true, characterData: true }); };
        if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
        setInterval(scan, 200);
      }, PROVIDER_NAMES);
    };

    // Fresh context per request (browser reused across requests)
    await openContext();
    try {
      await page.goto(cinesrcUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    } catch (gotoErr) {
      // Retry once on navigation timeout (CineSrc can be slow on cold browser)
      console.log(`[STREAM] goto failed, retrying...`);
      await openContext();
      await page.goto(cinesrcUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    }

    // CineSrc picks its provider server-side and cycles through many of them
    // (Nebula -> Lisbon -> Surge -> Spark -> Storm -> Aurora -> Rush -> Blizzard
    // -> Mist -> Thunder -> ...). On titles not served by the fast direct hosts,
    // the regional/fallback CDN (e.g. ice.bright67) is only reached ~19s in, so we
    // must NOT reload (a reload resets the whole cycle) — just wait long enough.
    // ~35s covers the full multi-provider sweep single-pass. If a session-encrypted
    // stream appears (thunder class), a playable direct m3u8 will never surface, so
    // bail early and let the caller use the native iframe.
    const deadline = Date.now() + 35000;
    while (Date.now() < deadline) {
      if (capturedUrls.length > 0) {
        const noDirectYet = !capturedUrls.some(u => /\.(m3u8|mpd)\?|\.m3u8$/i.test(u) || (u.includes('master.m3u8') && !/[?&]m3u8=/.test(u)));
        // Session-encrypted (thunder) streams arrive after the direct sweep; once
        // we see one and no direct playable URL has appeared, stop early.
        if (skeStreams.size > 0 && noDirectYet) break;
        if (capturedUrls.some(u => !/[?&]m3u8=/.test(u) && /\.(m3u8|mpd)(\?|$)/i.test(u))) break;
      }
      await page.waitForTimeout(250);
    }
    const sawSkeOnly = capturedUrls.length > 0 && skeStreams.size === capturedUrls.length;

    // A directly-playable master is an open .m3u8 with no DRM token. Prefer it
    // over AES/query-param tokens like "?m3u8=…" which are session-encrypted and
    // cannot be played by hls.js outside CineSrc.
    const directCandidate = capturedUrls.find(u => /\.(m3u8|mpd)(\?|$)/i.test(u) && !/[?&]m3u8=/.test(u))
      || capturedUrls.find(u => u.includes('master.m3u8'))
      || '';
    const bestUrl = directCandidate || '';
    const encryptedOnly = bestUrl === '' && capturedUrls.length > 0;

    let provider = 'unknown';
    try {
      if (bestUrl) {
        const h = new URL(bestUrl).hostname;
        provider = h.includes('movieboxnoob') ? 'lisbon' : h.includes('bright67') && !h.includes('ice.bright67') ? 'nebula' : h;
      }
    } catch {}

    const elapsed = Date.now() - startTime;
    const sequence = await page.evaluate(() => window.__providerSeq || []).catch(() => []);
    console.log(`[STREAM] ${capturedUrls.length} URLs in ${elapsed}ms (provider=${provider}) seq=[${sequence.join(',')}]`);

    const base = {
      providerSequence: sequence,
      allHosts: [...distinctHosts],
      cinesrcUrl,
      elapsed,
    };

    if (!bestUrl) {
      // No plain master URL. Two cases:
      //  1) Only session-token streams arrived (the ice.bright67/?m3u8=<token>
      //     "thunder" class). These are PoW-minted session URLs that ARE
      //     directly HLS-playable through our proxy (verified end-to-end:
      //     master -> variant -> MPEG-TS segment, no EXT-X-KEY). Serve the best
      //     token URL so the Direct player streams it natively.
      //  2) Truly nothing captured -> the caller falls back to the CineSrc iframe.
      if ((sawSkeOnly || encryptedOnly) && capturedUrls.length > 0) {
        const skeUrl = capturedUrls[0];
        const corsOpen = await detectCorsOpen(skeUrl).catch(() => false);
        const data = {
          streamUrl: skeUrl,
          provider: 'thunder',
          sessionProtected: true,
          corsOpen,
          allUrls: [...new Set(capturedUrls)].slice(0, 8),
          subtitles: [...new Set(subtitleUrls)],
          thumbnails: [...new Set(thumbnailUrls)],
          ...base,
        };
        cache.set(cacheKey, { data, time: Date.now() });
        return res.json(data);
      }
      return res.status(404).json({ error: 'No stream URL found', ...base });
    }

    const data = {
      streamUrl: bestUrl,
      provider,
      corsOpen: await detectCorsOpen(bestUrl).catch(() => false),
      allUrls: [...new Set(capturedUrls)],
      subtitles: [...new Set(subtitleUrls)],
      thumbnails: [...new Set(thumbnailUrls)],
      ...base,
    };

    cache.set(cacheKey, { data, time: Date.now() });
    res.json(data);
  } catch (error) {
    // Browser may have crashed — reset it so next request relaunches
    if (browser) { try { await browser.close(); } catch {} browser = null; }
    console.error(`[STREAM] Error:`, error.message);
    res.status(500).json({ error: error.message });
  } finally {
    browserBusy = false;
    if (context) await context.close().catch(() => {});
  }
});

/* ── NetMirror static resolver ────────────────────────────────
   NetMirror (net77.cc) serves a CORS-open multi-audio HLS master per
   title, but its JSON lookups (search.php / playlist.php) send no CORS
   headers, so they must run server-side. This path is pure HTTP — no
   Playwright, no session, no captcha.
   ────────────────────────────────────────────────────────────── */
const NETMIRROR_TM_PARAM = '1724829817'; // static, reusable per NetMirror archive
let netmirrorMirrorCache = { base: null, time: 0 };

async function discoverNetmirrorMirror() {
  const MIRROR_TTL = 60 * 60 * 1000; // 1h — mirrors rotate
  const cached = netmirrorMirrorCache;
  if (cached.base && Date.now() - cached.time < MIRROR_TTL) return cached.base;
  const defaultBase = 'https://net77.cc';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch('https://netmirror.gg/', { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(t);
    const html = await res.text();
    // netmirror.gg is the master seat; it links the live mirror (net77.cc etc.)
    const m = html.match(/https?:\/\/(net[a-z0-9]+\.cc)/i) || html.match(/\b(net[a-z0-9]+\.cc)\b/i);
    netmirrorMirrorCache = { base: m ? `https://${m[1]}` : defaultBase, time: Date.now() };
  } catch {
    netmirrorMirrorCache = { base: defaultBase, time: Date.now() };
  }
  return netmirrorMirrorCache.base;
}

async function netmirrorSearch(base, title) {
  const res = await fetch(`${base}/search.php?s=${encodeURIComponent(title)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`NetMirror search failed (${res.status})`);
  const data = await res.json();
  // type:1 is the "Top Searches" fallback (no real hit); type:0 has real results
  const results = Array.isArray(data?.searchResult) ? data.searchResult : [];
  const hit = results.find(r => typeof r?.id === 'string') || results[0];
  return hit ? { id: hit.id, name: hit.t || title } : null;
}

async function netmirrorPlaylist(base, id) {
  const res = await fetch(`${base}/playlist.php?id=${encodeURIComponent(id)}&t=&tm=${NETMIRROR_TM_PARAM}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`NetMirror playlist failed (${res.status})`);
  const data = await res.json();
  // NetMirror returns a top-level ARRAY of player configs; the first is the title
  const entry = Array.isArray(data) ? data[0] : data;
  const sources = Array.isArray(entry?.sources) ? entry.sources : [];
  // "Full HD" master = the source WITHOUT a ?q= quality suffix
  const fullHd = sources.find(s => s?.file && !s.file.includes('?q=')) || sources[0];
  if (!fullHd?.file) return null;
  const abs = /^https?:/.test(fullHd.file) ? fullHd.file : base + fullHd.file;
  const captions = (Array.isArray(entry?.tracks) ? entry.tracks : [])
    .filter(t => (t?.kind === 'captions' || t?.kind === 'subtitles') && t?.file)
    .map(t => ({
      label: t.label || 'English',
      url: t.file.startsWith('//') ? `https:${t.file}` : (/^https?:/.test(t.file) ? t.file : base + t.file),
    }));
  const thumbnails = (Array.isArray(entry?.tracks) ? entry.tracks : [])
    .filter(t => t?.kind === 'thumbnails' && t?.file)
    .map(t => (t.file.startsWith('//') ? `https:${t.file}` : /^https?:/.test(t.file) ? t.file : base + t.file));
  return { streamUrl: abs, captions, thumbnails };
}

async function netmirrorAudioLanguages(text) {
  const langs = [];
  for (const m of text.matchAll(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*/g)) {
    const line = m[0];
    const language = (line.match(/LANGUAGE="([^"]*)"/) || [])[1] || '';
    const name = (line.match(/NAME="([^"]*)"/) || [])[1] || language || 'Unknown';
    if (language || name) langs.push({ language, name });
  }
  return langs;
}

/* Lightweight liveness probe: a Cloudflare-fronted media origin answers 2xx to a
   Range'd GET when it is alive, and 5xx/523 when it is not. */
async function netmirrorMediaAlive(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Range: 'bytes=0-2047' },
      signal: AbortSignal.timeout(6000),
    });
    return res.ok || res.status === 206;
  } catch {
    return false;
  }
}

/* Verify the master's media chain is actually playable RIGHT NOW before handing
   it to the player. NetMirror's media CDN (nm-cdn*.top) has repeatedly died
   while the site shell + captions + thumbnails stay up; never serve a broken
   master. */
async function netmirrorPreflight(masterUrl) {
  try {
    const res = await fetch(masterUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', Range: 'bytes=0-4095' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { ok: false, reason: `master http ${res.status}` };
    const text = await res.text();
    const mediaUrls = [...text.matchAll(/https?:\/\/[^\s"']+/g)].map(m => m[0]);
    if (mediaUrls.length === 0) return { ok: false, reason: 'no media urls in master' };
    // Probe all variant/audio playlists in parallel so one alive CDN is found fast
    const alive = await Promise.all(mediaUrls.slice(0, 6).map(u => netmirrorMediaAlive(u)));
    const idx = alive.findIndex(Boolean);
    if (idx < 0) return { ok: false, reason: 'media hosts unreachable' };
    const verified = mediaUrls[idx];
    return { ok: true, audioLanguages: netmirrorAudioLanguages(text), mediaHost: new URL(verified).hostname };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

app.get('/api/netmirror', async (req, res) => {
  const { title, type = 'movie', mirror } = req.query;
  if (!title) return res.status(400).json({ error: 'title is required' });

  const cacheKey = `netmirror:${title}:${type}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.time < (cached.ttl || CACHE_TTL)) {
    return res.json({ ...cached.data, cached: true });
  }

  try {
    // Candidate mirrors: explicit override, then discovered + known-live fallbacks
    const discovered = await discoverNetmirrorMirror();
    const candidates = [];
    const pushMirror = (m) => {
      if (/^https:\/\/(net[a-z0-9]+\.cc)$/i.test(m || '') && !candidates.includes(m)) candidates.push(m);
    };
    pushMirror(mirror);
    pushMirror(discovered);
    pushMirror('https://net77.cc');
    pushMirror('https://net52.cc');

    for (const base of candidates) {
      const hit = await netmirrorSearch(base, title).catch(() => null);
      if (!hit) continue;
      const pl = await netmirrorPlaylist(base, hit.id).catch(() => null);
      if (!pl) continue;
      const pf = await netmirrorPreflight(pl.streamUrl);
      if (!pf.ok) continue;

      const data = {
        title,
        contentId: hit.id,
        mirror: base,
        provider: 'netmirror',
        streamUrl: pl.streamUrl, // CORS-open — hls.js can fetch it directly
        corsOpen: true,
        audioLanguages: pf.audioLanguages,
        mediaHost: pf.mediaHost,
        subtitles: pl.captions,
        thumbnails: pl.thumbnails,
      };
      cache.set(cacheKey, { data, time: Date.now(), ttl: 90 * 1000 }); // CDN flaps — don't cache success long
      return res.json(data);
    }

    const msg = {
      error: 'NetMirror is temporarily unavailable (no reachable media host)',
      unreachable: true,
      mirror: candidates[0] || discovered,
      attempted: candidates,
    };
    console.warn(`[NETMIRROR] unreachable for "${title}" via [${candidates.join(', ')}]`);
    return res.status(503).json(msg);
  } catch (error) {
    console.error('[NETMIRROR] error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/* ── CORS Proxy ────────────────────────────────────────────────
   Fetches any URL server-side and returns it with CORS headers.
   For m3u8 content, rewrites internal URLs so sub-playlists and
   segments also route through this proxy.
   ────────────────────────────────────────────────────────────── */
app.get('/api/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url query param required' });

  try {
    const upstreamHeaders = {};
    if (req.headers.range) upstreamHeaders['Range'] = req.headers.range;
    if (req.headers['if-range']) upstreamHeaders['If-Range'] = req.headers['if-range'];
    // Present a browser profile upstream for session-token CDNs (the
    // PoW-protected ice.bright67 "thunder" class) — they reject bare/undici
    // requests and, when served behind Cloudflare, can answer 522 without a
    // normal UA. Plain direct CDNs (nebula etc.) keep the default headers.
    const upstreamHost = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
    if (/bright67|ice\./.test(upstreamHost)) {
      upstreamHeaders['User-Agent'] =
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36';
      upstreamHeaders['Referer'] = 'https://cinesrc.st/';
      upstreamHeaders['Origin'] = 'https://cinesrc.st';
    }

    const response = await fetch(url, { headers: upstreamHeaders });
    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    // Read the first chunk so we can detect m3u8 by content signature (CDNs
    // often serve m3u8 with wrong Content-Type or .jpg/.bin extensions), then
    // STREAM the rest — never buffer a whole segment/variant. Buffering the
    // full body through a small instance is what starves the player buffer,
    // causing pauses and reloads.
    const reader = response.body.getReader();
    const { value: firstChunk } = await reader.read();
    const head = Buffer.from(firstChunk || []).toString('utf8', 0, 64);
    const isM3u8 = head.trimStart().startsWith('#EXTM3U') ||
                   contentType.includes('mpegurl') || contentType.includes('x-mpegurl');

    if (isM3u8) {
      let body = Buffer.alloc(0);
      if (firstChunk) body = Buffer.concat([body, firstChunk]);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        body = Buffer.concat([body, value]);
      }
      const text = body.toString('utf8');
      const proxyBase = `${req.protocol}://${req.get('host')}/api/proxy?url=`;
      const rewritten = rewriteM3u8(text, url, proxyBase);
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Content-Length', Buffer.byteLength(rewritten));
      res.send(rewritten);
    } else {
      res.status(response.status);
      const cr = response.headers.get('content-range');
      if (cr) res.set('Content-Range', cr);
      const cl = response.headers.get('content-length');
      if (cl) res.set('Content-Length', cl);
      res.set('Content-Type', contentType);
      if (firstChunk) res.write(Buffer.from(firstChunk));
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    }
  } catch (e) {
    console.error('[PROXY] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', browser: browser?.isConnected() ? 'connected' : 'disconnected' });
});

process.on('SIGINT', async () => { if (browser) await browser.close(); process.exit(0); });
process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(0); });

app.listen(PORT, () => {
  console.log(`Stream service on port ${PORT}`);
  // Warm up the browser so the first request isn't a cold start
  getBrowser().then(() => console.log('[WARMUP] Browser ready')).catch(e => console.log('[WARMUP] Failed:', e.message));
});
