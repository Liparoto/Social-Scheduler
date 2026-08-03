import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CheckboxFilterDropdown,
  CheckboxFilterPanel,
} from "../components/checkbox-filter-dropdown.tsx";
import type { CheckboxFilterOption } from "../lib/library-checkbox-filters.ts";

const noop = () => {};
const periodOptions: CheckboxFilterOption<number>[] = [
  { value: 1, label: "Morning" },
  { value: 2, label: "Evening" },
];

test("closed trigger reports its selection count", () => {
  const html = renderToStaticMarkup(
    React.createElement(CheckboxFilterDropdown<number>, {
      label: "Periods",
      options: periodOptions,
      selected: new Set([1]),
      onChange: noop,
      closeSignal: 0,
    }),
  );

  assert.match(html, /aria-expanded="false"/);
  assert.match(html, />Periods · 1</);
});

test("panel renders search, group actions, options, and checked state", () => {
  const html = renderToStaticMarkup(
    React.createElement(CheckboxFilterPanel<number>, {
      label: "Periods",
      options: periodOptions,
      selected: new Set([1]),
      onChange: noop,
      query: "",
      onQueryChange: noop,
    }),
  );

  assert.match(html, /aria-label="Search Periods"/);
  assert.match(html, />Select all</);
  assert.match(html, />Clear all</);
  assert.match(html, /Morning/);
  assert.match(html, /Evening/);
  assert.match(html, /type="checkbox"[^>]*checked=""/);
});

test("opening panel marks its search field for focus", () => {
  const html = renderToStaticMarkup(
    React.createElement(CheckboxFilterPanel<number>, {
      label: "Periods",
      options: periodOptions,
      selected: new Set<number>(),
      onChange: noop,
      query: "",
      onQueryChange: noop,
      autoFocus: true,
    }),
  );

  assert.match(html, /type="search"[^>]*autofocus=""/);
});

test("panel reports no matches without rendering checkboxes", () => {
  const html = renderToStaticMarkup(
    React.createElement(CheckboxFilterPanel<number>, {
      label: "Periods",
      options: periodOptions,
      selected: new Set([1]),
      onChange: noop,
      query: "missing",
      onQueryChange: noop,
    }),
  );

  assert.match(html, /No matches/);
  assert.doesNotMatch(html, /type="checkbox"/);
});

test("empty group renders a disabled none-available trigger", () => {
  const html = renderToStaticMarkup(
    React.createElement(CheckboxFilterDropdown<string>, {
      label: "Tags",
      options: [],
      selected: new Set<string>(),
      onChange: noop,
      closeSignal: 0,
    }),
  );

  assert.match(html, /<button[^>]*disabled=""/);
  assert.match(html, />Tags — none available</);
});
