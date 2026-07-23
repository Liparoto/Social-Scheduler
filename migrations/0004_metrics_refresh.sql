-- 0004_metrics_refresh.sql
-- On-demand metrics refresh: the dashboard sets this timestamp to REQUEST a metrics
-- fetch for a posted publication; the worker honors it (bypassing the once-per-interval
-- gate) on its next poll, then clears it. NULL = no pending request. Additive.
ALTER TABLE publications ADD COLUMN metrics_refresh_requested_at TEXT;
