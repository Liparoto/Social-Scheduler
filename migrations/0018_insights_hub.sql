-- =====================================================================================
-- 0018 — Insights hub: account-wide metrics for every connected profile.
--
-- post_metrics (0001_init) is keyed to publication_id, so it can only ever describe posts
-- THIS TOOL published. That is exactly right for autofill's performance ranking, which is
-- its only consumer, and exactly wrong for an analytics hub: a post made from the phone is
-- invisible to it, and so is every post that predates this install.
--
-- The hub therefore gets a SECOND anchor — the account's real media list as Meta reports
-- it (remote_media) — and its own metrics table hanging off that. post_metrics is left
-- completely untouched: it works, it is tested, and rewriting it to serve a second
-- consumer would put a working publish-side feature at risk for no gain. Where a remote
-- post IS one of ours, remote_media.publication_id links the two and the sync job copies
-- an existing fresh post_metrics snapshot across instead of paying Meta for it twice.
--
-- Purely additive: four new tables plus ALTER ... ADD COLUMN on channels. No CHECK is
-- being widened on an existing table, so none of the table-rebuild cascade-delete risk
-- that 0008/0009 carried applies here. Same shape as 0013_channel_groups.sql.
-- =====================================================================================

-- -------------------------------------------------------------------------------------
-- remote_media — one row per post that exists on the account, ours or not.
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS remote_media (
  id                  INTEGER PRIMARY KEY,
  channel_id          INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  remote_post_id      TEXT    NOT NULL,          -- the platform's own id for this post

  -- Set only when this post is one we published. ON DELETE SET NULL, NOT CASCADE, and the
  -- distinction matters: a publication is OUR record of a send, while a remote_media row
  -- is the ACCOUNT'S history. Deleting a publication (queue cleanup, a purged draft) must
  -- never erase the fact that the post exists and how it performed. Same reasoning as
  -- channel_groups.id ON DELETE SET NULL in 0013.
  publication_id      INTEGER REFERENCES publications(id) ON DELETE SET NULL,

  -- Stored verbatim as the platform reports them, NOT normalised into our post_type enum.
  -- Meta's vocabulary (IMAGE / VIDEO / CAROUSEL_ALBUM, FEED / REELS / STORY) is not ours
  -- and changes on their schedule; mapping it at write time would bake today's mapping
  -- into stored data. The dashboard maps for display, where a remap costs nothing.
  media_type          TEXT,
  media_product_type  TEXT,

  permalink           TEXT,
  caption             TEXT,
  thumbnail_url       TEXT,                      -- expires on Meta's CDN; treat as a hint
  published_at        TEXT,                      -- ISO-8601 UTC

  -- A post that vanishes from the API (deleted by hand, or a story past its 24h) is
  -- flagged, never deleted. Its metrics history stays valid and still belongs in totals
  -- for the period it was live; hard-deleting would silently rewrite past charts.
  is_deleted          INTEGER NOT NULL DEFAULT 0,

  raw_json            TEXT,                      -- full payload, for fields we don't column-ize
  first_seen_at       TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_synced_at      TEXT
);

-- The uniqueness that makes the sync job an upsert rather than a dedup problem: one row
-- per (channel, remote post). Re-running a full backfill is therefore idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_media_unique
  ON remote_media (channel_id, remote_post_id);
CREATE INDEX IF NOT EXISTS idx_remote_media_published
  ON remote_media (channel_id, published_at);
CREATE INDEX IF NOT EXISTS idx_remote_media_publication
  ON remote_media (publication_id);

