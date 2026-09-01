# 🗄️ Streamly Backend — Git Guide

> **NestJS API** · TypeScript · Node.js · TMDB · JWT Auth · Torrent Streaming
>
> Repository: `github.com/Nashid-k/streamly-backend` · Branch: `main`

---

## 📋 Table of Contents

- [Repository Overview](#-repository-overview)
- [Branch Strategy](#-branch-strategy)
- [Commit Message Convention](#-commit-message-convention)
- [Daily Workflow](#-daily-workflow)
- [Working with Modules](#-working-with-modules)
- [Environment & Secrets](#-environment--secrets)
- [Useful Git Aliases](#-useful-git-aliases)
- [Undoing Mistakes](#-undoing-mistakes)
- [Deployment Flow](#-deployment-flow)
- [Commit History Highlights](#-commit-history-highlights)

---

## 🗺️ Repository Overview

```
backend/
├── src/
│   ├── main.ts                  ← Bootstrap (port, CORS, compression)
│   ├── app.module.ts            ← Root NestJS module (Cache, Config, modules)
│   ├── app.controller.ts        ← Health-check endpoint
│   │
│   ├── auth/                    ← JWT auth module
│   │   ├── auth.controller.ts   ← POST /api/auth/register|login, GET /me
│   │   ├── auth.service.ts      ← SHA-256 hashing, JWT sign/verify, JSON persistence
│   │   ├── auth.module.ts
│   │   └── auth.types.ts        ← AuthUser, JwtPayload, ContinueWatchingItem
│   │
│   ├── movies/                  ← TMDB-powered catalog
│   │   ├── movies.controller.ts ← GET /api/movies, /featured, /categories, /search, /:id
│   │   ├── movies.service.ts    ← Platform routing, TMDB aggregation (71 KB!)
│   │   ├── stream.controller.ts ← GET /stream?magnet= (torrent piping, byte-range)
│   │   ├── torrent.service.ts   ← Engine lifecycle helpers
│   │   ├── movies.module.ts
│   │   └── movies.types.ts      ← Movie, Episode, Category, StreamSource
│   │
│   ├── users/                   ← Guest-mode profile & watchlist
│   │   ├── users.controller.ts  ← GET|POST /api/user, /mylist, /preferences
│   │   ├── users.service.ts
│   │   ├── users.module.ts
│   │   └── users.types.ts
│   │
│   └── utils/                   ← Shared helpers
│
├── data/                        ← ⚠️  gitignored — JSON user store (runtime)
├── dist/                        ← ⚠️  gitignored — compiled output
├── .env                         ← ⚠️  gitignored — secrets
├── tsconfig.json
├── tsconfig.build.json
└── package.json
```

---

## 🌿 Branch Strategy

```
main  ────────────────────────────────────────────────────────► production
        │
        ├── feat/anime-domains          feature branches
        ├── fix/tmdb-throttle
        ├── perf/api-pagination
        └── chore/code-cleanup
```

| Branch pattern | Purpose | Merges into |
|---|---|---|
| `main` | Stable, deployed to Render | — |
| `feat/<name>` | New features (platforms, endpoints) | `main` via PR |
| `fix/<name>` | Bug fixes | `main` via PR |
| `perf/<name>` | Performance work | `main` via PR |
| `chore/<name>` | Cleanup, deps, config | `main` via PR |

### Creating a feature branch

```bash
# Always branch from the latest main
git switch main
git pull origin main

git switch -c feat/add-hotstar-support
```

---

## 💬 Commit Message Convention

This repository follows **Conventional Commits** — the existing history is a perfect template:

```
<type>(<optional scope>): <short description>

[optional body]

[optional footer: Breaking-change, Closes #issue]
```

### Allowed types

| Type | When to use | Example |
|---|---|---|
| `feat` | New endpoint, platform, or capability | `feat: add SonyLIV platform support` |
| `fix` | Bug repair | `fix: resolve TMDB fetch failures by throttling` |
| `perf` | Speed / memory improvements | `perf: API payload pagination, cached aggregations` |
| `refactor` | Same behavior, restructured code | `refactor: remove 150-day window check` |
| `chore` | Deps, CI, build config, cleanup | `chore: code cleanup` |
| `style` | Formatting only (no logic change) | `style: reorder imports in movies.service` |
| `docs` | Documentation updates | `docs: update API endpoint table in GIT.md` |
| `test` | Adding or fixing tests | `test: add auth service unit tests` |

### ✅ Good commit messages

```
feat: expose popularity score for authentic top 10 mixer
fix: filter out theatrical cam-rips from streaming results
perf: reduce poster image payload sizes to w500
refactor: remove strict TMDB monetization filters that broke non-Netflix platforms
```

### ❌ Bad commit messages

```
update stuff
WIP
fixed
changes
```

---

## 🔄 Daily Workflow

### 1. Start your day

```bash
cd backend

# Fetch remote changes without merging
git fetch origin

# See what's new on the remote
git log origin/main..HEAD --oneline

# Pull the latest
git pull origin main
```

### 2. Make a change

```bash
# Create a branch
git switch -c fix/season-episode-empty-state

# ... edit files ...

# Stage specific files (recommended over git add -A)
git add src/movies/movies.service.ts
git add src/movies/movies.controller.ts

# Check what you're about to commit
git diff --staged

# Commit
git commit -m "fix: resolve TV show empty state and bypass cache"
```

### 3. Before pushing — sync with main

```bash
# Rebase keeps history clean (preferred over merge)
git fetch origin
git rebase origin/main

# Resolve any conflicts, then
git rebase --continue
```

### 4. Push and open a PR

```bash
git push origin fix/season-episode-empty-state
# → Open PR on GitHub: main ← fix/season-episode-empty-state
```

---

## 🏗️ Working with Modules

### Adding a new NestJS module

```bash
git switch -c feat/notifications-module

# Create files
touch src/notifications/notifications.module.ts
touch src/notifications/notifications.service.ts
touch src/notifications/notifications.controller.ts
touch src/notifications/notifications.types.ts

# Stage the whole new folder
git add src/notifications/

git commit -m "feat: scaffold notifications module"
```

### Modifying the movies service (large file ~71 KB)

`movies.service.ts` is large. Use precise staging:

```bash
# Stage only what changed — avoid accidentally staging generated files
git add src/movies/movies.service.ts

# Review the diff carefully before committing
git diff --staged src/movies/movies.service.ts | head -100
```

### Updating environment validation (app.module.ts)

```bash
git add src/app.module.ts
git commit -m "feat: add REDIS_URL env var validation for caching"
```

---

## 🔒 Environment & Secrets

> **Never commit `.env` files.** They are already in `.gitignore`.

```
.env                  ← gitignored ✅
node_modules/         ← gitignored ✅
dist/                 ← gitignored ✅
data/                 ← gitignored ✅ (JSON user store — runtime data)
*.log                 ← gitignored ✅
```

### Required environment variables

```bash
# .env (local — never commit)
PORT=4000
TMDB_API_KEY=your_tmdb_v3_key_here
TMDB_READ_TOKEN=your_tmdb_v4_bearer_token   # optional
RAPIDAPI_KEY=your_rapidapi_key              # optional
FRONTEND_URL=http://localhost:5173
STREAMLY_SALT=your_secret_salt              # for password hashing
USERS_STATE_FILE=./data/users.json          # path to user store
JWT_SECRET=your_jwt_secret_here
```

### Sharing secrets safely

```bash
# Create a template file — this IS committed
cp .env .env.example
# Edit .env.example to remove real values, replace with placeholders
git add .env.example
git commit -m "chore: add .env.example with required variable names"
```

---

## ⚡ Useful Git Aliases

Add these to your `~/.gitconfig` `[alias]` section:

```ini
[alias]
  lg    = log --oneline --graph --decorate --all
  st    = status -sb
  sw    = switch
  oops  = commit --amend --no-edit
  wip   = !git add -A && git commit -m "wip: work in progress [skip ci]"
  undo  = reset HEAD~1 --mixed
  last  = log -1 HEAD --stat
  who   = shortlog -n -s --no-merges
  nuke  = !git reset --hard && git clean -fd
```

### Usage

```bash
git lg          # beautiful branching log
git st          # compact status
git oops        # fix last commit (forgot to stage a file)
git undo        # unstage last commit, keep changes
git wip         # quick save-point commit
git nuke        # ⚠️  destroy all local changes
```

---

## 🩹 Undoing Mistakes

### Undo the last commit (keep changes staged)

```bash
git reset --soft HEAD~1
```

### Undo the last commit (keep changes unstaged)

```bash
git reset --mixed HEAD~1   # or: git undo (alias above)
```

### Discard all local changes to a file

```bash
git checkout -- src/movies/movies.service.ts
```

### Accidentally committed `.env`

```bash
# Remove from tracking WITHOUT deleting the file
git rm --cached .env
echo ".env" >> .gitignore
git add .gitignore
git commit -m "fix: stop tracking .env — security cleanup"

# ⚠️  If already pushed, rotate your secrets immediately!
```

### Revert a bad commit that is already on `main`

```bash
git revert <commit-hash>
# Creates a NEW commit that undoes the bad one — safe for shared history
git push origin main
```

### Stash work in progress

```bash
# Save without committing
git stash push -m "wip: throttle TMDB concurrency experiment"

# List stashes
git stash list

# Restore
git stash pop
```

---

## 🚀 Deployment Flow

The backend is deployed on **Render** and is triggered by pushes to `main`.

```
Local branch
    │
    │  git push origin feat/xxx
    ▼
GitHub PR review
    │
    │  Squash & merge into main
    ▼
main branch pushed
    │
    │  Render auto-deploys on push to main
    ▼
Production (Render)
    build: npm run build  (tsc -p tsconfig.build.json)
    start: npm start      (node dist/main.js)
```

### Pre-push checklist

```bash
# 1. Build compiles cleanly
npm run build

# 2. No secrets in staged files
git diff --staged | grep -i "api_key\|secret\|password\|token" && echo "⚠️  SECRET FOUND" || echo "✅ Clean"

# 3. Commit message is conventional
git log -1 --format="%s"
```

---

## 📜 Commit History Highlights

> Real commits from this repository — a great style reference.

| Hash | Type | Description |
|---|---|---|
| `769673e` | `feat` | Fully dynamic genre domains instead of hardcoded |
| `8e87353` | `feat` | Add new curated Anime domains/categories |
| `2edf768` | `perf` | Major performance overhauls (API payload pagination, cached aggregations) |
| `e50a737` | `perf` | Reduce poster image payload sizes to w500 to boost UI load times |
| `85b260b` | `fix` | Resolve TMDB fetch failures by throttling concurrent requests |
| `8725294` | `fix` | Resolve TV shows empty state, expand genres, and bypass cache |
| `13e8869` | `fix` | Remove strict TMDB monetization filters that broke non-Netflix platforms |
| `8afb666` | `feat` | Add support for Apple TV+, Zee5, Sony LIV, and JioCinema platforms |
| `362a6e7` | `refactor` | Remove 150-day window check, rely on TMDB native parameters |
| `96df3fb` | `feat` | Strict OTT release verification logic |

---

## 🔗 Quick Reference Card

```bash
# ── Setup ──────────────────────────────────────────────
git clone https://github.com/Nashid-k/streamly-backend.git backend
cd backend && npm install && cp .env.example .env   # fill in your keys

# ── Every day ──────────────────────────────────────────
git switch main && git pull origin main
git switch -c feat/your-feature

# ── Stage & commit ─────────────────────────────────────
git add src/path/to/changed/file.ts
git commit -m "type: short description of what changed"

# ── Sync before PR ─────────────────────────────────────
git fetch origin && git rebase origin/main
git push origin feat/your-feature

# ── Emergency rollback on main ─────────────────────────
git revert <bad-commit-hash>
git push origin main
```

---

*Last updated: August 2026 · Streamly Backend v1.0.0*
