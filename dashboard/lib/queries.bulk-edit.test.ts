import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";

makeTestDb();
const q = await import("./queries.ts");
const db = (await import("./db.ts")).getDb();

let fixtureSeq = 0;

function makePosts(count: number): number[] {
  return Array.from({ length: count }, () =>
    q.createDraftPost({
      caption: `bulk-edit-${++fixtureSeq}`,
      first_comment: "",
      asset_ids: [],
    })
  );
}

function tagLinkCount(postIds: number[], tagId: number): number {
  const placeholders = postIds.map(() => "?").join(",");
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM post_tags
          WHERE post_id IN (${placeholders}) AND tag_id = ?`
      )
      .get(...postIds, tagId) as { n: number }
  ).n;
}

test("adding a tag to several posts is idempotent", () => {
  const postIds = makePosts(3);
  const tag = q.createTopicTag(`bulk-add-${fixtureSeq}`);

  const first = q.bulkEditPosts({ post_ids: postIds, tags: { add: [tag.id], remove: [] } });
  const second = q.bulkEditPosts({ post_ids: postIds, tags: { add: [tag.id], remove: [] } });

  assert.equal(tagLinkCount(postIds, tag.id), 3);
  assert.equal(first.tags_added, 3);
  assert.equal(second.tags_added, 0);
});

test("removing one tag preserves every other tag", () => {
  const postIds = makePosts(2);
  const removeTag = q.createTopicTag(`bulk-remove-${fixtureSeq}`);
  const keepTag = q.createTopicTag(`bulk-keep-${fixtureSeq}`);
  q.bulkEditPosts({
    post_ids: postIds,
    tags: { add: [removeTag.id, keepTag.id], remove: [] },
  });

  const result = q.bulkEditPosts({
    post_ids: postIds,
    tags: { add: [], remove: [removeTag.id] },
  });

  assert.equal(tagLinkCount(postIds, removeTag.id), 0);
  assert.equal(tagLinkCount(postIds, keepTag.id), 2);
  assert.equal(result.tags_removed, 2);
});

test("period and scalar edits apply without replacing unrelated links", () => {
  const postIds = makePosts(2);
  const keptPeriod = q.createPeriod({
    name: `Keep ${fixtureSeq}`,
    recurs_yearly: true,
    start_month: 1,
    start_day: 1,
    end_month: 2,
    end_day: 1,
  });
  const removedPeriod = q.createPeriod({
    name: `Remove ${fixtureSeq}`,
    recurs_yearly: true,
    start_month: 3,
    start_day: 1,
    end_month: 4,
    end_day: 1,
  });
  q.bulkEditPosts({
    post_ids: postIds,
    periods: {
      add: [
        { periodId: keptPeriod, mode: "green" },
        { periodId: removedPeriod, mode: "blackout" },
      ],
      remove: [],
    },
  });

  const result = q.bulkEditPosts({
    post_ids: postIds,
    periods: {
      add: [],
      remove: [{ periodId: removedPeriod, mode: "blackout" }],
    },
    content_status: "ready",
    content_kind: "one_time",
    cooldown_days: 45,
  });

  for (const postId of postIds) {
    assert.deepEqual(q.getPostPeriods(postId), [{ period_id: keptPeriod, mode: "green" }]);
    const post = q.getPost(postId);
    assert.equal(post?.content_status, "ready");
    assert.equal(post?.content_kind, "one_time");
    assert.equal(post?.cooldown_days, 45);
  }
  assert.equal(result.periods_removed, 2);
  assert.equal(result.posts_updated, 2);
});

test("an error after the first write rolls back the entire bulk edit", () => {
  const postIds = makePosts(3);
  const tag = q.createTopicTag(`bulk-rollback-${fixtureSeq}`);
  db.exec(`
    CREATE TRIGGER fail_bulk_edit_test
    BEFORE INSERT ON post_tags
    WHEN NEW.post_id = ${postIds[1]} AND NEW.tag_id = ${tag.id}
    BEGIN
      SELECT RAISE(ABORT, 'forced bulk edit failure');
    END;
  `);

  assert.throws(
    () => q.bulkEditPosts({ post_ids: postIds, tags: { add: [tag.id], remove: [] } }),
    /forced bulk edit failure/
  );
  assert.equal(tagLinkCount(postIds, tag.id), 0);
  db.exec("DROP TRIGGER fail_bulk_edit_test");
});
