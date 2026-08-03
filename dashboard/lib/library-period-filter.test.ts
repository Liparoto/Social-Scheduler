import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesPeriodFilter } from "./library-period-filter.ts";

type TestPost = {
  id: number;
  tag: string;
  periods: { id: number; mode: "green" | "blackout" }[];
};

const posts: TestPost[] = [
  { id: 1, tag: "tips", periods: [{ id: 10, mode: "green" }] },
  { id: 2, tag: "promo", periods: [{ id: 20, mode: "green" }] },
  { id: 3, tag: "tips", periods: [{ id: 10, mode: "blackout" }] },
  { id: 4, tag: "tips", periods: [] },
];

function idsFor(periodIds: number[], otherPredicate: (post: TestPost) => boolean = () => true) {
  const selected = new Set(periodIds);
  return posts
    .filter((post) => matchesPeriodFilter(post.periods, selected) && otherPredicate(post))
    .map((post) => post.id);
}

test("an empty period selection matches every post", () => {
  assert.deepEqual(idsFor([]), [1, 2, 3, 4]);
});

test("one selected period matches posts carrying that period", () => {
  assert.deepEqual(idsFor([20]), [2]);
});

test("multiple selected periods form a union", () => {
  assert.deepEqual(idsFor([10, 20]), [1, 2, 3]);
});

test("blackout links count as carrying a selected period", () => {
  assert.deepEqual(idsFor([10]), [1, 3]);
});

test("the period predicate composes with another predicate using AND", () => {
  assert.deepEqual(idsFor([10, 20], (post) => post.tag === "promo"), [2]);
});
