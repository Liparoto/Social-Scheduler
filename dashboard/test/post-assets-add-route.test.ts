import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { makeTestDb } from "./helpers.ts";

makeTestDb();
const q = await import("../lib/queries.ts");
const db = (await import("../lib/db.ts")).getDb();
const route = await import("../app/api/posts/[id]/assets/route.ts");

let seq = 0;

function mkAsset(kind: "image" | "video" = "image"): number {
  const n = ++seq;
  return Number(
    db
      .prepare(
        "INSERT INTO assets (content_hash, media_kind, storage_path, width, height) VALUES (?, ?, ?, 1080, 1080)"
      )
      .run(`add-hash-${n}`, kind, `a/add/${n}.jpg`).lastInsertRowid
  );
}

function mkPost(assetIds: number[]): number {
  return q.createDraftPost({
    caption: "",
    first_comment: "",
    asset_ids: assetIds,
    post_type: assetIds.length > 1 ? "carousel" : "single",
  });
}

async function post(postId: number | string, body: unknown) {
  return route.POST(
    new NextRequest(`http://localhost:3939/api/posts/${postId}/assets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: String(postId) }) }
  );
}

test("adding a slide returns the new order and type", async () => {
  const first = mkAsset();
  const p = mkPost([first]);
  const extra = mkAsset();

  const res = await post(p, { asset_ids: [extra] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.asset_ids, [first, extra]);
  assert.equal(body.post_type, "carousel");
  assert.equal(q.getPost(p)!.post_type, "carousel");
});

test("an unknown post is a 404", async () => {
  const res = await post(999999, { asset_ids: [mkAsset()] });
  assert.equal(res.status, 404);
});

test("an unknown asset id is a 400 and adds nothing", async () => {
  const p = mkPost([mkAsset()]);
  const before = q.getPostSlides(p).length;
  const res = await post(p, { asset_ids: [999999] });
  assert.equal(res.status, 400);
  assert.equal(q.getPostSlides(p).length, before);
});

test("a malformed body is a 400", async () => {
  const p = mkPost([mkAsset()]);
  const res = await post(p, { asset_ids: "nope" });
  assert.equal(res.status, 400);
});

test("mixing a video into a carousel is refused", async () => {
  const p = mkPost([mkAsset(), mkAsset()]);
  const res = await post(p, { asset_ids: [mkAsset("video")] });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "video_mix");
  assert.equal(q.getPostSlides(p).length, 2);
});

test("a live send is a 409 and adds nothing", async () => {
  const p = mkPost([mkAsset()]);
  const channel = Number(
    db
      .prepare(
        "INSERT INTO channels (platform, account_name, remote_account_id, is_active) VALUES ('instagram', 'a', 'b', 1)"
      )
      .run().lastInsertRowid
  );
  db.prepare(
    "INSERT INTO publications (post_id, channel_id, scheduled_at, status) VALUES (?, ?, '2026-01-01T00:00:00Z', 'posted')"
  ).run(p, channel);

  const res = await post(p, { asset_ids: [mkAsset()] });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "live_send");
  assert.equal(q.getPostSlides(p).length, 1);
});

/** An IG Story send is fanned out one publications row per slide, at scheduling time. */
function mkChannel(name: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO channels (platform, account_name, remote_account_id, is_active) VALUES ('instagram', ?, ?, 1)"
      )
      .run(name, `remote-${name}`).lastInsertRowid
  );
}

test("a post with a queued Story send refuses a new slide, and adds nothing", async () => {
  // The mirror of the rule the remove route enforces. The Story fan-out happens once, at
  // scheduling time, and nothing resyncs it — so a slide added now would get no
  // publications row and silently never post as a Story, while the queue rendered it as
  // "Story 3 of 3" (story_slide_no is computed live from post_assets).
  const a = mkAsset();
  const b = mkAsset();
  const p = mkPost([a, b]);
  const channel = mkChannel("story-add");
  for (const slide of [a, b]) {
    db.prepare(
      `INSERT INTO publications (post_id, channel_id, scheduled_at, status, surface, asset_id)
       VALUES (?, ?, '2026-01-01T00:00:00Z', 'scheduled', 'story', ?)`
    ).run(p, channel, slide);
  }

  const res = await post(p, { asset_ids: [mkAsset()] });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "story_queued");
  assert.match(body.error, /Cancel or hold/);
  assert.deepEqual(q.getPostSlides(p).map((s) => s.asset_id), [a, b], "nothing was added");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM publications WHERE post_id = ?").get(p) as {
      n: number;
    }).n,
    2,
    "and no publication was created behind the owner's back"
  );
});

test("a queued FEED send does NOT block adding a slide", async () => {
  // asset_id IS NULL: a feed send publishes whatever slides the post holds at publish
  // time, so picking up the new slide is exactly the intended behaviour. Blocking here
  // would be a regression, not a safety check.
  const a = mkAsset();
  const p = mkPost([a]);
  db.prepare(
    `INSERT INTO publications (post_id, channel_id, scheduled_at, status)
     VALUES (?, ?, '2026-01-01T00:00:00Z', 'scheduled')`
  ).run(p, mkChannel("feed-add"));

  const extra = mkAsset();
  const res = await post(p, { asset_ids: [extra] });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).asset_ids, [a, extra]);
});

test("a text-only post cannot be turned into a media post", async () => {
  const p = q.createDraftPost({
    caption: "just words",
    first_comment: "",
    asset_ids: [],
    post_type: "text",
  });
  const res = await post(p, { asset_ids: [mkAsset()] });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "text_post");
  assert.equal(q.getPostSlides(p).length, 0);
  assert.equal(q.getPost(p)!.post_type, "text", "the post type must not be rewritten");
});

// ---- GET /api/posts/[id]/assets/can-add: the pre-flight -------------------------------
// Why it exists: uploading a file writes the original, a conformed derivative and a
// thumbnail into /data BEFORE POST .../assets is ever called. Without a question that can
// be asked first, every refused attempt on a live/Story-queued/text post left another
// orphaned copy in the library.

const canAddRoute = await import("../app/api/posts/[id]/assets/can-add/route.ts");

async function canAdd(postId: number | string) {
  return canAddRoute.GET(
    new NextRequest(`http://localhost:3939/api/posts/${postId}/assets/can-add`),
    { params: Promise.resolve({ id: String(postId) }) }
  );
}

test("can-add says yes for an ordinary post", async () => {
  const res = await canAdd(mkPost([mkAsset()]));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("can-add reports a live send as a 200 'no', with the same sentence POST would give", async () => {
  const a = mkAsset();
  const p = mkPost([a]);
  db.prepare(
    `INSERT INTO publications (post_id, channel_id, scheduled_at, status)
     VALUES (?, ?, '2026-01-01T00:00:00Z', 'posted')`
  ).run(p, mkChannel("live-canadd"));

  const res = await canAdd(p);
  // A 200: the question was answered successfully — the answer is just "no".
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "live_send");

  const posted = await post(p, { asset_ids: [mkAsset()] });
  assert.equal(posted.status, 409);
  assert.equal(body.error, (await posted.json()).error, "the two layers word it differently");
});

test("can-add reports a queued Story send, matching POST", async () => {
  const a = mkAsset();
  const b = mkAsset();
  const p = mkPost([a, b]);
  const channel = mkChannel("story-canadd");
  for (const slide of [a, b]) {
    db.prepare(
      `INSERT INTO publications (post_id, channel_id, scheduled_at, status, surface, asset_id)
       VALUES (?, ?, '2026-01-01T00:00:00Z', 'scheduled', 'story', ?)`
    ).run(p, channel, slide);
  }

  const body = await (await canAdd(p)).json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "story_queued");
  assert.equal(body.error, (await (await post(p, { asset_ids: [mkAsset()] })).json()).error);
});

test("can-add reports a text post, matching POST", async () => {
  const p = q.createDraftPost({
    caption: "just words",
    first_comment: "",
    asset_ids: [],
    post_type: "text",
  });
  const body = await (await canAdd(p)).json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "text_post");
  assert.equal(body.error, (await (await post(p, { asset_ids: [mkAsset()] })).json()).error);
});

// A queued FEED send publishes whatever slides exist at publish time, so it must not stop
// an upload before it starts — the pre-flight has to agree with POST here too.
test("can-add lets a queued feed send through", async () => {
  const p = mkPost([mkAsset()]);
  db.prepare(
    `INSERT INTO publications (post_id, channel_id, scheduled_at, status)
     VALUES (?, ?, '2026-01-01T00:00:00Z', 'scheduled')`
  ).run(p, mkChannel("feed-canadd"));
  assert.deepEqual(await (await canAdd(p)).json(), { ok: true });
});

test("can-add on an unknown post is a 404", async () => {
  const res = await canAdd(999999);
  assert.equal(res.status, 404);
});

// The pre-flight must not answer a question it cannot see the asset for: a post already
// holding a video only refuses once you know what is being added.
test("can-add says yes for a Reel — video mixing is still POST's call", async () => {
  const p = mkPost([mkAsset("video")]);
  assert.deepEqual(await (await canAdd(p)).json(), { ok: true });
  const res = await post(p, { asset_ids: [mkAsset()] });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "video_mix");
});
