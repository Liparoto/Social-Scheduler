import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";

// See queries.bands.test.ts: node --test gives each FILE its own process, but lib/db.ts
// memoises its connection, so every setup() in this file shares the first temp DB. Hence
// the per-setup prefix to keep tag names from colliding across tests.
let setupSeq = 0;

async function setup() {
  makeTestDb();
  const q = await import("./queries.ts");
  const db = (await import("./db.ts")).getDb();
  return { q, db, prefix: `t${++setupSeq}` };
}

function seedPost(db: ReturnType<typeof import("better-sqlite3")>): number {
  return Number(
    db
      .prepare(
        `INSERT INTO posts (caption, post_type, status, content_status, content_kind)
         VALUES ('x','single','draft','draft','evergreen')`,
      )
      .run().lastInsertRowid,
  );
}

test("deleteTopicTag removes the tag and detaches it from every post", async () => {
  const { q, db, prefix } = await setup();
  const tag = q.createTopicTag(`${prefix}-doomed`);
  const keep = q.createTopicTag(`${prefix}-keeper`);
  const a = seedPost(db);
  const b = seedPost(db);
  q.setPostTags(a, [tag.id, keep.id]);
  q.setPostTags(b, [tag.id]);

  const result = q.deleteTopicTag(tag.id);

  assert.equal(result.deleted, true);
  assert.equal(result.postCount, 2);
  assert.equal(
    q.listTags("topic").some((t) => t.id === tag.id),
    false,
    "tag row is gone",
  );
  // The other post keeps its surviving tag — deletion detaches, it does not clear.
  assert.deepEqual(
    q.getPostTags(a).map((t) => t.id),
    [keep.id],
  );
  assert.deepEqual(q.getPostTags(b), []);
  // Posts themselves are untouched.
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM posts WHERE id IN (?, ?)").get(a, b).n,
    2,
  );
});

test("deleteTopicTag refuses to delete a time-of-day band", async () => {
  const { q } = await setup();
  const morning = q.listTags("time_of_day").find((t) => t.name === "morning")!;

  assert.throws(() => q.deleteTopicTag(morning.id), q.ProtectedTagError);
  assert.equal(
    q.listTags("time_of_day").some((t) => t.id === morning.id),
    true,
    "band survives the refused delete",
  );
});

test("deleteTopicTag reports a miss instead of throwing", async () => {
  const { q } = await setup();
  assert.deepEqual(q.deleteTopicTag(999999), { deleted: false, postCount: 0 });
});

test("renameTopicTag renames in place, keeping every post attached", async () => {
  const { q, db, prefix } = await setup();
  const tag = q.createTopicTag(`${prefix}-Beech`);
  const a = seedPost(db);
  const b = seedPost(db);
  q.setPostTags(a, [tag.id]);
  q.setPostTags(b, [tag.id]);

  const renamed = q.renameTopicTag(tag.id, `${prefix}-Beach`);

  assert.equal(renamed?.id, tag.id, "same row — the id never changes");
  assert.equal(renamed?.name, `${prefix}-Beach`);
  assert.deepEqual(
    q.getPostTags(a).map((t) => t.name),
    [`${prefix}-Beach`],
  );
  assert.equal(q.listTopicTagsWithUsage().find((t) => t.id === tag.id)?.post_count, 2);
});

test("renameTopicTag trims and allows a case-only change", async () => {
  const { q, prefix } = await setup();
  const tag = q.createTopicTag(`${prefix}-beach`);
  // Names are UNIQUE COLLATE NOCASE, so the row collides with ITSELF unless excluded.
  const renamed = q.renameTopicTag(tag.id, `  ${prefix}-BEACH  `);
  assert.equal(renamed?.name, `${prefix}-BEACH`);
});

test("renameTopicTag rejects a name another tag already uses", async () => {
  const { q, prefix } = await setup();
  const tag = q.createTopicTag(`${prefix}-dog`);
  q.createTopicTag(`${prefix}-dogs`);

  assert.throws(
    () => q.renameTopicTag(tag.id, `${prefix}-DOGS`),
    q.DuplicateTagNameError,
    "case-insensitive collision is still a collision",
  );
  assert.equal(q.listTags("topic").find((t) => t.id === tag.id)?.name, `${prefix}-dog`);
});

test("renameTopicTag rejects a time-of-day band name and renaming a band", async () => {
  const { q, prefix } = await setup();
  const tag = q.createTopicTag(`${prefix}-topic`);
  const morning = q.listTags("time_of_day").find((t) => t.name === "morning")!;

  assert.throws(() => q.renameTopicTag(tag.id, "morning"), q.ReservedTagNameError);
  assert.throws(() => q.renameTopicTag(morning.id, "sunrise"), q.ProtectedTagError);
  assert.equal(
    q.listTags("time_of_day").find((t) => t.id === morning.id)?.name,
    "morning",
  );
});

test("renameTopicTag returns null for a tag that isn't there", async () => {
  const { q } = await setup();
  assert.equal(q.renameTopicTag(999999, "whatever"), null);
});

test("listTopicTagsWithUsage counts the posts carrying each tag", async () => {
  const { q, db, prefix } = await setup();
  const used = q.createTopicTag(`${prefix}-used`);
  const unused = q.createTopicTag(`${prefix}-unused`);
  q.setPostTags(seedPost(db), [used.id]);
  q.setPostTags(seedPost(db), [used.id]);

  const rows = q.listTopicTagsWithUsage();
  const byId = new Map(rows.map((r) => [r.id, r]));

  assert.equal(byId.get(used.id)?.post_count, 2);
  assert.equal(byId.get(unused.id)?.post_count, 0);
  // Topics only — the bands are managed by the scheduler, not by hand.
  assert.equal(
    rows.every((r) => r.kind === "topic"),
    true,
  );
});
