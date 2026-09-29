require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const db = require('./db');
const { hashPassword, checkPassword, signToken, authRequired, ownerRequired } = require('./auth');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ---------- helpers ----------
const getSetting = (k) => db.prepare('SELECT value FROM site_settings WHERE key = ?').get(k)?.value;
const setSetting = (k, v) => db.prepare('INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
const allSettings = () => Object.fromEntries(db.prepare('SELECT key, value FROM site_settings').all().map((r) => [r.key, r.value]));
const addGlobal = (k, n) => db.prepare('UPDATE global_stats SET value = value + ? WHERE key = ?').run(Math.round(n), k);
const getGlobal = (k) => db.prepare('SELECT value FROM global_stats WHERE key = ?').get(k)?.value || 0;

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
app.post('/api/auth/signup', (req, res) => {
  const { username, password, asOwner } = req.body || {};
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username || '')) return res.status(400).json({ error: 'Username must be 3-16 letters, numbers or _' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (getSetting('signups_open') !== '1' && !asOwner) return res.status(403).json({ error: 'Sign-ups are currently closed' });

  const lower = username.toLowerCase();
  const exists = db.prepare('SELECT id FROM users WHERE username_lower = ?').get(lower);
  if (exists) return res.status(409).json({ error: 'That username is taken' });

  let role = 'player';
  if (asOwner) {
    const ownerExists = db.prepare("SELECT id FROM users WHERE role = 'owner'").get();
    if (ownerExists) return res.status(403).json({ error: 'An owner account already exists' });
    role = 'owner';
  }
  const startBalance = parseInt(getSetting('start_balance') || '5000', 10);
  const info = db
    .prepare('INSERT INTO users (username, username_lower, password_hash, role, balance) VALUES (?, ?, ?, ?, ?)')
    .run(username, lower, hashPassword(password), role, startBalance);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username_lower = ?').get((username || '').toLowerCase());
  if (!user || !checkPassword(password || '', user.password_hash)) return res.status(401).json({ error: 'Wrong username or password' });
  if (user.banned) return res.status(403).json({ error: 'This account has been suspended' });
  if (getSetting('maintenance') === '1' && user.role !== 'owner') return res.status(503).json({ error: 'SalBet is down for maintenance. Back soon!' });
  db.prepare("UPDATE users SET last_seen = datetime('now') WHERE id = ?").run(user.id);
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get('/api/auth/owner-exists', (req, res) => {
  const row = db.prepare("SELECT id FROM users WHERE role = 'owner'").get();
  res.json({ exists: !!row });
});

app.get('/api/me', authRequired, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ user: publicUser(user), settings: allSettings() });
});

// ============ WALLET / BETS (called by game logic after each round) ============
app.post('/api/bet', authRequired, (req, res) => {
  const { amount } = req.body || {};
  const bet = Math.floor(Number(amount));
  const minBet = parseInt(getSetting('min_bet'), 10), maxBet = parseInt(getSetting('max_bet'), 10);
  if (!(bet > 0)) return res.status(400).json({ error: 'Invalid bet' });
  if (bet < minBet || bet > maxBet) return res.status(400).json({ error: `Bets must be between ${minBet} and ${maxBet}` });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.id);
  if (user.balance < bet) return res.status(400).json({ error: 'Insufficient balance' });
  db.prepare('UPDATE users SET balance = balance - ?, stats_bets = stats_bets + 1, stats_wagered = stats_wagered + ? WHERE id = ?').run(bet, bet, user.id);
  addGlobal('wagered', bet);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ user: publicUser(updated) });
});

app.post('/api/win', authRequired, (req, res) => {
  const { payout, mult, game, stake } = req.body || {};
  const amount = Math.floor(Number(payout));
  if (!(amount > 0)) return res.status(400).json({ error: 'Invalid payout' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.id);
  const profit = amount - Math.floor(Number(stake) || 0);
  db.prepare('UPDATE users SET balance = balance + ?, stats_won = stats_won + ?, stats_biggest = MAX(stats_biggest, ?) WHERE id = ?').run(amount, Math.max(0, profit), Math.max(0, profit), user.id);
  addGlobal('returned', amount);
  const bigWin = parseInt(getSetting('big_win'), 10);
  if (profit >= bigWin) {
    db.prepare('INSERT INTO bigwins (username, game, amount, mult) VALUES (?, ?, ?, ?)').run(user.username, game || '?', profit, Number(mult) || 1);
    broadcast({ type: 'bigwin', username: user.username, game, amount: profit, mult });
  }
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ user: publicUser(updated) });
});

app.get('/api/bigwins', (req, res) => {
  res.json({ bigwins: db.prepare('SELECT username, game, amount, mult, created_at FROM bigwins ORDER BY id DESC LIMIT 30').all() });
});

