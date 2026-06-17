-- Users table
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  verified INTEGER DEFAULT 0,
  verify_token TEXT,
  reset_token TEXT,
  reset_expires INTEGER,
  notify_email INTEGER DEFAULT 1,
  is_admin INTEGER DEFAULT 0,
  plan TEXT DEFAULT 'free',
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  subscription_status TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);

-- OAuth provider links (Google now, Facebook-ready later)
CREATE TABLE IF NOT EXISTS oauth_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  email TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE(provider, provider_user_id)
);

-- Web Push subscriptions (one row per browser/device)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  enabled INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Shows table (cached TMDB data)
CREATE TABLE IF NOT EXISTS shows (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  poster_path TEXT,
  first_air_date TEXT,
  overview TEXT,
  next_episode_date TEXT,
  next_season_number INTEGER,
  next_episode_number INTEGER,
  last_checked INTEGER DEFAULT 0
);

-- Watchlist table (user-show relationship)
CREATE TABLE IF NOT EXISTS watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  show_id INTEGER NOT NULL,
  status TEXT DEFAULT 'Watching',
  service TEXT DEFAULT 'Other',
  current_season INTEGER DEFAULT 1,
  current_episode INTEGER DEFAULT 1,
  notify INTEGER DEFAULT 1,
  notify_pref TEXT DEFAULT 'two_days',
  added_at INTEGER DEFAULT (unixepoch()),
  FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE(user_id, show_id)
);

-- Notification log
CREATE TABLE IF NOT EXISTS notifications_sent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  show_id INTEGER NOT NULL,
  episode_key TEXT NOT NULL,
  sent_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(user_id, show_id, episode_key)
);
