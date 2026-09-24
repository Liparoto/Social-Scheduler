---
name: prepping-posts-for-review
description: Use when turning a folder of photos into posts for this install — drafting captions and hashtags for a batch of images, preparing posts for the owner to look over, or putting photos into the library and scheduler.
---

# Prepping posts for review

Turn a folder of photos into finished posts the owner approves **by looking at them**, then
import the approved batch. Optional tooling for this install; skip it for a single post.

## The gate

**Nothing reaches the database until the owner has seen the photos with their captions and
said yes.** Not a filename list, not a markdown summary, not "I'll import as drafts so you
can review in the dashboard" — a page showing each post's photos, in order, with the exact
caption and hashtags that will be posted.

Why: the owner is approving the *pairing*. A caption reads fine next to the wrong photo, and
nobody catches that from a list of filenames. Every batch prepped this way has come back with
regrouping notes that a text summary would have hidden.

| Rationalization | Reality |
|---|---|
| "I'll import as drafts, drafts are harmless" | A draft is still 200 rows and 600 files in their library to undo. Show the page. |
| "They said make posts and get them in" | "Make them" is the whole job; the review is how it gets done, not an extra step. |
| "The photos are obvious, no caption risk" | The mis-pairings come from photos that look obvious. |
| "They approved round 1, so round 2 is approved" | Approval covers what was on the page. Rebuild and re-show. |
| "I'll show the page and start the backup meanwhile" | Fine. Backing up is not importing. Stop before the import. |

**Red flags — stop:** you are about to run `import_manifest.py` and the owner has not
replied to a page; you are describing posts in chat instead of building one; you changed a
caption after approval and did not re-show it.

## Setup

One extra library, needed before step 1 and only for this:

```bash
.venv/bin/pip install -r requirements-import.txt
```

## Steps

1. **Inspect the folder.**
   ```bash
   BATCH=trip-2026-07   # a short slug; everything below uses it
   .venv/bin/python scripts/photo_inventory.py "<folder>" \
       --json "data/import-work/$BATCH/inventory.json" \
       --sheets "data/import-work/$BATCH/sheets"
   ```
   Gives real capture times with the camera's own UTC offset, locations, true orientation,
   and near-duplicate groups. Never infer when a photo was taken from its file date.
2. **Actually look at the photos.** Read the contact sheets. Captions written from filenames
   and EXIF alone describe the wrong thing — this is the single most common failure.
3. **Write the plan** at `data/import-work/$BATCH/plan.json` — format in
   [references/approval-page.md](references/approval-page.md), captions and hashtags in
   [references/style.md](references/style.md), grouping below. Work lives in
   `data/import-work/` (per-install, gitignored), not a temp folder that gets wiped.
4. **Build the page.**
   ```bash
   .venv/bin/python scripts/build_approval_page.py "data/import-work/$BATCH/plan.json" \
       --out-dir "data/import-work/$BATCH"
   ```
   Writes `approval.html`, the import manifest, and a snapshot of this round. It refuses to
   build on a broken plan, and prints `CHECK:` lines for things worth a second look. Read
   them — they are not failures, so nothing else will stop you.
5. **Show it and stop.** Send the page to the owner and wait. Ask in the same message for
   anything the page marks as a question, and for the channels if the plan has none.
6. **Each round of feedback:** edit the plan, bump `"round"`, rebuild with
   `--previous data/import-work/$BATCH/plan-round-<N>.json` so every post shows where it came
   from and the edits they asked for are highlighted. Re-show. Repeat until they approve.
7. **Import**, only after an explicit yes — back up, dry run, import, tag, verify:
   [references/importing.md](references/importing.md).

## Grouping photos into posts

- **One moment, one post.** Several angles of the same scene belong in one carousel; a
  different place or hour is a different post.
- **"Same moment" in the inventory means near-identical frames**, not "these belong
  together" — usually one is a re-export or a burst frame. Keep the best, and put the rest in
  `excluded` with the reason. Only keep both when they genuinely show different things.
- **Carousels: 2–6 photos is comfortable, 10 is the hard limit.** Lead with the strongest
  photo, since it is the cover and the only one most people see.
- **Keep one shape per carousel.** Instagram crops every slide to the first one's shape. The
  builder warns when a post mixes them.
- **A photo with no capture time** tells you nothing about where it belongs. Don't slot it
  into a day by guessing — give it its own post or ask, and set `time_of_day` to `anytime`.

## When you can't tell what a photo shows

Say so on the page instead of inventing. Put a plain question on the post:

```json
"question": "Which restaurant is this? I can't tell from the photo and the caption is a placeholder."
```

The page shows it as a **Question for you** block on that post and counts it in the header,
so the owner answers it in the same pass as everything else. A confident invented caption is
the one failure that survives review, because nothing on the page looks wrong.

Ask about people's names, places, dishes and dates rather than guessing. Never invent a fact
the owner would have to correct publicly.

## Keep in mind

- Captions must stand alone. Evergreen posts get shuffled by autofill, so "a few more from
  that night" lands next to nothing.
- A photo belongs to exactly one post. Anything you leave out goes in `excluded` with a
  reason; anything in neither is listed on the page as unaccounted for.
- Check what the account has already posted before writing anything that contradicts it.
