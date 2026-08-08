import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  __resetPersistedToggleCacheForTests,
  readPersistedToggle,
  writePersistedToggle,
} from "./persisted-toggle.ts";

// node:test runs without a DOM, so stand up the smallest localStorage that satisfies the two
// calls this module makes.
function installStorage(initial: Record<string, string> = {}, throwOnAccess = false) {
  const store = new Map(Object.entries(initial));
  // defineProperty, not assignment: recent Node versions expose a built-in `localStorage`
  // global that can be non-writable, and a plain `globalThis.localStorage = …` throws there.
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: {
      getItem(k: string) {
        if (throwOnAccess) throw new Error("storage disabled");
        return store.has(k) ? store.get(k)! : null;
      },
      setItem(k: string, v: string) {
        if (throwOnAccess) throw new Error("storage disabled");
        store.set(k, v);
      },
    },
  });
  return store;
}

beforeEach(() => {
  __resetPersistedToggleCacheForTests();
});

test("returns the default when nothing is stored", () => {
  installStorage();
  assert.equal(readPersistedToggle("k", true), true);
  __resetPersistedToggleCacheForTests();
  assert.equal(readPersistedToggle("k", false), false);
});

test("round-trips a written value", () => {
  installStorage();
  writePersistedToggle("k", false);
  assert.equal(readPersistedToggle("k", true), false, "stored false must beat a true default");
  __resetPersistedToggleCacheForTests();
  writePersistedToggle("k", true);
  assert.equal(readPersistedToggle("k", false), true);
});

test("a corrupt stored value falls back to the default rather than reading as false", () => {
  // JSON.parse("banana") throws; a bare `=== "true"` check would silently return false and
  // quietly collapse a bar the user never collapsed.
  installStorage({ k: "banana" });
  assert.equal(readPersistedToggle("k", true), true);
});

test("a stored non-boolean is ignored", () => {
  installStorage({ k: '"yes"' });
  assert.equal(readPersistedToggle("k", true), true);
});

test("storage that throws degrades to the default instead of crashing the page", () => {
  installStorage({}, true);
  assert.equal(readPersistedToggle("k", true), true);
  assert.doesNotThrow(() => writePersistedToggle("k", false));
});

test("keys do not bleed into each other", () => {
  installStorage();
  writePersistedToggle("a", false);
  assert.equal(readPersistedToggle("a", true), false);
  assert.equal(readPersistedToggle("b", true), true);
});

test("the cache returns a STABLE value across reads", () => {
  // useSyncExternalStore re-renders forever if getSnapshot returns a fresh value each call.
  installStorage({ k: "false" });
  const first = readPersistedToggle("k", true);
  const second = readPersistedToggle("k", true);
  assert.equal(first, second);
  assert.equal(first, false);
});

test("a write is visible to a later read without clearing the cache", () => {
  // The toggle has to feel instant; if the write only reached storage and not the cache, the
  // bar would snap back to its old state on the very next render.
  installStorage();
  writePersistedToggle("k", false);
  assert.equal(readPersistedToggle("k", true), false);
});
