# SalBet Server

A Node.js + Express + Postgres backend for SalBet: accounts, wallets, daily
login rewards, friends, gifting, head-to-head duels, a fake (demo-only) coin
shop, and a character-pack shop. Real-time features (live player count,
friend requests, gift notifications, duel challenges) run over WebSocket.

**This is a play-money site.** `/api/shop/buy-coins` never touches a real
payment processor — it just adds in-game currency and returns a message
saying no real charge was made. Do not wire in a real payment provider
without adding age verification, KYC, and the applicable gambling license
for your jurisdiction.

**Database:** this runs on Postgres, not a local file, specifically so it
works on Render's free tier (which can't attach a paid disk). Supabase
gives you a free, permanent Postgres database — no credit card, no disk fee.

## 1. Create your free Supabase database

1. Go to https://supabase.com and sign up (GitHub login is easiest).
2. New Project → pick any name and a database password (save it somewhere).
3. Once it's created: Project Settings (gear icon) → Database → Connection
   string → URI. Copy it. It looks like:
   `postgresql://postgres:[YOUR-PASSWORD]@db.xxxxxxxx.supabase.co:5432/postgres`
4. Replace `[YOUR-PASSWORD]` with the database password from step 2.

That full string is your `DATABASE_URL`.

## 2. Local setup (optional, to test before deploying)

```bash
cd salbet-server
npm install
cp .env.example .env
```

Edit `.env`:
- `JWT_SECRET` — any long random string. Generate one with:
  `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
- `DATABASE_URL` — the Supabase connection string from step 1.

Run it:

```bash
npm start
```

You should see `Database ready.` then `SalBet server running on port 3000`.
Check it with `curl http://localhost:3000/api/health`.

The first account created with `asOwner: true` becomes the permanent owner
account (the frontend's "Set up owner account" link does this for you, and
disappears once an owner exists — see `/api/auth/owner-exists`).

## 3. Deploy on Render (free, no disk needed)

1. Push this `salbet-server` folder to a GitHub repo.
2. Render dashboard → New → Web Service → connect that repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Environment tab → Add variable, twice:
   - `JWT_SECRET` = your random string
   - `DATABASE_URL` = your Supabase connection string
   - (Don't set `PORT` — Render sets it automatically)
5. Deploy. Render gives you a URL like `https://salbet-server.onrender.com`.
   The free tier sleeps after 15 minutes of inactivity and takes ~30 seconds
   to wake up on the next request — fine for a demo, not for production.

No Disks tab, no payment needed anywhere in this setup.

## 4. What's in here

- `src/db.js` — Postgres schema, connection pool, and seed data (site
  settings, original fictional pack characters — no real people).
- `src/auth.js` — password hashing (bcrypt) and JWT session tokens.
- `src/server.js` — all REST routes plus the WebSocket server for live
  presence and real-time notifications (friend requests, gifts, duel
  challenges/results, big-win broadcasts).

## 5. API summary

| Area | Routes |
|---|---|
| Auth | `POST /api/auth/signup`, `POST /api/auth/login`, `GET /api/auth/owner-exists`, `GET /api/me` |
| Wallet | `POST /api/bet`, `POST /api/win`, `GET /api/bigwins`, `GET /api/stats` |
| Daily rewards | `GET /api/daily/status`, `POST /api/daily/claim` |
| Fake coin shop | `GET /api/shop/coin-packs`, `POST /api/shop/buy-coins` |
| Character packs | `GET /api/shop/characters`, `POST /api/shop/open-pack`, `GET /api/shop/inventory`, `POST /api/shop/sell` |
| Friends | `GET /api/friends`, `POST /api/friends/request`, `POST /api/friends/accept`, `POST /api/friends/decline` |
| Gifting | `POST /api/gift` (friends only) |
| Multiplayer | `GET /api/online`, `POST /api/duel/challenge`, `POST /api/duel/accept`, `POST /api/duel/decline` |
| Owner panel | `GET /api/owner/users`, `POST /api/owner/adjust`, `POST /api/owner/give-all`, `POST /api/owner/ban`, `POST /api/owner/delete`, `GET/POST /api/owner/settings`, `POST /api/owner/reset-totals`, `POST /api/owner/clear-bigwins` |
| Realtime (WebSocket) | `wss://.../ws?token=<jwt>` — sends `presence`, `bigwin`, `gift`, `duel_challenge`, `duel_result`, `settings_updated` events |

All routes except signup/login/health/owner-exists/bigwins/stats/shop
listings require `Authorization: Bearer <token>`.

## Tested

Before packaging, every route above was run end-to-end against a real
Postgres database, including: duplicate usernames, a second owner attempt,
wrong-password login, double daily-claim, over-limit bets, friend
request → accept → gift, pack opening → selling, a full duel challenge →
accept flow, owner-only route protection, and — most importantly — killing
the server process and starting a fresh one to confirm balances and
accounts survive a restart.
