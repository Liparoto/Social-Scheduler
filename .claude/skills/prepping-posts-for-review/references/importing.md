# Importing an approved batch

Only after an explicit yes. Every step below is reversible up to the import itself.

Set these once and paste the rest:

```bash
BATCH=bali-2026
DIR="data/import-work/$BATCH"
LABEL="$BATCH-$(date +%Y-%m)"
```

## 1. Back up the database

A batch import touches hundreds of rows. Take a copy first and **prove it opens** — a backup
you have not verified is not a backup.

```python
# .venv/bin/python - <<'PY'
import sqlite3
src = sqlite3.connect("file:data/socialscheduler.db?mode=ro", uri=True)
dst = sqlite3.connect("/tmp/pre-import.db")
src.backup(dst)
print(dst.execute("pragma integrity_check").fetchone())
for t in ("posts", "assets", "publications"):
    print(t, src.execute(f"select count(*) from {t}").fetchone()[0],
             dst.execute(f"select count(*) from {t}").fetchone()[0])
PY
```

Counts must match, integrity must be `ok`, then move it to `data/pre-$BATCH-import-$(date +%Y%m%d).db`.
Never copy a live database file directly — it has a write-ahead log beside it, and a plain
copy can be torn. The `sqlite3` command's `.backup` can fail in a restricted environment and
leave a file that looks complete but will not open, which is why this uses Python's own
backup call.

The backup contains live access tokens. It stays in `data/` (gitignored) and is never shared.

## 2. Dry run

The dashboard must be running — the importer uploads through it, so uploads get the same
hashing, deduplication, aspect conforming and thumbnails as every other path.

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3939/
.venv/bin/python scripts/import_manifest.py --manifest "$DIR/manifest.json" \
    --channels 1,2,4 --dry-run
```

Check the post count, photo count and channel targets against the approved page.

## 3. Import

```bash
.venv/bin/python scripts/import_manifest.py --manifest "$DIR/manifest.json" \
    --channels 1,2,4 --kind evergreen --status ready --created-by "$LABEL"
```

- `--channels` are channel ids from the `channels` table — the same ones the plan carries and
  the page showed, which the page builder prints for you at the end of every build. To look
  them up: `sqlite3 -readonly data/socialscheduler.db "select id, platform, account_name from
  channels"`. Never `select *` there — it prints live access tokens.
- `--status ready` means autofill can start scheduling them. Use `draft` when the owner wants
  them parked, and say which you used.
- `--created-by` is a free-text label; it is how you find or undo this batch later.
- Safe to re-run: the run log skips posts already created.

## 4. Captions, tags and time bands

Post ids only exist after the import. Read them from the run log rather than typing a range.

```bash
.venv/bin/python scripts/build_approval_page.py "$DIR/plan.json" \
    --tags-out "$DIR/tags.json" \
    --runlog "$DIR/manifest.json.runlog.jsonl"
.venv/bin/python scripts/apply_library_metadata.py "$DIR/tags.json" --dry-run
.venv/bin/python scripts/apply_library_metadata.py "$DIR/tags.json"
```

This writes the caption to both `posts.caption` and a generic `caption_variants` row. The
editor reads the variant, so a post with only `posts.caption` shows an empty caption box —
and saving from that screen writes the blank over the real caption.

## 5. Verify

```bash
sqlite3 -readonly data/socialscheduler.db "
  select count(*), content_status, content_kind from posts
   where created_by = '$LABEL' group by 2,3;
  select count(*) from posts p left join caption_variants cv
    on cv.post_id = p.id and cv.platform is null
   where p.created_by = '$LABEL' and cv.id is null;"
```

The second query must return 0. Then open `/library` and spot-check several posts against the
approval page, including their photo order.

Tell the owner plainly: how many posts, which channels, whether they are ready or draft,
how many photos are flagged `needs_review` (automatically cropped to Instagram's aspect —
they publish fine, the crop is just unconfirmed), any seasonal restrictions, and where the
rollback backup is.

## Undoing

Restore the backup, or delete by label: the posts with that `created_by`, then only the
assets no surviving post references, then their files. Delete the run log too, or a
re-import will skip everything as already done.