app.get('/api/stats', (req, res) => {
  res.json({ wagered: getGlobal('wagered'), returned: getGlobal('returned'), online: presenceCount() });
});

// ============ DAILY REWARDS (30-day escalating streak) ============
const DAILY_REWARDS = Array.from({ length: 30 }, (_, i) => Math.round(200 * Math.pow(1.15, i))); // day1..day30

app.get('/api/daily/status', authRequired, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.id);
  const today = todayISO();
  const canClaim = user.streak_last_claim !== today;
  const nextDay = !user.streak_last_claim || daysBetween(user.streak_last_claim, today) > 1 ? 1 : Math.min(30, user.streak_count + 1);
  res.json({ canClaim, streak: user.streak_count, nextDay, nextReward: DAILY_REWARDS[nextDay - 1], schedule: DAILY_REWARDS });
});

app.post('/api/daily/claim', authRequired, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.id);
  const today = todayISO();
  if (user.streak_last_claim === today) return res.status(400).json({ error: 'Already claimed today' });
  const brokeStreak = !user.streak_last_claim || daysBetween(user.streak_last_claim, today) > 1;
  const newStreak = brokeStreak ? 1 : Math.min(30, user.streak_count + 1);
  const reward = DAILY_REWARDS[newStreak - 1];
  db.prepare('UPDATE users SET balance = balance + ?, streak_count = ?, streak_last_claim = ? WHERE id = ?').run(reward, newStreak, today, user.id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ reward, streak: newStreak, user: publicUser(updated) });
});

// ============ FAKE "BUY COINS" (no real payment; cosmetic only) ============
const COIN_PACKS = [
  { id: 'starter', label: 'Starter Pack', priceUsd: 1, coins: 500 },
  { id: 'value', label: 'Value Pack', priceUsd: 5, coins: 2750, note: '+10% bonus' },
  { id: 'high_roller', label: 'High Roller Pack', priceUsd: 20, coins: 12000, note: '+20% bonus' },
  { id: 'whale', label: 'Whale Pack', priceUsd: 50, coins: 32500, note: '+30% bonus' },
];
app.get('/api/shop/coin-packs', (req, res) => res.json({ packs: COIN_PACKS, disclaimer: 'Demo only. No real payment is processed. This never charges real money.' }));

app.post('/api/shop/buy-coins', authRequired, (req, res) => {
  const pack = COIN_PACKS.find((p) => p.id === req.body?.packId);
  if (!pack) return res.status(400).json({ error: 'Unknown pack' });
  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(pack.coins, req.auth.id);
  addGlobal('coins_sold', pack.coins);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.id);
  res.json({ simulated: true, message: `(Demo) Added ${pack.coins.toLocaleString()} coins. No real charge was made.`, user: publicUser(updated) });
});

// ============ CHARACTER SHOP / PACKS ============
app.get('/api/shop/characters', (req, res) => {
  res.json({ characters: db.prepare('SELECT * FROM characters ORDER BY value DESC').all(), packPrice: parseInt(getSetting('pack_price'), 10) });
});

function weightedPick(rows) {
  const total = rows.reduce((s, r) => s + r.weight, 0);
  let roll = Math.random() * total;
  for (const r of rows) {
    if ((roll -= r.weight) <= 0) return r;
  }
  return rows[rows.length - 1];
}

app.post('/api/shop/open-pack', authRequired, (req, res) => {
  const price = parseInt(getSetting('pack_price'), 10);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.id);
  if (user.balance < price) return res.status(400).json({ error: 'Not enough coins for a pack' });
  const chars = db.prepare('SELECT * FROM characters').all();
  const pulled = Array.from({ length: 6 }, () => weightedPick(chars));
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(price, user.id);
    const insertInv = db.prepare('INSERT INTO inventory (user_id, character_id) VALUES (?, ?)');
    pulled.forEach((c) => insertInv.run(user.id, c.id));
  });
  tx();
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  res.json({ pulled, user: publicUser(updated) });
});

app.get('/api/shop/inventory', authRequired, (req, res) => {
  const rows = db
    .prepare(
      `SELECT inventory.id AS inv_id, inventory.obtained_at, characters.* FROM inventory
       JOIN characters ON characters.id = inventory.character_id
       WHERE inventory.user_id = ? ORDER BY inventory.id DESC`
    )
    .all(req.auth.id);
  res.json({ inventory: rows });
});

app.post('/api/shop/sell', authRequired, (req, res) => {
  const invId = req.body?.invId;
  const row = db
    .prepare(`SELECT inventory.id AS inv_id, characters.value FROM inventory JOIN characters ON characters.id = inventory.character_id WHERE inventory.id = ? AND inventory.user_id = ?`)
    .get(invId, req.auth.id);
  if (!row) return res.status(404).json({ error: 'Card not found' });
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM inventory WHERE id = ?').run(invId);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(row.value, req.auth.id);
  });
  tx();
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.id);
  res.json({ soldFor: row.value, user: publicUser(updated) });
});

