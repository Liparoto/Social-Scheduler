# Design — Export & Backup

**Status:** approved, not yet implemented
**Date:** 2026-07-24

## Problem

There is currently no way to get content out of SocialScheduler. Everything —
captions, tags, evergreen scheduling rules, send history, metrics, and the images
themselves — lives in one gitignored SQLite file and one gitignored asset folder. If
that Mac dies, or the install is abandoned, all of it is gone.

Two distinct needs sit behind this:

1. **Archive / interop** — open the content in Excel or Google Sheets, read captions
   and tags, browse the images in Google Drive. Human-readable, lossy is acceptable.
2. **Backup** — a file that a future version of this tool could re-import to restore
   an install. Machine-readable, fidelity is mandatory.

This design covers both from a single command. **Re-import is explicitly out of scope**
— this ships the export half. The JSON artifact is written now so that a future
importer has something to consume, but no importer is being built.

## Non-goals

- Re-importing an export back into an install (future work).
- Uploading to Google Drive, Dropbox, or any cloud service via API.
- Filtering by date, channel, or status (a full export is the only mode).
- Exporting from a remote or shared install — there is no such thing in this project.

## Decisions

Each of these was chosen over a named alternative; the reasoning is recorded so a
later reader does not re-litigate it.

### Both artifacts, one command

The export produces a human workbook **and** a machine-readable JSON file in the same
folder. Walking the database is the expensive part; once done, emitting a second
representation is nearly free.

### Multi-tab workbook, not a flat sheet

The data is relational — one post has many sends, each send has many metric
snapshots. A single flat sheet must either duplicate captions on every row or discard
per-send detail. Five tabs, each with one clear grain, preserves everything.

*Rejected:* one row per post (loses send history); one row per send (captions repeat
on every row, unreadable).

### A local folder, not a Google Drive integration

The export writes a plain folder to disk. The user drags it into Drive, Dropbox, or
iCloud in Finder.

*Rejected:* direct Drive upload via API. It would add OAuth, a Google Cloud project,
credentials in `.env`, and a new dependency — and would bind the export to one
provider — to save a single drag in Finder. It also conflicts with the project rule
that no cloud service is added without an explicit request. If it is ever wanted, it
layers on top of this design without changing it.

### A double-click script, not a dashboard button

The exporter is standalone and does not require the dashboard or worker to be
running.

*Rejected:* a dashboard button. A backup is most valuable precisely when the app is
unhealthy; an export that lives inside Next.js is unavailable exactly when it is most
needed. The script also matches the existing `Start-` / `Update-` hand-off pattern and
is runnable by a non-technical owner of a fresh clone.

### Both original and published image bytes

`assets` may hold an original upload (`storage_path`) and a conformed copy actually
sent to Instagram (`publish_path`). Originals are irreplaceable source material;
published copies are the historical record of what appeared. Conforming only affects
some assets, so the second folder is usually small.

*Rejected:* originals only (loses the record of what was actually posted); published
only (destroys the uncropped original permanently).

### `openpyxl` as the one new dependency

The Python standard library cannot write `.xlsx`, and a multi-tab workbook was a
requirement. `openpyxl` is pure Python with no compiled extensions or system
libraries.

*Rejected:* five loose CSV files. Google Sheets imports those as five unrelated
documents, which is not a workbook.

## Output

Running the export creates one dated, self-contained folder:

```
~/Documents/SocialScheduler Exports/2026-07-24-1930/
├── README.txt                      plain-English description of the folder
├── SocialScheduler-Export.xlsx     five tabs, human-readable
├── export.json                     full relational fidelity, for future re-import
├── images/                         every original asset
│   ├── 0042_shoulder-mobility-tips_1.jpg
│   ├── 0042_shoulder-mobility-tips_2.jpg
│   └── 0051_balance-screening-week_1.jpg
└── images-published/               only assets whose IG copy differs from the original
    └── 0042_shoulder-mobility-tips_1.jpg
```

Finder opens on the folder when the run completes.

### Image filenames

`{post_id:04d}_{caption-slug}_{position}.{ext}`

Post ID first so files sort into post order; caption slug so a human can recognize the
image; position for carousel ordering. This keeps images meaningful after they are
detached from the app and sitting in Drive.

Slugs are ASCII-only, lowercased, non-alphanumerics collapsed to `-`, and truncated to
40 characters. A caption that slugs to an empty string (pure emoji, or no caption)
falls back to `untitled`. Collisions get a numeric suffix.

An asset used by more than one post is exported once per post that uses it, under each
post's name. Duplication on disk is cheaper than a filename that only makes sense with
the workbook open.

### Timestamps

Every timestamp column renders in the relevant channel's IANA timezone, with the raw
UTC value in an adjacent column. The database stores UTC; a spreadsheet that silently
displayed UTC would cause every send time to be misread. Where no channel applies
(post `created_at`), the local system timezone is used.

## Workbook tabs

### `Posts` — one row per post

`post_id` · `caption` · `first_comment` · `post_type` · `content_kind` ·
`content_status` · `status` · `tags` · `green_periods` · `blackout_periods` ·
`cooldown_days` · `target_channels` · `image_files` · `times_posted` ·
`last_posted_at` · `total_reach` · `total_likes` · `created_by` · `created_at`

