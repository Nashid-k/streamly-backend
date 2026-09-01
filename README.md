<div align="center">

# 🗄️ Streamly — Backend

[![NestJS](https://img.shields.io/badge/NestJS-10-E0234E?logo=nestjs&logoColor=white)](https://nestjs.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Firebase Admin](https://img.shields.io/badge/Firebase_Admin-14-FFCA28?logo=firebase&logoColor=black)](https://firebase.google.com/docs/admin/setup)
[![TMDB](https://img.shields.io/badge/TMDB-API-01D277)](https://www.themoviedatabase.org)
[![Render](https://img.shields.io/badge/Deployed_on-Render-46E3B7?logo=render)](https://render.com)

**NestJS REST API powering the Streamly streaming platform**

</div>

---

## 📋 Table of Contents

- [Setup](#-setup)
- [Environment Variables](#-environment-variables)
- [Project Structure](#-project-structure)
- [API Reference](#-api-reference)
- [Firebase Integration](#-firebase-integration)
- [Caching Strategy](#-caching-strategy)
- [Deployment](#-deployment)

---

## ⚡ Setup

```bash
# Install dependencies
npm install

# Copy env template and fill in your values
cp .env.example .env

# Start development server (ts-node-dev with hot reload)
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

---

## 🔑 Environment Variables

Create a `.env` file in `backend/` with the following:

```bash
# ─── Server ───────────────────────────────────────────────────────────────────
PORT=4000
FRONTEND_URL=http://localhost:5173   # comma-separated for multiple origins

# ─── TMDB (required) ──────────────────────────────────────────────────────────
TMDB_API_KEY=your_tmdb_v3_api_key
TMDB_READ_TOKEN=your_tmdb_v4_bearer_token   # optional but recommended

# ─── RapidAPI (optional) ──────────────────────────────────────────────────────
RAPIDAPI_KEY=your_rapidapi_key

# ─── Firebase Admin SDK (required) ────────────────────────────────────────────
# Get from: Firebase Console → Project Settings → Service Accounts → Generate new private key
FIREBASE_PROJECT_ID=streamly-731c4
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxx@streamly-731c4.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
# Note: keep the \n as literal characters in the .env file — the code converts them at runtime
```

> ⚠️ **Never commit `.env`** — it is already in `.gitignore`. Use `.env.example` for sharing variable names.

---

## 🗂️ Project Structure

```
backend/src/
├── main.ts                    ← Bootstrap: port, CORS, gzip compression
├── app.module.ts              ← Root module: cache, config, all sub-modules
├── app.controller.ts          ← GET / health check
│
├── firebase/
│   ├── firebase-admin.ts      ← Firebase Admin SDK v14 singleton init
│   └── firebase.module.ts     ← Global NestJS FirebaseAdminService provider
│
├── auth/
│   ├── auth.controller.ts     ← GET /api/auth/me, /mylist, /continue-watching
│   ├── auth.service.ts        ← Firebase token verification + Firestore user data
│   ├── auth.module.ts         ← Auth module wiring
│   └── auth.types.ts          ← ContinueWatchingItem interface
│
├── movies/
│   ├── movies.controller.ts   ← GET /api/movies/* — catalog & search
│   ├── movies.service.ts      ← TMDB aggregation for all 7 platforms (~71 KB)
│   ├── stream.controller.ts   ← GET /stream?magnet= — torrent byte-range streaming
│   ├── torrent.service.ts     ← Engine lifecycle helpers
│   ├── movies.module.ts
│   └── movies.types.ts        ← Movie, Episode, Category, StreamSource
│
├── users/
│   ├── users.controller.ts    ← GET|POST /api/user — guest-mode profile
│   ├── users.service.ts       ← In-memory + JSON-persisted single-user state
│   ├── users.module.ts
│   └── users.types.ts         ← User, UserProfile, UserPreferences
│
└── utils/                     ← Shared helpers
```

---

## 📡 API Reference

### Base URL
- **Local:** `http://localhost:4000`
- **Production:** `https://streamly-backend-9q7i.onrender.com`

---

### 🔐 Auth  `/api/auth`

All auth endpoints accept a `Authorization: Bearer <firebase-id-token>` header.

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| `GET` | `/api/auth/me` | ✅ Required | Returns Firebase user profile |
| `GET` | `/api/auth/mylist` | ✅ Required | Returns user's My List from Firestore |
| `POST` | `/api/auth/mylist/toggle` | ✅ Required | Toggle movie in/out of My List |
| `GET` | `/api/auth/continue-watching` | Optional | Returns Continue Watching list |
| `POST` | `/api/auth/continue-watching` | ✅ Required | Upsert watch progress entry |
| `DELETE` | `/api/auth/continue-watching/:movieId` | ✅ Required | Remove entry from CW list |

**POST `/api/auth/mylist/toggle` body:**
```json
{ "movie": { "id": "tt1234", "title": "Movie Name", "posterUrl": "..." } }
```

**POST `/api/auth/continue-watching` body:**
```json
{
  "movieId": "tt1234",
  "title": "Movie Name",
  "posterUrl": "https://...",
  "progressSeconds": 1234,
  "durationSeconds": 7200,
  "platform": "nflix",
  "updatedAt": 1724567890000
}
```

---

### 🎬 Movies  `/api/movies`

All movie endpoints support `?platform=` query param.

**Platforms:** `nflix` | `nprime` | `hotstar` | `appletv` | `zee5` | `sonyliv` | `jio`

| Method | Endpoint | Cache | Description |
|---|---|---|---|
| `GET` | `/api/movies` | 2 min | All movies for a platform |
| `GET` | `/api/movies/featured` | 2 min | Featured/banner movies |
| `GET` | `/api/movies/categories` | 2 min | Category rows |
| `GET` | `/api/movies/top10` | 2 min | Top 10 by popularity |
| `GET` | `/api/movies/search?q=&genre=` | 1 hr | Cross-platform search |
| `GET` | `/api/movies/person/:personId` | 24 hr | Actor/director profile |
| `GET` | `/api/movies/:id` | 24 hr | Movie/show detail |
| `GET` | `/api/movies/:id/similar` | 24 hr | Similar content |
| `GET` | `/api/movies/:id/recommendations` | 5 min | Recommendations |
| `GET` | `/api/movies/:id/season/:n` | 24 hr | Season episode list |
| `GET` | `/api/movies/:id/intro` | 24 hr | Intro/outro skip timings |

---

### 📺 Stream  `/stream`

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/stream?magnet=<uri>` | Stream video from magnet link (byte-range supported) |
| `GET` | `/stream?title=<name>&year=<year>` | Auto-search torrent then stream |

---

### 👤 Guest User  `/api/user`

Guest-mode endpoints (no auth required — stored in memory + JSON file).

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/user` | Get guest user object |
| `POST` | `/api/user/profile/:id` | Switch active profile |
| `GET` | `/api/user/mylist` | Get guest My List |
| `POST` | `/api/user/mylist/toggle` | Toggle movie in guest My List |
| `POST` | `/api/user/preferences` | Update language/dubbing preferences |
| `GET` | `/api/user/continue-watching` | Get guest Continue Watching |
| `POST` | `/api/user/continue-watching` | Update guest watch progress |
| `DELETE` | `/api/user/continue-watching/:movieId` | Remove from guest CW list |

---

## 🔥 Firebase Integration

The backend uses **Firebase Admin SDK v14** to:
1. **Verify ID tokens** — the frontend (Firebase Web SDK) signs in the user and sends an ID token; the backend verifies it server-side
2. **Read/write Firestore** — authenticated users' My List and Continue Watching are stored in `/users/{uid}` Firestore documents

```
Frontend (Firebase Auth)
    │
    │  Firebase ID Token (JWT, 1-hour TTL)
    ▼
Backend (Firebase Admin SDK)
    │  verifyIdToken() → DecodedIdToken { uid, email, ... }
    │
    ▼
Firestore /users/{uid}
    { myList: [...], continueWatching: [...] }
```

---

## ⚡ Caching Strategy

| Level | TTL | Scope |
|---|---|---|
| NestJS `CacheInterceptor` | 4 hours | All `/api/movies/*` routes (in-memory) |
| HTTP `Cache-Control` header | 2 min – 24 hr | Browser / CDN cache per endpoint |
| Firestore | Persistent | User data (no TTL) |

To upgrade to Redis caching in production:
```bash
npm install @keyv/redis cacheable
```
Then update `CacheModule.register()` in `app.module.ts`.

---

## 🚀 Deployment

Deployed on **Render** (free tier). Auto-deploys on push to `main`.

### Build & start commands (Render dashboard)
```bash
# Build command
npm run build

# Start command
npm start
```

### Required Render environment variables
```
PORT                    = 4000   (Render sets this automatically)
TMDB_API_KEY            = ...
TMDB_READ_TOKEN         = ...
RAPIDAPI_KEY            = ...
FRONTEND_URL            = https://your-app.vercel.app
FIREBASE_PROJECT_ID     = streamly-731c4
FIREBASE_CLIENT_EMAIL   = firebase-adminsdk-fbsvc@streamly-731c4.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY    = -----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n
```

> ⚠️ Render free-tier servers **spin down after 15 minutes of inactivity**. The frontend shows a "Server waking up…" banner during cold starts.

---

## 📖 More Documentation

- [Git workflow guide](GIT.md)
- [Frontend README](../frontend/README.md)
