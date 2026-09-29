# SalBet Server

A Node.js + Express + SQLite backend for SalBet: accounts, wallets, daily
login rewards, friends, gifting, head-to-head duels, a fake (demo-only) coin
shop, and a character-pack shop. Real-time features (live player count,
friend requests, gift notifications, duel challenges) run over WebSocket.

**This is a play-money site.** `/api/shop/buy-coins` never touches a real
payment processor — it just adds in-game currency and returns a message
saying no real charge was made. Do not wire in a real payment provider
without adding age verification, KYC, and the applicable gambling license
for your jurisdiction.

## 1. Local setup

```bash
cd salbet-server
npm install
cp .env.example .env
```

Open `.env` and set `JWT_SECRET` to a long random string:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste the output in as `JWT_SECRET=...`.

Then run it:

```bash
npm start
```

You should see `SalBet server running on port 3000`. Check it with:

```bash
curl http://localhost:3000/api/health
```

The first account created with `asOwner: true` becomes the permanent owner
account (the frontend's "Set up owner account" link does this for you, and
disappears once an owner exists — see `/api/auth/owner-exists`).

## 2. Deploying somewhere persistent (Render, free tier)

Render's free web service is enough to get started and needs no credit card.

1. Push this `salbet-server` folder to a GitHub repo (can be private).
2. Go to https://render.com → New → Web Service → connect that repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Add a **persistent disk** (Render dashboard → your service → Disks →
   Add Disk), mount path `/data`, 1 GB is plenty. Without this, your SQLite
   file is wiped on every redeploy/restart.
5. Add environment variables (Render dashboard → Environment):
   - `JWT_SECRET` = the random string you generated above
   - `DB_PATH` = `/data/salbet.db`
   - (Render sets `PORT` automatically — don't set it yourself)
6. Deploy. Render gives you a public URL like
   `https://salbet-server.onrender.com`. Note that on the free tier the
   service sleeps after inactivity and takes ~30s to wake back up on the
   next request — fine for a demo, not for production.

Point the SalBet frontend's API base URL at that address (see the frontend
wiring step) and everyone who opens the page shares the same accounts,
balances, friends list, and live player count from then on.

## 3. What's in here

- `src/db.js` — SQLite schema + seed data (site settings, original
  fictional pack characters — no real people).
- `src/auth.js` — password hashing (bcrypt) and JWT session tokens.
- `src/server.js` — all REST routes plus the WebSocket server for live
  presence and real-time notifications (friend requests, gifts, duel
  challenges/results, big-win broadcasts).

## 4. API summary

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
