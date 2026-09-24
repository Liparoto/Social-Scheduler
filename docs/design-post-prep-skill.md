# Design — Optional post-prep skill (photos → reviewed posts)

**Status:** built 2026-09-23
**Depends on:** ③ Bulk import (`scripts/import_manifest.py`) + the tagging taxonomy
(`scripts/apply_library_metadata.py`), both shipped.
**Feeds:** anyone who connects an AI assistant to their clone and wants a batch of photos
turned into posts without hand-writing each one.

---

## 1. Purpose

The back half of batch loading was already committed: a manifest goes in, posts come out,
metadata gets applied. The front half — looking at a folder of photos, grouping them into
posts, writing captions, and getting the owner to actually approve them — lived only in
whichever chat session happened to be doing it. Every batch rebuilt the same throwaway
tooling, and the owner's own review conventions travelled nowhere.

This packages that front half as an **optional skill** inside the repo, so a clone that
connects an AI assistant gets the same workflow without asking for it, and a clone that
never preps a photo batch installs nothing and notices nothing.

It is deliberately not a dashboard feature. The work is judgement — which photos belong
together, what the caption should say — and that is what an assistant is for. The repo's job
is to make the process legible and to stop the assistant from writing to the library before
the owner has looked.

---

## 2. Shape

```
.claude/skills/prepping-posts-for-review/
    SKILL.md                  the gate + the workflow
    references/style.md       caption and hashtag principles
    references/approval-page.md   plan format, building, showing, reading feedback
    references/importing.md   backup → dry run → import → tag → verify → undo
scripts/photo_inventory.py    folder → capture times, GPS, orientation, duplicates, sheets
scripts/build_approval_page.py   plan → approval page + manifest + (later) tag batch
scripts/tests/                unit tests for both
requirements-import.txt       Pillow, optional, only for this
```

`.claude/skills/` rather than a plain folder because Claude Code discovers skills there
automatically — a clone gets it with no setup. Any other assistant can be pointed at the
same file.

---

## 3. One plan file is the source of truth

A batch is one `plan.json`: the posts, their photos in order, the caption body, hashtags,
library tags, and anything deliberately left out with a reason. The approval page, the import
manifest and the post-import tag batch are all generated from it.

The alternative — a page built for review and a manifest maintained beside it — lets the two
drift, which means the thing approved and the thing imported are not provably the same. They
are now the same file.

## 4. Rounds are diffed, not remembered

Every build writes `plan-round-N.json` beside the page. The next round is built with
`--previous`, and the builder derives each post's origin ("was P-04 + P-09"), what changed,
and which captions were rewritten — highlighted in a colour that shifts each round.

This exists because the labels were previously maintained by hand and were wrong twice in
one review, each time sending a correction to the wrong post.

## 5. Post ids come from the run log

`apply_library_metadata.py` needs real post ids, which only exist after the import. The
builder reads them from the importer's run log and matches them by the post's photo list,
using the same key formula the importer uses — a test asserts the two agree, because if they
ever diverge every tag lands on the wrong post.

## 6. What is checked before anyone reviews

A photo used in two posts · an empty caption · a carousel over Instagram's 10 slides · a file
type the importer cannot upload · a missing file · two posts with an identical hashtag set ·
an unknown time band. Checked by hand instead: mixed orientation inside one carousel, and
whether the caption matches the photo.

## 7. The one dependency

Pillow, in `requirements-import.txt`, installed only by people who use this. It reads capture
times and GPS, builds the embedded previews and contact sheets, and hashes images to find
near-duplicates. Neither the worker nor the dashboard imports it.

Duplicate detection ignores photos with almost no detail: a flat sky or wall has no pattern
to compare, and without that guard a folder containing a few of them reports everything as a
duplicate of everything.

---

## 8. Deliberately out of scope

- **Video.** Photo batches only; a Reel is a different pipeline.
- **Changing the importers.** `import_manifest.py` and `apply_library_metadata.py` are
  untouched — they already write to the live library and did not need to change.
- **Choosing anyone's voice.** The style reference carries principles and the reasoning
  behind them; a clone's own rules live in `data/post-style.md`, which is per-install and
  gitignored.
