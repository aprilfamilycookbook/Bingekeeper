ALTER TABLE push_subscriptions ADD COLUMN last_success_at INTEGER;
ALTER TABLE push_subscriptions ADD COLUMN last_failure_at INTEGER;
ALTER TABLE push_subscriptions ADD COLUMN last_failure_status INTEGER;
ALTER TABLE push_subscriptions ADD COLUMN last_failure_reason TEXT;
