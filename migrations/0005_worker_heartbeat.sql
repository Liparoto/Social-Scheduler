-- 0005_worker_heartbeat.sql
-- Worker liveness signal. The worker stamps last_seen_at on every poll; the dashboard
-- reads it to tell whether the worker is running (and therefore whether a queued metrics
-- refresh will actually be picked up). Single-row table (id is always 1). Additive.
CREATE TABLE worker_heartbeat (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    last_seen_at TEXT NOT NULL   -- ISO-8601 UTC of the worker's most recent poll
);
