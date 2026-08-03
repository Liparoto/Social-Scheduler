# Media page → post links — design

**Date:** 2026-08-02
**Status:** draft — awaiting owner review
**Related:** none. Fully independent of the three Library sub-projects; can be built at any time.

## Problem

From the Media page there is no reliable way to get to the post an asset belongs to — the owner
has been going back to the Library and re-finding it by eye.

**The link partly exists already**, which is why this is worth stating precisely.
`media-manager.tsx:140` renders:

```
In post #7 (draft) +2 more
```

where `post #7` links to `/library/7`. Two things make it insufficient:

**(a) Reused media dead-ends.** `listAssetsWithUsage()` in `dashboard/lib/queries.ts` returns:

```sql
MIN(pa.post_id) AS first_post_id
```

That is the **lowest-numbered** post using the asset — chosen arbitrarily by id, with no
relationship to relevance or recency. Every other post collapses into the plain text `+N more`,
which is **not a link and not reachable**. For an asset reused across posts — the normal case for
evergreen recycling, which is a primary goal of this install — most of its posts cannot be
navigated to at all.

**(b) `post #47` is unrecognisable.** A bare id gives nothing to identify the post by, so even
the one working link often requires opening it to find out whether it was the right one.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Data shape | Return **all** `(post_id, caption, status)` per asset | `MIN()` picks an arbitrary post and strands the rest |
| Query | **Batched** — one query for all assets | Per-asset lookups are N+1 across the whole asset store |
| Label | Caption's **first line**, with the id as secondary | `post #47` carries no information |
| Many posts | Show the first few inline, rest behind a popover/expander | Keeps the card readable when an asset is heavily reused |
| Deletion behaviour | **Unchanged** | See below — do not disturb it |
| Migration | **None** | `post_assets` already holds the relationship |
| New dependencies | **None** | |

### Do not disturb the delete guard

The Media page's delete path is protected by two things working together:
`post_assets.asset_id` is `ON DELETE RESTRICT` (from `0001_init.sql`), and `deleteAsset()` carries
a `NOT EXISTS` guard **on the DELETE statement itself**, so an asset attached a millisecond later
cannot be deleted out from under a pending publish.

This change touches the *read* path only. The used/unused determination and the delete button's
presence must behave exactly as they do now — an asset with posts shows no delete button, an
unused asset still deletes. Treat that as a regression surface, not a thing to improve here.

## Architecture

`listAssetsWithUsage()` currently does a nested `GROUP BY` with `MIN(pa.post_id)`, then a
`LEFT JOIN` to resolve that one post's status. Replace with a shape that carries the full set —
a second batched query over `post_assets` joined to `posts`, keyed by asset id and assembled in
memory, is the straightforward option and keeps the main query readable.

`media-manager.tsx` then renders each post as its own link, with the caption's first line as the
label, instead of one link plus dead `+N more` text.

Keep `post_count` — the header summary and the used/unused branch both rely on it.

## Out of scope

- Changing deletion, or adding bulk delete.
- A reverse view (post → its assets); the post editor already shows attached media.
- Reordering or re-attaching assets from this page.
- Thumbnails per linked post (the asset thumbnail is already right there).

## Risks

| Risk | Mitigation |
|---|---|
| N+1 across the whole asset store | One batched query; verify query count does not scale with asset count |
| Breaking the used/unused branch or delete guard | Read-path change only; explicit regression check that unused assets still delete and used ones still show no button |
| Cards becoming unreadable for heavily-reused assets | Show first few inline, rest behind an expander |
| Captions containing newlines/very long text | Take the first line and truncate, as the Library cards already do |
