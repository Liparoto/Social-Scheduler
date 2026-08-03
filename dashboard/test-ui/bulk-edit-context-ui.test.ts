import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TagEditor } from "../components/tag-editor.tsx";
import { PeriodAttach } from "../components/period-attach.tsx";
import { CurrentSelectionSummary } from "../components/bulk-edit-modal.tsx";
import {
  bulkContextLoadReducer,
  bulkReviewReady,
  type BulkEditContext,
} from "../lib/bulk-edit-context.ts";
import type { Period, Tag } from "../lib/types.ts";

const noop = () => {};

const tags: Tag[] = [
  { id: 1, name: "morning", kind: "time_of_day" },
  { id: 2, name: "Common", kind: "topic" },
  { id: 3, name: "Partial", kind: "topic" },
  { id: 4, name: "Absent", kind: "topic" },
];

const periods: Period[] = [
  {
    id: 10,
    name: "Spring",
    recurs_yearly: 1,
    start_month: 3,
    start_day: 1,
    end_month: 5,
    end_day: 31,
    start_date: null,
    end_date: null,
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: 11,
    name: "Summer",
    recurs_yearly: 1,
    start_month: 6,
    start_day: 1,
    end_month: 8,
    end_day: 31,
    start_date: null,
    end_date: null,
    created_at: "2026-01-01T00:00:00Z",
  },
];

const context: BulkEditContext = {
  post_count: 3,
  tags: [],
  periods: [],
  content_statuses: [
    { value: "ready", count: 2 },
    { value: "draft", count: 1 },
  ],
  content_kinds: [{ value: "evergreen", count: 3 }],
  cooldowns: [
    { value: null, count: 2 },
    { value: 1, count: 1 },
  ],
};

test("TagEditor keeps legacy rendering when coverage is omitted", () => {
  const html = renderToStaticMarkup(
    React.createElement(TagEditor, {
      timeOfDayTags: tags.filter((tag) => tag.kind === "time_of_day"),
      topicTags: tags.filter((tag) => tag.kind === "topic"),
      value: [],
      onChange: noop,
      allowCreateTopic: false,
    }),
  );

  for (const label of ["Morning", "Common", "Partial", "Absent"]) assert.match(html, new RegExp(label));
  assert.doesNotMatch(html, /All 3|1 of 3|None/);
});

test("TagEditor filters and sorts remove coverage and disables full add coverage", () => {
  const removeHtml = renderToStaticMarkup(
    React.createElement(TagEditor, {
      timeOfDayTags: [],
      topicTags: tags.slice(1),
      value: [],
      onChange: noop,
      allowCreateTopic: false,
      coverage: { 2: 3, 3: 1, 4: 0 },
      selectedPostCount: 3,
      hideZeroCoverage: true,
    }),
  );
  assert.ok(removeHtml.indexOf("Common") < removeHtml.indexOf("Partial"));
  assert.match(removeHtml, /All 3/);
  assert.match(removeHtml, /1 of 3/);
  assert.doesNotMatch(removeHtml, /Absent/);

  const addHtml = renderToStaticMarkup(
    React.createElement(TagEditor, {
      timeOfDayTags: [],
      topicTags: tags.slice(1),
      value: [],
      onChange: noop,
      allowCreateTopic: false,
      coverage: { 2: 3, 3: 1 },
      selectedPostCount: 3,
      disableFullCoverage: true,
    }),
  );
  assert.match(addHtml, /<button[^>]*disabled=""[^>]*>Common/);
  assert.doesNotMatch(addHtml, /<button[^>]*disabled=""[^>]*>Partial/);
});

test("PeriodAttach preserves legacy classes without coverage", () => {
  const html = renderToStaticMarkup(
    React.createElement(PeriodAttach, { periods: periods.slice(0, 1), value: {}, onChange: noop }),
  );

  assert.match(html, /flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2/);
  assert.match(html, /inline-flex shrink-0 rounded-lg border border-border p-0\.5/);
  assert.doesNotMatch(html, /All 3|1 of 3|None/);
});

test("PeriodAttach keeps exact coverage modes separate", () => {
  const removeHtml = renderToStaticMarkup(
    React.createElement(PeriodAttach, {
      periods,
      value: {},
      onChange: noop,
      coverage: { "10:green": 0, "10:blackout": 1, "11:green": 0, "11:blackout": 0 },
      selectedPostCount: 3,
      hideZeroCoverage: true,
    }),
  );
  assert.match(removeHtml, /Spring/);
  assert.doesNotMatch(removeHtml, /Summer/);
  assert.doesNotMatch(removeHtml, />Green</);
  assert.match(removeHtml, /Blackout.*1 of 3/);

  const addHtml = renderToStaticMarkup(
    React.createElement(PeriodAttach, {
      periods: periods.slice(0, 1),
      value: {},
      onChange: noop,
      coverage: { "10:green": 3, "10:blackout": 1 },
      selectedPostCount: 3,
      disableFullCoverage: true,
    }),
  );
  assert.match(addHtml, /<button[^>]*disabled=""[^>]*>Green/);
  assert.doesNotMatch(addHtml, /<button[^>]*disabled=""[^>]*>Blackout/);
});

test("current selection summary humanizes scalar values and coverage", () => {
  const html = renderToStaticMarkup(React.createElement(CurrentSelectionSummary, { context }));

  for (const label of ["Ready", "Draft", "Evergreen", "Channel default", "1 day"]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /All 3/);
  assert.match(html, /2 of 3/);
  assert.match(html, /1 of 3/);
});

test("context request start clears stale data and blocks review until a clean success", () => {
  const loaded = { context, loading: false, error: "stale error" };
  const started = bulkContextLoadReducer(loaded, { type: "start" });

  assert.deepEqual(started, { context: null, loading: true, error: null });
  assert.equal(bulkReviewReady(1, false, started), false);
  assert.equal(
    bulkReviewReady(1, false, bulkContextLoadReducer(started, { type: "success", context })),
    true,
  );
  assert.equal(bulkReviewReady(0, false, { context, loading: false, error: null }), false);
  assert.equal(bulkReviewReady(1, true, { context, loading: false, error: null }), false);
});