The primary tab, designed to be useful alone. Multi-value fields (`tags`,
`target_channels`, `image_files`) are comma-joined; `image_files` preserves
`post_assets.sort_order`.

Rollups are computed from publications that are `posted` and not dry runs.
`times_posted` counts them; `last_posted_at` is the most recent `published_at`;
`total_reach` and `total_likes` sum the **latest** metric snapshot per publication —
not every snapshot, which would multiply-count.

### `Sends` — one row per publication

`publication_id` · `post_id` · `caption_preview` · `channel` · `scheduled_at_local` ·
`scheduled_at_utc` · `published_at_local` · `status` · `is_held` · `is_dry_run` ·
`attempt_count` · `last_error` · `remote_post_id`

Complete send history including failures, per the project rule that failed publishes
are visible and never silent. `caption_preview` is the first 60 characters, for
orientation without leaving the tab.

No permalink column: `remote_post_id` is a Graph API media ID, not an Instagram
shortcode, and cannot be turned into a public URL offline.

### `Metrics` — one row per snapshot

`publication_id` · `post_id` · `fetched_at` · `reach` · `impressions` · `likes` ·
`comments` · `saves` · `shares` · `video_views`

Every snapshot is kept, not only the most recent, so accumulation over a post's 30-day
window can be charted. `raw_json` is omitted from the workbook (unreadable in a cell)
but is preserved in `export.json`.

### `Assets` — one row per asset

`asset_id` · `exported_filename` · `original_filename` · `media_kind` · `width` ·
`height` · `byte_size` · `conform_mode` · `needs_review` · `content_hash` ·
`used_by_posts` · `published_copy_filename`

`content_hash` is what a future importer uses to skip assets already present.

Because an asset shared by two posts is written to disk once under each post's name,
`exported_filename` and `published_copy_filename` are comma-joined lists, ordered to
match `used_by_posts`.

### `Channels` — configuration only

`channel_id` · `platform` · `account_name` · `business_label` · `timezone` ·
`is_active` · `requires_approval` · `autofill_enabled` · `cadence_config` ·
`min_queue_depth` · `target_queue_depth` · `reuse_min_age_days` ·
`remote_account_id` · `linked_page_id`

**`access_token` and `token_expires_at` are excluded via an explicit allow-list.** The
exporter names the columns it emits rather than selecting the whole table, so a future
migration that adds a secret column cannot leak it into a file destined for Google
Drive. A restored install re-authenticates, which is correct — tokens expire anyway.

This allow-list rule applies to `export.json` identically. The JSON is not a raw table
dump.

## Implementation

**Module:** `worker/export.py`, invoked as `.venv/bin/python -m worker.export`. It
reuses `worker.db.connect` and slots into the existing `worker/tests/` pytest suite.
No new project structure.

**Launcher:** `Export-Mac.command` — a thin double-click wrapper that activates the
venv, runs the module, and `open`s the output folder in Finder. Mirrors the existing
`Start-SocialScheduler-Mac.command` and `Update-Mac.command`.

**Dependency:** add `openpyxl>=3.1` to the root `requirements.txt`.

### Safety properties

This is a backup tool, so it must be structurally incapable of making things worse.

- **`PRAGMA query_only = ON`** on its connection. SQLite rejects every write at the
  database level — not "the code is careful," but unable in principle. Safe to run
  while the worker is mid-publish, since WAL permits concurrent readers.
- **Never overwrites.** Each run creates its own `YYYY-MM-DD-HHMM` folder. Running it
  twice by accident costs disk, never data.
- **Zero network calls.** No Graph API, no tunnel, no token is read. Works offline and
  with the worker stopped.
- **Missing files do not abort the run.** An asset row pointing at a file that is gone
  is flagged `MISSING` in the `Assets` tab and counted in `README.txt`. A partial
  backup known to be partial beats a crash and no backup at all.
- **Never logs secrets.** Consistent with existing project logging rules.

### Error handling

The export is best-effort per row and fails loudly only when it cannot proceed at all
(database unreadable, output directory not writable). Per-row problems — a missing
asset file, an unreadable image, an undecodable caption — are recorded and summarized
in `README.txt`, and the run completes. The exit code is non-zero only on total
failure, so the `.command` wrapper can surface a real problem without crying wolf over
one missing thumbnail.

## Verification

The design is not complete until these pass:

1. **Unit tests** in `worker/tests/test_export.py` against a temporary database,
   including the two that matter most:
   - `access_token` appears in **no** output file, at all.
   - The database file is byte-identical before and after a run.
2. **Edge cases:** empty database; post with no images; post with no sends; asset row
   whose file is missing from disk; caption that is pure emoji; asset shared by two
   posts.
3. **A real run against the live database**, followed by comparing workbook row counts
   against `sqlite3` counts directly. The comparison is shown, not asserted.

## Future work

Deliberately deferred, and none of it requires revisiting the above:

- **Re-import** — consume `export.json` into a fresh install, deduplicating assets by
  `content_hash`.
- **Filters** — `--since`, `--channel`, `--status` flags on the script.
- **Direct cloud upload** — layers on top of the finished folder if ever wanted.
- **Windows launcher** — `Export-Windows.bat`, matching the existing pair.
