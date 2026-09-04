# Streamly Direct Stream Service

Playwright-based microservice that extracts direct HLS (m3u8) stream URLs from the CineSrc embed pages, so the frontend can play video natively with `hls.js` instead of relying on cross-origin iframes (which get blocked by Cloudflare).

## How it works

1. Receives `tmdbId`, `type` (movie/tv), `season`, `episode`
2. Launches a real Chromium via Playwright
3. Loads the CineSrc embed page for that title
4. Intercepts network requests and captures the first `master.m3u8` URL
5. Returns the m3u8 URL to the frontend for native HLS playback
6. Caches results for 5 minutes

The extracted m3u8 URLs (`https://nebula.bright67.online/hls/...`) are served with CORS `access-control-allow-origin: *`, so `hls.js` can play them directly in the browser.

## API

```
GET /api/stream?tmdbId=550&type=movie
GET /api/stream?tmdbId=1399&type=tv&season=1&episode=1
GET /api/health
```

Response:
```json
{
  "streamUrl": "https://nebula.bright67.online/hls/.../master.m3u8",
  "allUrls": [...],
  "cinesrcUrl": "https://cinesrc.st/embed/movie/550",
  "elapsed": 4600,
  "cached": false
}
```

## Local development

```bash
cd stream-service
npm install
npx playwright install chromium   # install the browser binary
node server.js                    # runs on port 3001
```

## Deployment (Render)

This service **cannot** run on Vercel serverless (no Chromium binary). Deploy it on Render as a **Web Service**:

Option A — Docker (recommended):
1. Push the `stream-service/` folder to its own repo (or a subfolder of this repo)
2. In Render dashboard → New → Web Service
3. Select the repo
4. Set:
   - **Root Directory**: `stream-service`
   - **Environment**: `Docker`
   - (the included `Dockerfile` uses `mcr.microsoft.com/playwright` which has Chromium pre-installed)
5. Port: `3001`
6. Free tier works but cold-starts take ~30-60s (the service warms up the browser on boot)

Option B — Native + install Chromium:
1. Root: `stream-service`
2. Build: `npm install && npx playwright install chromium --with-deps`
3. Start: `npm start`

## Frontend configuration

Set the deployed service URL in `frontend/.env`:

```
VITE_STREAM_SERVICE_URL=https://your-stream-service.onrender.com
```

The "Direct" server (first in the server list) uses this service. If it's not configured, the player falls back to the iframe-based servers.
