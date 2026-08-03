import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allOptionValues,
  createLibraryCheckboxFilterState,
  filterCheckboxOptions,
  libraryCheckboxFilterReducer,
  matchesLibraryCheckboxFilters,
} from "./library-checkbox-filters.ts";

const options = [
  { value: "football", label: "Football Season" },
  { value: "christmas", label: "Christmas" },
  { value: "spring", label: "Spring Training" },
];

test("option search is case-insensitive and does not mutate selections", () => {
  const selected = new Set(["christmas"]);
  assert.deepEqual(filterCheckboxOptions(options, "FOOT"), [options[0]]);
  assert.deepEqual([...selected], ["christmas"]);
});

test("Select all uses the complete option group even when search is narrowed", () => {
  assert.deepEqual([...allOptionValues(options)], ["football", "christmas", "spring"]);
  assert.deepEqual([...allOptionValues([])], []);
});

test("draft changes do not become applied until Apply", () => {
  const initial = createLibraryCheckboxFilterState();
  const drafted = libraryCheckboxFilterReducer(initial, {
    type: "set-draft",
    group: "tags",
    values: new Set(["tips", "promo"]),
  });

  assert.deepEqual([...drafted.draft.tags], ["tips", "promo"]);
  assert.equal(drafted.applied.tags.size, 0);

  const applied = libraryCheckboxFilterReducer(drafted, { type: "apply" });
  assert.deepEqual([...applied.applied.tags], ["tips", "promo"]);
  assert.notEqual(applied.applied.tags, applied.draft.tags, "Apply copies the Set");
});

test("Apply updates periods, tags, and platforms together", () => {
  let state = createLibraryCheckboxFilterState();
  state = libraryCheckboxFilterReducer(state, {
    type: "set-draft",
    group: "periods",
    values: new Set([10, 20]),
  });
  state = libraryCheckboxFilterReducer(state, {
    type: "set-draft",
    group: "tags",
    values: new Set(["tips"]),
  });
  state = libraryCheckboxFilterReducer(state, {
    type: "set-draft",
    group: "platforms",
    values: new Set(["instagram", "facebook"]),
  });
  state = libraryCheckboxFilterReducer(state, { type: "apply" });

  assert.deepEqual([...state.applied.periods], [10, 20]);
  assert.deepEqual([...state.applied.tags], ["tips"]);
  assert.deepEqual([...state.applied.platforms], ["instagram", "facebook"]);
});

test("matching is OR within a group and AND between groups", () => {
  const selected = {
    periods: new Set([10, 20]),
    tags: new Set(["tips", "promo"]),
    platforms: new Set(["instagram", "facebook"]),
  };

  assert.equal(
    matchesLibraryCheckboxFilters(
      { periods: [20], tags: ["tips"], platforms: ["facebook"] },
      selected,
    ),
    true,
  );
  assert.equal(
    matchesLibraryCheckboxFilters(
      { periods: [20], tags: ["other"], platforms: ["facebook"] },
      selected,
    ),
    false,
  );
  assert.equal(
    matchesLibraryCheckboxFilters(
      { periods: [99], tags: ["tips"], platforms: ["facebook"] },
      selected,
    ),
    false,
  );
});

test("empty applied groups impose no restriction", () => {
  const empty = createLibraryCheckboxFilterState().applied;
  assert.equal(
    matchesLibraryCheckboxFilters({ periods: [], tags: [], platforms: [] }, empty),
    true,
  );
});
