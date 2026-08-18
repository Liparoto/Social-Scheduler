import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "../test/helpers.ts";

// Regression: the Library and Compose both called listPosts() with no argument, and the
// default LIMIT silently truncated the list. On an install with 419 posts that hid 219 of
// them — including, because the order is created_at DESC, an entire second account's older
// back catalogue. Nothing in the UI said anything was missing.

async function setup() {
  makeTestDb();
  const q = await import("./queries.ts");
  const db = (await import("./db.ts")).getDb();
  return { q, db };
}

function seedPosts(db: ReturnType<typeof import("better-sqlite3")>, n: number): void {
  const insert = db.prepare(
    `INSERT INTO posts (caption, post_type, status, content_status, content_kind, created_at)
     VALUES (?, 'single', 'draft', 'draft', 'evergreen', ?)`,
  );
  const tx = db.transaction(() => {
    for (let i = 0; i < n; i++) {
      // Ascending timestamps so post 0 is the OLDEST — the one a DESC limit drops first.
      insert.run(`caption ${i}`, `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`);
    }
  });
  tx();
}

test("listPosts returns every post, not just the first 200", async () => {
  const { q, db } = await setup();
  seedPosts(db, 419);

  const posts = q.listPosts();

  assert.equal(posts.length, 419, "all 419 posts are visible to the Library");
});

test("listPosts keeps the OLDEST posts, which a silent cap dropped first", async () => {
  const { q, db } = await setup();
  seedPosts(db, 419);

  const captions = new Set(q.listPosts().map((p) => p.caption));

  assert.ok(captions.has("caption 0"), "the oldest post is still reachable");
});

test("listPosts still honours an explicit limit when a caller asks for one", async () => {
  const { q, db } = await setup();
  seedPosts(db, 419);

  assert.equal(q.listPosts(50).length, 50);
});