// ============ FRIENDS ============
app.get('/api/friends', authRequired, (req, res) => {
  const rows = db
    .prepare(
      `SELECT friends.id AS friend_row_id, friends.status, friends.user_a, friends.user_b, users.id AS uid, users.username, users.role
       FROM friends JOIN users ON users.id = CASE WHEN friends.user_a = ? THEN friends.user_b ELSE friends.user_a END
       WHERE friends.user_a = ? OR friends.user_b = ?`
    )
    .all(req.auth.id, req.auth.id, req.auth.id);
  const online = presenceSet();
  const friends = rows
    .filter((r) => r.status === 'accepted')
    .map((r) => ({ id: r.uid, username: r.username, online: online.has(r.uid) }));
  const incoming = rows.filter((r) => r.status === 'pending' && r.user_b === req.auth.id).map((r) => ({ id: r.uid, username: r.username, rowId: r.friend_row_id }));
  const outgoing = rows.filter((r) => r.status === 'pending' && r.user_a === req.auth.id).map((r) => ({ id: r.uid, username: r.username, rowId: r.friend_row_id }));
  res.json({ friends, incoming, outgoing });
});

app.post('/api/friends/request', authRequired, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE username_lower = ?').get((req.body?.username || '').toLowerCase());
  if (!target) return res.status(404).json({ error: 'Player not found' });
  if (target.id === req.auth.id) return res.status(400).json({ error: "You can't friend yourself" });
  const existing = db
    .prepare('SELECT * FROM friends WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)')
    .get(req.auth.id, target.id, target.id, req.auth.id);
  if (existing) return res.status(409).json({ error: existing.status === 'accepted' ? 'Already friends' : 'Request already pending' });
  db.prepare('INSERT INTO friends (user_a, user_b, status) VALUES (?, ?, ?)').run(req.auth.id, target.id, 'pending');
  res.json({ ok: true });
});

app.post('/api/friends/accept', authRequired, (req, res) => {
  const row = db.prepare('SELECT * FROM friends WHERE id = ? AND user_b = ?').get(req.body?.rowId, req.auth.id);
  if (!row) return res.status(404).json({ error: 'Request not found' });
  db.prepare("UPDATE friends SET status = 'accepted' WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

app.post('/api/friends/decline', authRequired, (req, res) => {
  db.prepare('DELETE FROM friends WHERE id = ? AND (user_a = ? OR user_b = ?)').run(req.body?.rowId, req.auth.id, req.auth.id);
  res.json({ ok: true });
});

// ============ GIFTING ============
app.post('/api/gift', authRequired, (req, res) => {
  const { toUsername, amount } = req.body || {};
  const amt = Math.floor(Number(amount));
  if (!(amt > 0)) return res.status(400).json({ error: 'Invalid amount' });
  const target = db.prepare('SELECT * FROM users WHERE username_lower = ?').get((toUsername || '').toLowerCase());
  if (!target) return res.status(404).json({ error: 'Player not found' });
  if (target.id === req.auth.id) return res.status(400).json({ error: "You can't gift yourself" });
  const areFriends = db
    .prepare("SELECT * FROM friends WHERE status='accepted' AND ((user_a=? AND user_b=?) OR (user_a=? AND user_b=?))")
    .get(req.auth.id, target.id, target.id, req.auth.id);
  if (!areFriends) return res.status(403).json({ error: 'You can only gift friends' });
  const sender = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.id);
  if (sender.balance < amt) return res.status(400).json({ error: 'Insufficient balance' });
  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(amt, sender.id);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(amt, target.id);
    db.prepare('INSERT INTO gifts (from_user, to_user, amount) VALUES (?, ?, ?)').run(sender.id, target.id, amt);
  });
  tx();
  notifyUser(target.id, { type: 'gift', from: sender.username, amount: amt });
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(sender.id);
  res.json({ user: publicUser(updated) });
});

