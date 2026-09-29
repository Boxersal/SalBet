require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const db = require('./db');
const { hashPassword, checkPassword, signToken, authRequired, ownerRequired, JWT_SECRET } = require('./auth');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Wrap async route handlers so thrown errors/rejected promises reach Express's
// error handling instead of crashing the process or hanging the request.
const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------- settings / stats helpers ----------
async function getSetting(k) {
  const row = await db.one('SELECT value FROM site_settings WHERE key = $1', [k]);
  return row?.value;
}
async function setSetting(k, v) {
  await db.run(
    'INSERT INTO site_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    [k, String(v)]
  );
}
async function allSettings() {
  const rows = await db.all('SELECT key, value FROM site_settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
async function addGlobal(k, n) {
  await db.run('UPDATE global_stats SET value = value + $1 WHERE key = $2', [Math.round(n), k]);
}
async function getGlobal(k) {
  const row = await db.one('SELECT value FROM global_stats WHERE key = $1', [k]);
  return row?.value || 0;
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    balance: u.balance,
    safeBalance: u.safe_balance,
    banned: !!u.banned,
    streak: u.streak_count,
    stats: { bets: u.stats_bets, wagered: u.stats_wagered, won: u.stats_won, biggest: u.stats_biggest },
  };
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

// ============ AUTH ============
app.post(
  '/api/auth/signup',
  ah(async (req, res) => {
    const { username, password, asOwner } = req.body || {};
    if (!/^[A-Za-z0-9_]{3,16}$/.test(username || '')) return res.status(400).json({ error: 'Username must be 3-16 letters, numbers or _' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    if ((await getSetting('signups_open')) !== '1' && !asOwner) return res.status(403).json({ error: 'Sign-ups are currently closed' });

    const lower = username.toLowerCase();
    const exists = await db.one('SELECT id FROM users WHERE username_lower = $1', [lower]);
    if (exists) return res.status(409).json({ error: 'That username is taken' });

    let role = 'player';
    if (asOwner) {
      const ownerExists = await db.one("SELECT id FROM users WHERE role = 'owner'");
      if (ownerExists) return res.status(403).json({ error: 'An owner account already exists' });
      role = 'owner';
    }
    const startBalance = parseInt((await getSetting('start_balance')) || '5000', 10);
    const user = await db.one(
      'INSERT INTO users (username, username_lower, password_hash, role, balance) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [username, lower, hashPassword(password), role, startBalance]
    );
    res.json({ token: signToken(user), user: publicUser(user) });
  })
);

app.post(
  '/api/auth/login',
  ah(async (req, res) => {
    const { username, password } = req.body || {};
    const user = await db.one('SELECT * FROM users WHERE username_lower = $1', [(username || '').toLowerCase()]);
    if (!user || !checkPassword(password || '', user.password_hash)) return res.status(401).json({ error: 'Wrong username or password' });
    if (user.banned) return res.status(403).json({ error: 'This account has been suspended' });
    if ((await getSetting('maintenance')) === '1' && user.role !== 'owner') return res.status(503).json({ error: 'SalBet is down for maintenance. Back soon!' });
    await db.run('UPDATE users SET last_seen = now() WHERE id = $1', [user.id]);
    res.json({ token: signToken(user), user: publicUser(user) });
  })
);

app.get(
  '/api/auth/owner-exists',
  ah(async (req, res) => {
    const row = await db.one("SELECT id FROM users WHERE role = 'owner'");
    res.json({ exists: !!row });
  })
);

app.get(
  '/api/me',
  authRequired,
  ah(async (req, res) => {
    const user = await db.one('SELECT * FROM users WHERE id = $1', [req.auth.id]);
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json({ user: publicUser(user), settings: await allSettings() });
  })
);

// ============ WALLET / BETS ============
app.post(
  '/api/bet',
  authRequired,
  ah(async (req, res) => {
    const { amount } = req.body || {};
    const bet = Math.floor(Number(amount));
    const minBet = parseInt(await getSetting('min_bet'), 10),
      maxBet = parseInt(await getSetting('max_bet'), 10);
    if (!(bet > 0)) return res.status(400).json({ error: 'Invalid bet' });
    if (bet < minBet || bet > maxBet) return res.status(400).json({ error: `Bets must be between ${minBet} and ${maxBet}` });
    const user = await db.one('SELECT * FROM users WHERE id = $1', [req.auth.id]);
    if (user.balance < bet) return res.status(400).json({ error: 'Insufficient balance' });
    const updated = await db.one(
      'UPDATE users SET balance = balance - $1, stats_bets = stats_bets + 1, stats_wagered = stats_wagered + $1 WHERE id = $2 RETURNING *',
      [bet, user.id]
    );
    await addGlobal('wagered', bet);
    res.json({ user: publicUser(updated) });
  })
);

app.post(
  '/api/win',
  authRequired,
  ah(async (req, res) => {
    const { payout, mult, game, stake } = req.body || {};
    const amount = Math.floor(Number(payout));
    if (!(amount > 0)) return res.status(400).json({ error: 'Invalid payout' });
    const user = await db.one('SELECT * FROM users WHERE id = $1', [req.auth.id]);
    const profit = amount - Math.floor(Number(stake) || 0);
    const updated = await db.one(
      'UPDATE users SET balance = balance + $1, stats_won = stats_won + $2, stats_biggest = GREATEST(stats_biggest, $2) WHERE id = $3 RETURNING *',
      [amount, Math.max(0, profit), user.id]
    );
    await addGlobal('returned', amount);
    const bigWin = parseInt(await getSetting('big_win'), 10);
    if (profit >= bigWin) {
      await db.run('INSERT INTO bigwins (username, game, amount, mult) VALUES ($1,$2,$3,$4)', [user.username, game || '?', profit, Number(mult) || 1]);
      broadcast({ type: 'bigwin', username: user.username, game, amount: profit, mult });
    }
    res.json({ user: publicUser(updated) });
  })
);

app.get(
  '/api/bigwins',
  ah(async (req, res) => {
    res.json({ bigwins: await db.all('SELECT username, game, amount, mult, created_at FROM bigwins ORDER BY id DESC LIMIT 30') });
  })
);

app.get(
  '/api/stats',
  ah(async (req, res) => {
    res.json({ wagered: await getGlobal('wagered'), returned: await getGlobal('returned'), online: presenceCount() });
  })
);

// ============ DAILY REWARDS (30-day escalating streak) ============
const DAILY_REWARDS = Array.from({ length: 30 }, (_, i) => Math.round(200 * Math.pow(1.15, i)));

app.get(
  '/api/daily/status',
  authRequired,
  ah(async (req, res) => {
    const user = await db.one('SELECT * FROM users WHERE id = $1', [req.auth.id]);
    const today = todayISO();
    const canClaim = user.streak_last_claim !== today;
    const nextDay = !user.streak_last_claim || daysBetween(user.streak_last_claim, today) > 1 ? 1 : Math.min(30, user.streak_count + 1);
    res.json({ canClaim, streak: user.streak_count, nextDay, nextReward: DAILY_REWARDS[nextDay - 1], schedule: DAILY_REWARDS });
  })
);

app.post(
  '/api/daily/claim',
  authRequired,
  ah(async (req, res) => {
    const user = await db.one('SELECT * FROM users WHERE id = $1', [req.auth.id]);
    const today = todayISO();
    if (user.streak_last_claim === today) return res.status(400).json({ error: 'Already claimed today' });
    const brokeStreak = !user.streak_last_claim || daysBetween(user.streak_last_claim, today) > 1;
    const newStreak = brokeStreak ? 1 : Math.min(30, user.streak_count + 1);
    const reward = DAILY_REWARDS[newStreak - 1];
    const updated = await db.one(
      'UPDATE users SET balance = balance + $1, streak_count = $2, streak_last_claim = $3 WHERE id = $4 RETURNING *',
      [reward, newStreak, today, user.id]
    );
    res.json({ reward, streak: newStreak, user: publicUser(updated) });
  })
);

// ============ FAKE "BUY COINS" (no real payment; cosmetic only) ============
const COIN_PACKS = [
  { id: 'starter', label: 'Starter Pack', priceUsd: 1, coins: 500 },
  { id: 'value', label: 'Value Pack', priceUsd: 5, coins: 2750, note: '+10% bonus' },
  { id: 'high_roller', label: 'High Roller Pack', priceUsd: 20, coins: 12000, note: '+20% bonus' },
  { id: 'whale', label: 'Whale Pack', priceUsd: 50, coins: 32500, note: '+30% bonus' },
];
app.get('/api/shop/coin-packs', (req, res) => res.json({ packs: COIN_PACKS, disclaimer: 'Demo only. No real payment is processed. This never charges real money.' }));

app.post(
  '/api/shop/buy-coins',
  authRequired,
  ah(async (req, res) => {
    const pack = COIN_PACKS.find((p) => p.id === req.body?.packId);
    if (!pack) return res.status(400).json({ error: 'Unknown pack' });
    const updated = await db.one('UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING *', [pack.coins, req.auth.id]);
    await addGlobal('coins_sold', pack.coins);
    res.json({ simulated: true, message: `(Demo) Added ${pack.coins.toLocaleString()} coins. No real charge was made.`, user: publicUser(updated) });
  })
);

// ============ CHARACTER SHOP / PACKS ============
app.get(
  '/api/shop/characters',
  ah(async (req, res) => {
    res.json({ characters: await db.all('SELECT * FROM characters ORDER BY value DESC'), packPrice: parseInt(await getSetting('pack_price'), 10) });
  })
);

function weightedPick(rows) {
  const total = rows.reduce((s, r) => s + r.weight, 0);
  let roll = Math.random() * total;
  for (const r of rows) {
    if ((roll -= r.weight) <= 0) return r;
  }
  return rows[rows.length - 1];
}

app.post(
  '/api/shop/open-pack',
  authRequired,
  ah(async (req, res) => {
    const price = parseInt(await getSetting('pack_price'), 10);
    const user = await db.one('SELECT * FROM users WHERE id = $1', [req.auth.id]);
    if (user.balance < price) return res.status(400).json({ error: 'Not enough coins for a pack' });
    const chars = await db.all('SELECT * FROM characters');
    const pulled = Array.from({ length: 6 }, () => weightedPick(chars));

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [price, user.id]);
      for (const c of pulled) {
        await client.query('INSERT INTO inventory (user_id, character_id) VALUES ($1,$2)', [user.id, c.id]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    const updated = await db.one('SELECT * FROM users WHERE id = $1', [user.id]);
    res.json({ pulled, user: publicUser(updated) });
  })
);

app.get(
  '/api/shop/inventory',
  authRequired,
  ah(async (req, res) => {
    const rows = await db.all(
      `SELECT inventory.id AS inv_id, inventory.obtained_at, characters.* FROM inventory
       JOIN characters ON characters.id = inventory.character_id
       WHERE inventory.user_id = $1 ORDER BY inventory.id DESC`,
      [req.auth.id]
    );
    res.json({ inventory: rows });
  })
);

app.post(
  '/api/shop/sell',
  authRequired,
  ah(async (req, res) => {
    const invId = req.body?.invId;
    const row = await db.one(
      `SELECT inventory.id AS inv_id, characters.value FROM inventory JOIN characters ON characters.id = inventory.character_id WHERE inventory.id = $1 AND inventory.user_id = $2`,
      [invId, req.auth.id]
    );
    if (!row) return res.status(404).json({ error: 'Card not found' });
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM inventory WHERE id = $1', [invId]);
      await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [row.value, req.auth.id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    const updated = await db.one('SELECT * FROM users WHERE id = $1', [req.auth.id]);
    res.json({ soldFor: row.value, user: publicUser(updated) });
  })
);

// ============ FRIENDS ============
app.get(
  '/api/friends',
  authRequired,
  ah(async (req, res) => {
    const rows = await db.all(
      `SELECT friends.id AS friend_row_id, friends.status, friends.user_a, friends.user_b, users.id AS uid, users.username, users.role
       FROM friends JOIN users ON users.id = CASE WHEN friends.user_a = $1 THEN friends.user_b ELSE friends.user_a END
       WHERE friends.user_a = $1 OR friends.user_b = $1`,
      [req.auth.id]
    );
    const online = presenceSet();
    const friends = rows.filter((r) => r.status === 'accepted').map((r) => ({ id: r.uid, username: r.username, online: online.has(r.uid) }));
    const incoming = rows.filter((r) => r.status === 'pending' && r.user_b === req.auth.id).map((r) => ({ id: r.uid, username: r.username, rowId: r.friend_row_id }));
    const outgoing = rows.filter((r) => r.status === 'pending' && r.user_a === req.auth.id).map((r) => ({ id: r.uid, username: r.username, rowId: r.friend_row_id }));
    res.json({ friends, incoming, outgoing });
  })
);

app.post(
  '/api/friends/request',
  authRequired,
  ah(async (req, res) => {
    const target = await db.one('SELECT * FROM users WHERE username_lower = $1', [(req.body?.username || '').toLowerCase()]);
    if (!target) return res.status(404).json({ error: 'Player not found' });
    if (target.id === req.auth.id) return res.status(400).json({ error: "You can't friend yourself" });
    const existing = await db.one(
      'SELECT * FROM friends WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)',
      [req.auth.id, target.id]
    );
    if (existing) return res.status(409).json({ error: existing.status === 'accepted' ? 'Already friends' : 'Request already pending' });
    await db.run('INSERT INTO friends (user_a, user_b, status) VALUES ($1,$2,$3)', [req.auth.id, target.id, 'pending']);
    res.json({ ok: true });
  })
);

app.post(
  '/api/friends/accept',
  authRequired,
  ah(async (req, res) => {
    const row = await db.one('SELECT * FROM friends WHERE id = $1 AND user_b = $2', [req.body?.rowId, req.auth.id]);
    if (!row) return res.status(404).json({ error: 'Request not found' });
    await db.run("UPDATE friends SET status = 'accepted' WHERE id = $1", [row.id]);
    res.json({ ok: true });
  })
);

app.post(
  '/api/friends/decline',
  authRequired,
  ah(async (req, res) => {
    await db.run('DELETE FROM friends WHERE id = $1 AND (user_a = $2 OR user_b = $2)', [req.body?.rowId, req.auth.id]);
    res.json({ ok: true });
  })
);

// ============ GIFTING ============
app.post(
  '/api/gift',
  authRequired,
  ah(async (req, res) => {
    const { toUsername, amount } = req.body || {};
    const amt = Math.floor(Number(amount));
    if (!(amt > 0)) return res.status(400).json({ error: 'Invalid amount' });
    const target = await db.one('SELECT * FROM users WHERE username_lower = $1', [(toUsername || '').toLowerCase()]);
    if (!target) return res.status(404).json({ error: 'Player not found' });
    if (target.id === req.auth.id) return res.status(400).json({ error: "You can't gift yourself" });
    const areFriends = await db.one(
      "SELECT * FROM friends WHERE status='accepted' AND ((user_a=$1 AND user_b=$2) OR (user_a=$2 AND user_b=$1))",
      [req.auth.id, target.id]
    );
    if (!areFriends) return res.status(403).json({ error: 'You can only gift friends' });
    const sender = await db.one('SELECT * FROM users WHERE id = $1', [req.auth.id]);
    if (sender.balance < amt) return res.status(400).json({ error: 'Insufficient balance' });

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amt, sender.id]);
      await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amt, target.id]);
      await client.query('INSERT INTO gifts (from_user, to_user, amount) VALUES ($1,$2,$3)', [sender.id, target.id, amt]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    notifyUser(target.id, { type: 'gift', from: sender.username, amount: amt });
    const updated = await db.one('SELECT * FROM users WHERE id = $1', [sender.id]);
    res.json({ user: publicUser(updated) });
  })
);

// ============ MULTIPLAYER: who's online + head-to-head duels ============
app.get(
  '/api/online',
  authRequired,
  ah(async (req, res) => {
    const ids = [...presenceSet()].filter((id) => id !== req.auth.id);
    if (!ids.length) return res.json({ players: [] });
    const rows = await db.all('SELECT id, username FROM users WHERE id = ANY($1::int[])', [ids]);
    res.json({ players: rows });
  })
);

app.post(
  '/api/duel/challenge',
  authRequired,
  ah(async (req, res) => {
    const { toUserId, game, stake } = req.body || {};
    const amt = Math.floor(Number(stake));
    if (!(amt > 0)) return res.status(400).json({ error: 'Invalid stake' });
    if (!['coinflip', 'dice'].includes(game)) return res.status(400).json({ error: 'Unsupported game' });
    const challenger = await db.one('SELECT * FROM users WHERE id = $1', [req.auth.id]);
    if (challenger.balance < amt) return res.status(400).json({ error: 'Insufficient balance' });
    const duel = await db.one('INSERT INTO duels (game, player_a, stake, status) VALUES ($1,$2,$3,$4) RETURNING id', [game, req.auth.id, amt, 'open']);
    notifyUser(toUserId, { type: 'duel_challenge', duelId: duel.id, from: challenger.username, game, stake: amt });
    res.json({ duelId: duel.id });
  })
);

app.post(
  '/api/duel/accept',
  authRequired,
  ah(async (req, res) => {
    const duel = await db.one("SELECT * FROM duels WHERE id = $1 AND status = 'open'", [req.body?.duelId]);
    if (!duel) return res.status(404).json({ error: 'Duel not available' });
    const a = await db.one('SELECT * FROM users WHERE id = $1', [duel.player_a]);
    const b = await db.one('SELECT * FROM users WHERE id = $1', [req.auth.id]);
    if (a.balance < duel.stake || b.balance < duel.stake) return res.status(400).json({ error: 'One player has insufficient balance' });

    // Provably-fair-ish coinflip: each side equally likely; the server is the sole authority.
    const winnerId = Math.random() < 0.5 ? a.id : b.id;
    const loserId = winnerId === a.id ? b.id : a.id;

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE duels SET player_b = $1, status = 'resolved', winner = $2, resolved_at = now() WHERE id = $3", [b.id, winnerId, duel.id]);
      await client.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [duel.stake, loserId]);
      await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [duel.stake, winnerId]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    const winner = await db.one('SELECT username FROM users WHERE id = $1', [winnerId]);
    const result = { type: 'duel_result', duelId: duel.id, winnerUsername: winner.username, stake: duel.stake, game: duel.game };
    notifyUser(a.id, result);
    notifyUser(b.id, result);
    res.json(result);
  })
);

app.post(
  '/api/duel/decline',
  authRequired,
  ah(async (req, res) => {
    await db.run("UPDATE duels SET status = 'cancelled' WHERE id = $1 AND status = 'open'", [req.body?.duelId]);
    res.json({ ok: true });
  })
);

// ============ OWNER PANEL ============
app.get(
  '/api/owner/users',
  authRequired,
  ownerRequired,
  ah(async (req, res) => {
    const rows = await db.all('SELECT * FROM users ORDER BY id');
    res.json({ users: rows.map(publicUser) });
  })
);
app.post(
  '/api/owner/adjust',
  authRequired,
  ownerRequired,
  ah(async (req, res) => {
    const { userId, mode, amount } = req.body || {};
    const amt = Math.max(0, Math.floor(Number(amount) || 0));
    const target = await db.one('SELECT * FROM users WHERE id = $1', [userId]);
    if (!target) return res.status(404).json({ error: 'Not found' });
    const nv = mode === 'add' ? target.balance + amt : mode === 'sub' ? Math.max(0, target.balance - amt) : amt;
    const updated = await db.one('UPDATE users SET balance = $1 WHERE id = $2 RETURNING *', [nv, target.id]);
    res.json({ user: publicUser(updated) });
  })
);
app.post(
  '/api/owner/give-all',
  authRequired,
  ownerRequired,
  ah(async (req, res) => {
    const amt = Math.max(0, Math.floor(Number(req.body?.amount) || 0));
    await db.run('UPDATE users SET balance = balance + $1', [amt]);
    res.json({ ok: true });
  })
);
app.post(
  '/api/owner/ban',
  authRequired,
  ownerRequired,
  ah(async (req, res) => {
    const target = await db.one('SELECT * FROM users WHERE id = $1', [req.body?.userId]);
    if (!target || target.role === 'owner') return res.status(400).json({ error: 'Cannot ban this account' });
    await db.run('UPDATE users SET banned = $1 WHERE id = $2', [!target.banned, target.id]);
    res.json({ ok: true });
  })
);
app.post(
  '/api/owner/delete',
  authRequired,
  ownerRequired,
  ah(async (req, res) => {
    const target = await db.one('SELECT * FROM users WHERE id = $1', [req.body?.userId]);
    if (!target || target.role === 'owner') return res.status(400).json({ error: 'Cannot delete this account' });
    await db.run('DELETE FROM users WHERE id = $1', [target.id]);
    res.json({ ok: true });
  })
);
app.get(
  '/api/owner/settings',
  authRequired,
  ownerRequired,
  ah(async (req, res) => res.json({ settings: await allSettings() }))
);
app.post(
  '/api/owner/settings',
  authRequired,
  ownerRequired,
  ah(async (req, res) => {
    const allowed = ['site_name', 'banner', 'start_balance', 'min_bet', 'max_bet', 'big_win', 'signups_open', 'maintenance', 'pack_price'];
    for (const k of allowed) if (k in (req.body || {})) await setSetting(k, req.body[k]);
    const settings = await allSettings();
    broadcast({ type: 'settings_updated', settings });
    res.json({ settings });
  })
);
app.post(
  '/api/owner/reset-totals',
  authRequired,
  ownerRequired,
  ah(async (req, res) => {
    await db.run('UPDATE global_stats SET value = 0');
    res.json({ ok: true });
  })
);
app.post(
  '/api/owner/clear-bigwins',
  authRequired,
  ownerRequired,
  ah(async (req, res) => {
    await db.run('DELETE FROM bigwins');
    res.json({ ok: true });
  })
);

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Basic error handler so a failed query returns JSON instead of hanging/crashing.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

// ============ WEBSOCKET: live presence + realtime notifications ============
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
const clientsByUser = new Map(); // userId -> Set<ws>

function presenceSet() {
  return new Set(clientsByUser.keys());
}
function presenceCount() {
  return clientsByUser.size;
}
function notifyUser(userId, payload) {
  const set = clientsByUser.get(Number(userId));
  if (!set) return;
  const msg = JSON.stringify(payload);
  set.forEach((ws) => ws.readyState === WebSocket.OPEN && ws.send(msg));
}
function broadcast(payload) {
  const msg = JSON.stringify(payload);
  wss.clients.forEach((ws) => ws.readyState === WebSocket.OPEN && ws.send(msg));
}

wss.on('connection', (ws, req) => {
  let userId = null;
  try {
    const url = new URL(req.url, 'http://x');
    const token = url.searchParams.get('token');
    const payload = jwt.verify(token, JWT_SECRET);
    userId = payload.id;
  } catch (e) {
    ws.close(4001, 'Unauthorized');
    return;
  }
  if (!clientsByUser.has(userId)) clientsByUser.set(userId, new Set());
  clientsByUser.get(userId).add(ws);
  db.run('UPDATE users SET last_seen = now() WHERE id = $1', [userId]).catch(() => {});
  broadcast({ type: 'presence', online: presenceCount() });

  ws.on('close', () => {
    const set = clientsByUser.get(userId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) clientsByUser.delete(userId);
    }
    broadcast({ type: 'presence', online: presenceCount() });
  });
});

db.init()
  .then(() => {
    server.listen(PORT, () => console.log(`SalBet server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
