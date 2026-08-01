CREATE TABLE IF NOT EXISTS notification_delivery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  test_id TEXT,
  source TEXT,
  user_id INTEGER NOT NULL,
  show_id INTEGER,
  episode_key TEXT,
  channel TEXT NOT NULL,
  subscription_id INTEGER,
  device_id TEXT,
  device TEXT,
  attempted_at INTEGER DEFAULT (unixepoch()),
  provider_status INTEGER,
  success INTEGER DEFAULT 0,
  failure_reason TEXT,
  fallback_attempted INTEGER DEFAULT 0,
  notifications_sent_written INTEGER DEFAULT 0,
  sw_received_at INTEGER,
  sw_displayed_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_notification_delivery_attempts_recent
  ON notification_delivery_attempts(attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_delivery_attempts_user_episode
  ON notification_delivery_attempts(user_id, show_id, episode_key);

ALTER TABLE push_subscriptions ADD COLUMN device_id TEXT;