// ============ MULTIPLAYER: who's online + head-to-head duels ============
app.get('/api/online', authRequired, (req, res) => {
  const ids = [...presenceSet()].filter((id) => id !== req.auth.id);
  if (!ids.length) return res.json({ players: [] });
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, username FROM users WHERE id IN (${placeholders})`).all(...ids);
  res.json({ players: rows });
});

// Open a duel challenge (visible to the target player via websocket)
app.post('/api/duel/challenge', authRequired, (req, res) => {
  const { toUserId, game, stake } = req.body || {};
  const amt = Math.floor(Number(stake));
  if (!(amt > 0)) return res.status(400).json({ error: 'Invalid stake' });
  if (!['coinflip', 'dice'].includes(game)) return res.status(400).json({ error: 'Unsupported game' });
  const challenger = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.id);
  if (challenger.balance < amt) return res.status(400).json({ error: 'Insufficient balance' });
  const info = db.prepare('INSERT INTO duels (game, player_a, stake, status) VALUES (?, ?, ?, ?)').run(game, req.auth.id, amt, 'open');
  notifyUser(toUserId, { type: 'duel_challenge', duelId: info.lastInsertRowid, from: challenger.username, game, stake: amt });
  res.json({ duelId: info.lastInsertRowid });
});

app.post('/api/duel/accept', authRequired, (req, res) => {
  const duel = db.prepare("SELECT * FROM duels WHERE id = ? AND status = 'open'").get(req.body?.duelId);
  if (!duel) return res.status(404).json({ error: 'Duel not available' });
  const a = db.prepare('SELECT * FROM users WHERE id = ?').get(duel.player_a);
  const b = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.id);
  if (a.balance < duel.stake || b.balance < duel.stake) return res.status(400).json({ error: 'One player has insufficient balance' });

  // Provably-fair-ish coinflip: each side is equally likely; server is the sole authority.
  const winnerId = Math.random() < 0.5 ? a.id : b.id;
  const loserId = winnerId === a.id ? b.id : a.id;
  const tx = db.transaction(() => {
    db.prepare('UPDATE duels SET player_b = ?, status = ?, winner = ?, resolved_at = datetime(\'now\') WHERE id = ?').run(b.id, 'resolved', winnerId, duel.id);
    db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(duel.stake, loserId);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(duel.stake, winnerId);
  });
  tx();
  const winner = db.prepare('SELECT username FROM users WHERE id = ?').get(winnerId);
  const result = { type: 'duel_result', duelId: duel.id, winnerUsername: winner.username, stake: duel.stake, game: duel.game };
  notifyUser(a.id, result);
  notifyUser(b.id, result);
  res.json(result);
});

app.post('/api/duel/decline', authRequired, (req, res) => {
  db.prepare("UPDATE duels SET status = 'cancelled' WHERE id = ? AND status = 'open'").run(req.body?.duelId);
  res.json({ ok: true });
});

// ============ OWNER PANEL ============
app.get('/api/owner/users', authRequired, ownerRequired, (req, res) => {
  res.json({ users: db.prepare('SELECT * FROM users ORDER BY id').all().map(publicUser) });
});
app.post('/api/owner/adjust', authRequired, ownerRequired, (req, res) => {
  const { userId, mode, amount } = req.body || {};
  const amt = Math.max(0, Math.floor(Number(amount) || 0));
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!target) return res.status(404).json({ error: 'Not found' });
  const nv = mode === 'add' ? target.balance + amt : mode === 'sub' ? Math.max(0, target.balance - amt) : amt;
  db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(nv, target.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)) });
});
app.post('/api/owner/give-all', authRequired, ownerRequired, (req, res) => {
  const amt = Math.max(0, Math.floor(Number(req.body?.amount) || 0));
  db.prepare('UPDATE users SET balance = balance + ?').run(amt);
  res.json({ ok: true });
});
app.post('/api/owner/ban', authRequired, ownerRequired, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.body?.userId);
  if (!target || target.role === 'owner') return res.status(400).json({ error: 'Cannot ban this account' });
  db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(target.banned ? 0 : 1, target.id);
  res.json({ ok: true });
});
app.post('/api/owner/delete', authRequired, ownerRequired, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.body?.userId);
  if (!target || target.role === 'owner') return res.status(400).json({ error: 'Cannot delete this account' });
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  res.json({ ok: true });
});
app.get('/api/owner/settings', authRequired, ownerRequired, (req, res) => res.json({ settings: allSettings() }));
app.post('/api/owner/settings', authRequired, ownerRequired, (req, res) => {
  const allowed = ['site_name', 'banner', 'start_balance', 'min_bet', 'max_bet', 'big_win', 'signups_open', 'maintenance', 'pack_price'];
  for (const k of allowed) if (k in (req.body || {})) setSetting(k, req.body[k]);
  broadcast({ type: 'settings_updated', settings: allSettings() });
  res.json({ settings: allSettings() });
});
app.post('/api/owner/reset-totals', authRequired, ownerRequired, (req, res) => {
  db.prepare("UPDATE global_stats SET value = 0").run();
  res.json({ ok: true });
});
app.post('/api/owner/clear-bigwins', authRequired, ownerRequired, (req, res) => {
  db.prepare('DELETE FROM bigwins').run();
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

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

const { JWT_SECRET } = require('./auth');
const jwt = require('jsonwebtoken');

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
  db.prepare("UPDATE users SET last_seen = datetime('now') WHERE id = ?").run(userId);
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

server.listen(PORT, () => console.log(`SalBet server running on port ${PORT}`));
