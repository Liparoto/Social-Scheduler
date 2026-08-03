export type CheckboxFilterValue = string | number;

export interface CheckboxFilterOption<T extends CheckboxFilterValue> {
  value: T;
  label: string;
}

export interface LibraryCheckboxSelections {
  periods: Set<number>;
  tags: Set<string>;
  platforms: Set<string>;
}

export interface LibraryCheckboxFilterState {
  draft: LibraryCheckboxSelections;
  applied: LibraryCheckboxSelections;
}

export type LibraryCheckboxGroup = keyof LibraryCheckboxSelections;

export type LibraryCheckboxFilterAction =
  | {
      type: "set-draft";
      group: "periods";
      values: Set<number>;
    }
  | {
      type: "set-draft";
      group: "tags" | "platforms";
      values: Set<string>;
    }
  | { type: "reconcile-available"; available: LibraryCheckboxSelections }
  | { type: "apply" };

function emptySelections(): LibraryCheckboxSelections {
  return { periods: new Set(), tags: new Set(), platforms: new Set() };
}

function copySelections(source: LibraryCheckboxSelections): LibraryCheckboxSelections {
  return {
    periods: new Set(source.periods),
    tags: new Set(source.tags),
    platforms: new Set(source.platforms),
  };
}

function intersectSelections(
  source: LibraryCheckboxSelections,
  available: LibraryCheckboxSelections,
): LibraryCheckboxSelections {
  return {
    periods: new Set([...source.periods].filter((value) => available.periods.has(value))),
    tags: new Set([...source.tags].filter((value) => available.tags.has(value))),
    platforms: new Set(
      [...source.platforms].filter((value) => available.platforms.has(value)),
    ),
  };
}

function selectionsEqual(
  left: LibraryCheckboxSelections,
  right: LibraryCheckboxSelections,
): boolean {
  return (
    left.periods.size === right.periods.size &&
    left.tags.size === right.tags.size &&
    left.platforms.size === right.platforms.size
  );
}

export function createLibraryCheckboxFilterState(): LibraryCheckboxFilterState {
  return { draft: emptySelections(), applied: emptySelections() };
}

export function libraryCheckboxFilterReducer(
  state: LibraryCheckboxFilterState,
  action: LibraryCheckboxFilterAction,
): LibraryCheckboxFilterState {
  if (action.type === "reconcile-available") {
    const draft = intersectSelections(state.draft, action.available);
    const applied = intersectSelections(state.applied, action.available);
    if (selectionsEqual(draft, state.draft) && selectionsEqual(applied, state.applied)) {
      return state;
    }
    return { draft, applied };
  }

  if (action.type === "apply") {
    return { draft: copySelections(state.draft), applied: copySelections(state.draft) };
  }

  if (action.group === "periods") {
    return {
      ...state,
      draft: { ...state.draft, periods: new Set(action.values) },
    };
  }

  return {
    ...state,
    draft: { ...state.draft, [action.group]: new Set(action.values) },
  };
}

export function filterCheckboxOptions<T extends CheckboxFilterValue>(
  options: CheckboxFilterOption<T>[],
  query: string,
): CheckboxFilterOption<T>[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return options;
  return options.filter((option) => option.label.toLocaleLowerCase().includes(normalized));
}

export function allOptionValues<T extends CheckboxFilterValue>(
  options: CheckboxFilterOption<T>[],
): Set<T> {
  return new Set(options.map((option) => option.value));
}

function matchesAny<T extends CheckboxFilterValue>(values: T[], selected: Set<T>): boolean {
  return selected.size === 0 || values.some((value) => selected.has(value));
}

export function matchesLibraryCheckboxFilters(
  post: { periods: number[]; tags: string[]; platforms: string[] },
  selected: LibraryCheckboxSelections,
): boolean {
  return (
    matchesAny(post.periods, selected.periods) &&
    matchesAny(post.tags, selected.tags) &&
    matchesAny(post.platforms, selected.platforms)
  );
}
