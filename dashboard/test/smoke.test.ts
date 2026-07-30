import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTestDb } from "./helpers.ts";

test("harness migrates a temp DB and loads the real queries layer", async () => {
  const dbPath = makeTestDb();
  assert.ok(dbPath.includes("ss-test-"), "must not be the real database");
  const q = await import("../lib/queries.ts");
  assert.deepEqual(q.getActiveChannels(), []);
});
