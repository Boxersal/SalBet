const Database = require('better-sqlite3');
const path = require('path');

// Persistent file on disk. On Render, point this at a mounted disk (e.g. /data/salbet.db)
// via the DB_PATH env var so it survives restarts and redeploys.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'salbet.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  username_lower TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player',      -- 'player' | 'owner'
  balance INTEGER NOT NULL DEFAULT 5000,     -- in-game currency, integer cents-equivalent (whole coins)
  safe_balance INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  streak_count INTEGER NOT NULL DEFAULT 0,
  streak_last_claim TEXT,                    -- ISO date (YYYY-MM-DD) of last claim
  stats_bets INTEGER NOT NULL DEFAULT 0,
  stats_wagered INTEGER NOT NULL DEFAULT 0,
  stats_won INTEGER NOT NULL DEFAULT 0,
  stats_biggest INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS friends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a INTEGER NOT NULL,                   -- requester
  user_b INTEGER NOT NULL,                   -- recipient
  status TEXT NOT NULL DEFAULT 'pending',    -- 'pending' | 'accepted'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_a, user_b),
  FOREIGN KEY(user_a) REFERENCES users(id),
  FOREIGN KEY(user_b) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS gifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user INTEGER NOT NULL,
  to_user INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(from_user) REFERENCES users(id),
  FOREIGN KEY(to_user) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS duels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game TEXT NOT NULL,                        -- 'coinflip' | 'dice'
  player_a INTEGER NOT NULL,
  player_b INTEGER,
  stake INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',       -- 'open' | 'accepted' | 'resolved' | 'cancelled'
  winner INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  archetype TEXT NOT NULL,
  rarity TEXT NOT NULL,                      -- 'Common'|'Uncommon'|'Rare'|'Epic'|'Legendary'
  value INTEGER NOT NULL,                    -- sell-back value in coins
  weight REAL NOT NULL,                      -- pack odds weight
  emoji TEXT NOT NULL DEFAULT '\u2b50'
);

CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  character_id INTEGER NOT NULL,
  obtained_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES users(id),
  FOREIGN KEY(character_id) REFERENCES characters(id)
);

CREATE TABLE IF NOT EXISTS bigwins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  game TEXT NOT NULL,
  amount INTEGER NOT NULL,
  mult REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS global_stats (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
`);

// Seed default site settings once
const defaults = {
  site_name: 'SalBet',
  banner: '',
  start_balance: '5000',
  min_bet: '1',
  max_bet: '100000',
  big_win: '1000',
  signups_open: '1',
  maintenance: '0',
  pack_price: '10000',
};
const insertSetting = db.prepare('INSERT OR IGNORE INTO site_settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaults)) insertSetting.run(k, v);

const insertGlobal = db.prepare('INSERT OR IGNORE INTO global_stats (key, value) VALUES (?, 0)');
insertGlobal.run('wagered');
insertGlobal.run('returned');
insertGlobal.run('coins_sold'); // fake-currency "purchases", for display only, never real money

// Seed original characters (NOT real people) if table is empty
const charCount = db.prepare('SELECT COUNT(*) AS c FROM characters').get().c;
if (charCount === 0) {
  const seed = db.prepare(
    'INSERT INTO characters (name, archetype, rarity, value, weight, emoji) VALUES (@name, @archetype, @rarity, @value, @weight, @emoji)'
  );
  const roster = [
    // Common
    { name: 'Chatly Rae', archetype: 'IRL Streamer', rarity: 'Common', value: 500, weight: 40, emoji: '\ud83d\udcf9' },
    { name: 'Beat Boomer', archetype: 'Meme Musician', rarity: 'Common', value: 500, weight: 40, emoji: '\ud83c\udfa7' },
    { name: 'Sk8 Milo', archetype: 'Trick-Shot Creator', rarity: 'Common', value: 500, weight: 40, emoji: '\ud83d\udef9' },
    { name: 'Pixel Pia', archetype: 'Speedrunner', rarity: 'Common', value: 500, weight: 40, emoji: '\ud83c\udfae' },
    // Uncommon
    { name: 'DJ Nova Flux', archetype: 'Viral DJ', rarity: 'Uncommon', value: 1500, weight: 22, emoji: '\ud83c\udfa4' },
    { name: 'Glowbrook Zane', archetype: 'Dance-Trend Creator', rarity: 'Uncommon', value: 1500, weight: 22, emoji: '\ud83d\udd7a' },
    { name: 'CaptainClutch99', archetype: 'FPS Pro Gamer', rarity: 'Uncommon', value: 1500, weight: 22, emoji: '\ud83c\udfaf' },
    { name: 'Roast Marnie', archetype: 'Comedy Sketch Star', rarity: 'Uncommon', value: 1500, weight: 22, emoji: '\ud83c\udfad' },
    // Rare
    { name: 'Velvet Prankster King', archetype: 'Prank Vlogger', rarity: 'Rare', value: 4000, weight: 12, emoji: '\ud83c\udfa5' },
    { name: 'Aria Duskwave', archetype: 'Pop Sensation', rarity: 'Rare', value: 4000, weight: 12, emoji: '\u2b50' },
    { name: 'Turbo Threadz', archetype: 'Fashion Hauler', rarity: 'Rare', value: 4000, weight: 12, emoji: '\ud83d\udc5f' },
    // Epic
    { name: 'The Midnight Caster', archetype: 'Esports Caster Legend', rarity: 'Epic', value: 10000, weight: 5, emoji: '\ud83c\udfc6' },
    { name: 'Solstice Vane', archetype: 'Mega-Influencer', rarity: 'Epic', value: 10000, weight: 5, emoji: '\ud83d\udc8e' },
    // Legendary
    { name: 'GOATed Emberlyn', archetype: 'Global Icon', rarity: 'Legendary', value: 30000, weight: 1, emoji: '\ud83d\udc51' },
  ];
  const tx = db.transaction((rows) => rows.forEach((r) => seed.run(r)));
  tx(roster);
}

module.exports = db;
