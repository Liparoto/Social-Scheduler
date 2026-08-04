import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAssetOrder } from "./asset-order.ts";

test("a genuine reordering is accepted and returned", () => {
  const res = checkAssetOrder([7, 8, 9], [9, 7, 8]);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.deepEqual(res.asset_ids, [9, 7, 8]);
});

test("the unchanged order is accepted — saving a no-op is not an error", () => {
  assert.equal(checkAssetOrder([7, 8, 9], [7, 8, 9]).ok, true);
});

// THE invariant from spec §3: anything that changes the slide COUNT would change what
// post_type has to be, and post_type is frozen. All four of these must be refused.
test("a dropped slide is refused", () => {
  const res = checkAssetOrder([7, 8, 9], [7, 8]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "not_a_permutation");
});

test("an added slide is refused", () => {
  const res = checkAssetOrder([7, 8, 9], [7, 8, 9, 10]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "not_a_permutation");
});

test("a duplicated slide is refused even though the length matches", () => {
  const res = checkAssetOrder([7, 8, 9], [7, 7, 8]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "not_a_permutation");
});

test("a foreign asset id is refused even though the length matches", () => {
  const res = checkAssetOrder([7, 8, 9], [7, 8, 99]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.code, "not_a_permutation");
});

test("non-arrays, empties, and non-integers are refused with their own codes", () => {
  for (const [proposed, code] of [
    [undefined, "not_an_array"],
    [null, "not_an_array"],
    ["7,8,9", "not_an_array"],
    [{ 0: 7 }, "not_an_array"],
    [[], "empty"],
    [[7, 8, "9"], "not_integers"],
    [[7, 8, 9.5], "not_integers"],
    [[7, 8, NaN], "not_integers"],
  ] as const) {
    const res = checkAssetOrder([7, 8, 9], proposed);
    assert.equal(res.ok, false, `${JSON.stringify(proposed)} should be refused`);
    if (res.ok) return;
    assert.equal(res.code, code);
  }
});

test("every refusal carries a message fit to show a person", () => {
  const res = checkAssetOrder([7, 8, 9], [7, 8]);
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.match(res.error, /\w+ \w+/);
});
