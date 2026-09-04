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
        provider = h.includes('movieboxnoob') ? 'lisbon' : h.includes('bright67') ? 'nebula' : h;
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
      // No direct-playable URL. If we only saw encrypted token URLs (e.g. the
      // ice.bright67 "?m3u8=…" form), that content is session-key-protected and
      // can only be watched through CineSrc's own iframe player — the frontend
      // auto-falls-back to the iframe in that case.
      if (sawSkeOnly || encryptedOnly) {
        const detail = {
          error: 'Stream is session/AES-protected — playable only via iframe',
          encrypted: true,
          requiresIframe: true,
          cinesrcUrl,
          allUrls: [...new Set(capturedUrls)].slice(0, 5),
        };
        return res.status(404).json({ ...detail, ...base });
      }
      return res.status(404).json({ error: 'No stream URL found', ...base });
    }

    const data = {
      streamUrl: bestUrl,
      provider,
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

    const response = await fetch(url, { headers: upstreamHeaders });
    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    // Read entire response into buffer so we can detect m3u8 by content signature
    // (CDNs often serve m3u8 with wrong Content-Type or .jpg/.bin extensions)
    const bodyBuffer = Buffer.from(await response.arrayBuffer());
    const head = bodyBuffer.toString('utf8', 0, 64);
    const isM3u8 = head.trimStart().startsWith('#EXTM3U') ||
                   contentType.includes('mpegurl') || contentType.includes('x-mpegurl');

    if (isM3u8) {
      const text = bodyBuffer.toString('utf8');
      const proxyBase = `https://${req.get('host')}/api/proxy?url=`;
      const rewritten = rewriteM3u8(text, url, proxyBase);
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Content-Length', Buffer.byteLength(rewritten));
      res.send(rewritten);
    } else {
      const cl = response.headers.get('content-length');
      if (cl) res.set('Content-Length', cl);
      const cr = response.headers.get('content-range');
      if (cr) res.set('Content-Range', cr);
      res.set('Content-Type', contentType);
      res.end(bodyBuffer);
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
