import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();

// "Removed from platform" is ONE fact with two detection paths. media_sync infers it from a
// post vanishing off the account's media list, which needs a remote_media mirror row to
// exist; the metrics fetch learns it first-hand from the platform's own error. The second
// exists because the first cannot see a post that was deleted before it was ever synced —
// there is no row for it and never will be, which is exactly publication 48's situation.

let seq = 0;

function makeSend(over: { remote_missing_at?: string | null } = {}): number {
  const channel = Number(
    db.prepare("INSERT INTO channels (platform, account_name) VALUES ('instagram', ?)")
      .run(`missing-badge-${++seq}`).lastInsertRowid
  );
  const postId = q.createDraftPost({ caption: `p${seq}`, first_comment: "", asset_ids: [] });
  db.prepare(
    `INSERT INTO publications
       (post_id, channel_id, scheduled_at, status, published_at, remote_post_id,
        is_dry_run, remote_missing_at)
     VALUES (?, ?, '2026-08-11T00:00:00+00:00', 'posted', '2026-08-11T00:00:00+00:00',
             'media-x', 0, ?)`
  ).run(postId, channel, over.remote_missing_at ?? null);
  return postId;
}

test("a publication the platform says is gone reads as removed", () => {
  const postId = makeSend({ remote_missing_at: "2026-08-21T18:00:00+00:00" });
  const [send] = q.getPostPublications(postId);
  assert.equal(send.removed_from_platform, 1);
});

test("a healthy publication with no mirror row is NOT called removed", () => {
  // The distinction the original comment insists on: absence of evidence is not deletion.
  // Every Story, and everything published before this install started syncing, lands here.
  const postId = makeSend();
  const [send] = q.getPostPublications(postId);
  assert.notEqual(send.removed_from_platform, 1);
});

test("the media-sync path still works on its own", () => {
  const postId = makeSend();
  const [before] = q.getPostPublications(postId);
  assert.notEqual(before.removed_from_platform, 1);

  const pub = db.prepare("SELECT id, channel_id FROM publications WHERE post_id = ?")
    .get(postId) as { id: number; channel_id: number };
  db.prepare(
    `INSERT INTO remote_media (channel_id, remote_post_id, publication_id, is_deleted,
                               published_at)
     VALUES (?, 'media-x', ?, 1, '2026-08-11T00:00:00+00:00')`
  ).run(pub.channel_id, pub.id);

  const [after] = q.getPostPublications(postId);
  assert.equal(after.removed_from_platform, 1, "neither path may shadow the other");
});