-- -------------------------------------------------------------------------------------
-- media_metrics — per-post insights over time. Mirrors post_metrics' column set on
-- purpose: the same metrics mean the same things, and matching names let the two be read
-- by one set of helpers and copied between without a translation layer.
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS media_metrics (
  id                  INTEGER PRIMARY KEY,
  remote_media_id     INTEGER NOT NULL REFERENCES remote_media(id) ON DELETE CASCADE,
  fetched_at          TEXT    NOT NULL,          -- ISO-8601 UTC
  reach               INTEGER,
  impressions         INTEGER,
  likes               INTEGER,
  comments            INTEGER,
  saves               INTEGER,
  shares              INTEGER,
  video_views         INTEGER,
  raw_json            TEXT,
  created_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_media_metrics_media
  ON media_metrics (remote_media_id, fetched_at);

-- -------------------------------------------------------------------------------------
-- account_metrics — ONE ROW PER CHANNEL PER UTC DAY, upserted.
--
-- The day grain is the load-bearing decision in this migration. post_metrics appends a
-- row per fetch, which is right for a post (its totals only ever climb, and the shape of
-- that climb is interesting). An ACCOUNT series is different: it is read as "reach on
-- each day", so an append-per-fetch table would need dedup logic in every chart query,
-- and a job that ran twice would double a day. Upserting one row per day pushes that
-- correctness into the schema, where the unique index enforces it and a crashed or
-- double-run job simply cannot corrupt a series.
--
-- Every metric column is nullable, and that is not laziness: platforms report different
-- subsets (Threads has no reach, Facebook's names keep being retired), and a metric Meta
-- renamed lands in raw_json with its column left NULL. NULL means "this platform did not
-- report it", which the UI must render differently from a real zero.
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account_metrics (
  id                  INTEGER PRIMARY KEY,
  channel_id          INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  day                 TEXT    NOT NULL,          -- 'YYYY-MM-DD', UTC

  -- Snapshot values: what the account looked like at fetch time.
  followers_count     INTEGER,
  follows_count       INTEGER,
  media_count         INTEGER,

  -- Windowed values: what happened ON that day.
  reach               INTEGER,
  impressions         INTEGER,
  views               INTEGER,
  profile_views       INTEGER,
  accounts_engaged    INTEGER,
  total_interactions  INTEGER,
  likes               INTEGER,
  comments            INTEGER,
  saves               INTEGER,
  shares              INTEGER,
  replies             INTEGER,
  website_clicks      INTEGER,
  follows_gained      INTEGER,

  raw_json            TEXT,
  fetched_at          TEXT    NOT NULL,
  created_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_metrics_day
  ON account_metrics (channel_id, day);

-- -------------------------------------------------------------------------------------
-- audience_demographics — long/narrow, one row per bucket.
--
-- Narrow rather than a column per age band because the buckets are the PLATFORM'S, not
-- ours: Meta can add an age band or a country at will. A wide table would need a
-- migration every time that happened; this one needs none. The cost is a GROUP BY at
-- read time, which is nothing at this data volume.
--
-- Meta returns nothing at all for accounts under 100 followers. That is a normal state,
-- not an error, and the UI says so rather than showing an empty chart.
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audience_demographics (
  id                  INTEGER PRIMARY KEY,
  channel_id          INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  day                 TEXT    NOT NULL,          -- 'YYYY-MM-DD', UTC

  -- WHICH audience this describes. Meta exposes three and they answer different
  -- questions: who follows you, who saw you, who interacted.
  audience            TEXT    NOT NULL CHECK (audience IN ('followers', 'reached', 'engaged')),
  breakdown           TEXT    NOT NULL CHECK (breakdown IN ('age', 'gender', 'country', 'city', 'age_gender')),
  dimension           TEXT    NOT NULL,          -- '25-34', 'F', 'US', 'Sacramento, California'
  value               INTEGER NOT NULL,
  created_at          TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audience_unique
  ON audience_demographics (channel_id, day, audience, breakdown, dimension);
CREATE INDEX IF NOT EXISTS idx_audience_lookup
  ON audience_demographics (channel_id, audience, breakdown, day);

-- -------------------------------------------------------------------------------------
-- channels — sync bookkeeping.
--
-- These live on channels rather than in a side table because they are per-channel state
-- with exactly one row's worth of data, and the dashboard already reads the channel row
-- on every screen that would want to show "last synced".
-- -------------------------------------------------------------------------------------

-- Last time each job completed for this channel. NULL = never run, which the UI must show
-- as "not synced yet" rather than as zero metrics — a stopped worker looks identical to a
-- dead account otherwise, and that has already caused confusion once.
ALTER TABLE channels ADD COLUMN media_synced_at TEXT;
ALTER TABLE channels ADD COLUMN insights_synced_at TEXT;

-- The historical backfill is a one-time, expensive, paginated crawl. This flag is what
-- lets the sync job tell "first ever run, walk back through history" from "caught up,
-- just fetch what is new" — without it, every cycle would re-page the whole account.
ALTER TABLE channels ADD COLUMN media_backfill_complete INTEGER NOT NULL DEFAULT 0;

-- Last failure reason, so a channel whose token expired says so on its own card instead
-- of just showing stale numbers. Cleared on the next success.
ALTER TABLE channels ADD COLUMN insights_error TEXT;

-- Manual "sync now" from the dashboard: the same request/clear handshake as
-- publications.metrics_refresh_requested_at and channels.avatar_refresh_requested. The
-- dashboard sets it, the worker sweeps it up and clears it. A flag, not a status, so it
-- stays distinguishable from whatever the automatic cycle is doing.
ALTER TABLE channels ADD COLUMN insights_refresh_requested INTEGER NOT NULL DEFAULT 0;
