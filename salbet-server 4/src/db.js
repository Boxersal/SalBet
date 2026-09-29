const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Add it to your .env file (see .env.example).');
}

// Supabase (and most hosted Postgres) require SSL. Local Postgres usually doesn't.
const useSSL = !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

// Small helpers so route code reads like the old synchronous SQLite version.
async function all(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows;
}
async function one(text, params = []) {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
}
async function run(text, params = []) {
  return pool.query(text, params);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  username_lower TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player',
  balance INTEGER NOT NULL DEFAULT 5000,
  safe_balance INTEGER NOT NULL DEFAULT 0,
  banned BOOLEAN NOT NULL DEFAULT false,
  streak_count INTEGER NOT NULL DEFAULT 0,
  streak_last_claim TEXT,
  stats_bets INTEGER NOT NULL DEFAULT 0,
  stats_wagered INTEGER NOT NULL DEFAULT 0,
  stats_won INTEGER NOT NULL DEFAULT 0,
  stats_biggest INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS friends (
  id SERIAL PRIMARY KEY,
  user_a INTEGER NOT NULL REFERENCES users(id),
  user_b INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_a, user_b)
);

CREATE TABLE IF NOT EXISTS gifts (
  id SERIAL PRIMARY KEY,
  from_user INTEGER NOT NULL REFERENCES users(id),
  to_user INTEGER NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS duels (
  id SERIAL PRIMARY KEY,
  game TEXT NOT NULL,
  player_a INTEGER NOT NULL,
  player_b INTEGER,
  stake INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  winner INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS characters (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  archetype TEXT NOT NULL,
  rarity TEXT NOT NULL,
  value INTEGER NOT NULL,
  weight DOUBLE PRECISION NOT NULL,
  emoji TEXT NOT NULL DEFAULT '⭐'
);

CREATE TABLE IF NOT EXISTS inventory (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  character_id INTEGER NOT NULL REFERENCES characters(id),
  obtained_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bigwins (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  game TEXT NOT NULL,
  amount INTEGER NOT NULL,
  mult DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS site_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS global_stats (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
`;

const DEFAULT_SETTINGS = {
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

// Original fictional characters — deliberately NOT real people. Names, art and
// archetypes are all invented so packs never use anyone's real identity.
const ROSTER = [
  { name: 'Chatly Rae', archetype: 'IRL Streamer', rarity: 'Common', value: 500, weight: 40, emoji: '📹' },
  { name: 'Beat Boomer', archetype: 'Meme Musician', rarity: 'Common', value: 500, weight: 40, emoji: '🎧' },
  { name: 'Sk8 Milo', archetype: 'Trick-Shot Creator', rarity: 'Common', value: 500, weight: 40, emoji: '🛹' },
  { name: 'Pixel Pia', archetype: 'Speedrunner', rarity: 'Common', value: 500, weight: 40, emoji: '🎮' },
  { name: 'DJ Nova Flux', archetype: 'Viral DJ', rarity: 'Uncommon', value: 1500, weight: 22, emoji: '🎤' },
  { name: 'Glowbrook Zane', archetype: 'Dance-Trend Creator', rarity: 'Uncommon', value: 1500, weight: 22, emoji: '🕺' },
  { name: 'CaptainClutch99', archetype: 'FPS Pro Gamer', rarity: 'Uncommon', value: 1500, weight: 22, emoji: '🎯' },
  { name: 'Roast Marnie', archetype: 'Comedy Sketch Star', rarity: 'Uncommon', value: 1500, weight: 22, emoji: '🎭' },
  { name: 'Velvet Prankster King', archetype: 'Prank Vlogger', rarity: 'Rare', value: 4000, weight: 12, emoji: '🎥' },
  { name: 'Aria Duskwave', archetype: 'Pop Sensation', rarity: 'Rare', value: 4000, weight: 12, emoji: '⭐' },
  { name: 'Turbo Threadz', archetype: 'Fashion Hauler', rarity: 'Rare', value: 4000, weight: 12, emoji: '👟' },
  { name: 'The Midnight Caster', archetype: 'Esports Caster Legend', rarity: 'Epic', value: 10000, weight: 5, emoji: '🏆' },
  { name: 'Solstice Vane', archetype: 'Mega-Influencer', rarity: 'Epic', value: 10000, weight: 5, emoji: '💎' },
  { name: 'GOATed Emberlyn', archetype: 'Global Icon', rarity: 'Legendary', value: 30000, weight: 1, emoji: '👑' },
];

async function init() {
  await pool.query(SCHEMA);

  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await run('INSERT INTO site_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [k, v]);
  }
  for (const k of ['wagered', 'returned', 'coins_sold']) {
    await run('INSERT INTO global_stats (key, value) VALUES ($1, 0) ON CONFLICT (key) DO NOTHING', [k]);
  }

  const countRow = await one('SELECT COUNT(*)::int AS c FROM characters');
  if (countRow.c === 0) {
    for (const c of ROSTER) {
      await run(
        'INSERT INTO characters (name, archetype, rarity, value, weight, emoji) VALUES ($1, $2, $3, $4, $5, $6)',
        [c.name, c.archetype, c.rarity, c.value, c.weight, c.emoji]
      );
    }
  }
  console.log('Database ready.');
}

module.exports = { pool, all, one, run, init };
