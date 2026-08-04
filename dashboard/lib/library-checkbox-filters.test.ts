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

test("applying each group preserves the previously applied groups", () => {
  let state = createLibraryCheckboxFilterState();
  state = libraryCheckboxFilterReducer(state, {
    type: "apply-group",
    group: "periods",
    values: new Set([10, 20]),
  });
  state = libraryCheckboxFilterReducer(state, {
    type: "apply-group",
    group: "platforms",
    values: new Set(["instagram", "facebook"]),
  });
  state = libraryCheckboxFilterReducer(state, {
    type: "apply-group",
    group: "tags",
    values: new Set(["tips"]),
  });

  assert.deepEqual([...state.applied.periods], [10, 20]);
  assert.deepEqual([...state.applied.tags], ["tips"]);
  assert.deepEqual([...state.applied.platforms], ["instagram", "facebook"]);
});

test("applying an empty Tags group clears only Tags", () => {
  let state = createLibraryCheckboxFilterState();
  state = libraryCheckboxFilterReducer(state, {
    type: "apply-group",
    group: "periods",
    values: new Set([10]),
  });
  state = libraryCheckboxFilterReducer(state, {
    type: "apply-group",
    group: "tags",
    values: new Set(["tips"]),
  });
  state = libraryCheckboxFilterReducer(state, {
    type: "apply-group",
    group: "tags",
    values: new Set(),
  });

  assert.deepEqual([...state.applied.periods], [10]);
  assert.deepEqual([...state.applied.tags], []);
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

test("clearing applied groups restores checkbox-filtered posts while caption search remains active", () => {
  let state = createLibraryCheckboxFilterState();
  state = libraryCheckboxFilterReducer(state, {
    type: "apply-group",
    group: "tags",
    values: new Set(["tips"]),
  });

  assert.equal(
    matchesLibraryCheckboxFilters(
      { periods: [], tags: ["other"], platforms: [] },
      state.applied,
    ),
    false,
  );

  state = libraryCheckboxFilterReducer(state, {
    type: "apply-group",
    group: "periods",
    values: new Set(),
  });
  state = libraryCheckboxFilterReducer(state, {
    type: "apply-group",
    group: "tags",
    values: new Set(),
  });
  state = libraryCheckboxFilterReducer(state, {
    type: "apply-group",
    group: "platforms",
    values: new Set(),
  });

  const posts = [
    {
      caption: "Football tip",
      filters: { periods: [10], tags: ["other"], platforms: ["instagram"] },
    },
    {
      caption: "Holiday post",
      filters: { periods: [20], tags: ["promo"], platforms: ["facebook"] },
    },
  ];
  const query = "football";
  const shown = posts.filter(
    (post) =>
      matchesLibraryCheckboxFilters(post.filters, state.applied) &&
      post.caption.toLowerCase().includes(query),
  );

  assert.equal(shown.length, 1);
  assert.equal(shown[0]?.caption, "Football tip");
});

test("reconciling availability clears stale filters without dropping valid selections", () => {
  let state = createLibraryCheckboxFilterState();
  state = libraryCheckboxFilterReducer(state, {
    type: "apply-group",
    group: "periods",
    values: new Set([10]),
  });
  state = libraryCheckboxFilterReducer(state, {
    type: "apply-group",
    group: "tags",
    values: new Set(["tips"]),
  });
  state = libraryCheckboxFilterReducer(state, {
    type: "apply-group",
    group: "platforms",
    values: new Set(["instagram"]),
  });

  state = libraryCheckboxFilterReducer(state, {
    type: "reconcile-available",
    available: {
      periods: new Set(),
      tags: new Set(),
      platforms: new Set(["instagram"]),
    },
  });

  assert.deepEqual([...state.applied.periods], []);
  assert.deepEqual([...state.applied.tags], []);
  assert.deepEqual([...state.applied.platforms], ["instagram"]);
  assert.equal(
    matchesLibraryCheckboxFilters(
      { periods: [], tags: ["other"], platforms: ["instagram"] },
      state.applied,
    ),
    true,
  );
});
