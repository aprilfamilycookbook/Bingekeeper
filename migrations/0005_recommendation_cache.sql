CREATE TABLE IF NOT EXISTS recommendation_cache (
  source_show_id INTEGER NOT NULL,
  cache_key TEXT NOT NULL,
  payload TEXT NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (source_show_id, cache_key)
);
