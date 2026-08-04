"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import {
  allOptionValues,
  filterCheckboxOptions,
  type CheckboxFilterOption,
  type CheckboxFilterValue,
} from "@/lib/library-checkbox-filters";

interface CheckboxFilterInputs<T extends CheckboxFilterValue> {
  label: string;
  options: CheckboxFilterOption<T>[];
  selected: Set<T>;
}

interface CheckboxFilterPanelProps<T extends CheckboxFilterValue>
  extends CheckboxFilterInputs<T> {
  onChange: (next: Set<T>) => void;
  onApply: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  autoFocus?: boolean;
  searchInputRef?: RefObject<HTMLInputElement | null>;
}

export function CheckboxFilterPanel<T extends CheckboxFilterValue>({
  label,
  options,
  selected,
  onChange,
  onApply,
  query,
  onQueryChange,
  autoFocus = false,
  searchInputRef,
}: CheckboxFilterPanelProps<T>) {
  const visibleOptions = filterCheckboxOptions(options, query);

  function toggle(value: T) {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  }

  return (
    <div
      role="dialog"
      aria-label={`${label} filters`}
      className="w-72 rounded-lg border border-border bg-surface p-3 shadow-lg"
    >
      <input
        ref={searchInputRef}
        type="search"
        autoFocus={autoFocus}
        aria-label={`Search ${label}`}
        placeholder={`Search ${label.toLocaleLowerCase()}…`}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-brand"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => onChange(allOptionValues(options))}
          className="text-xs font-medium text-brand-strong hover:text-brand"
        >
          Select all
        </button>
        <button
          type="button"
          onClick={() => onChange(new Set<T>())}
          className="text-xs font-medium text-muted hover:text-ink"
        >
          Clear all
        </button>
      </div>
      <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
        {visibleOptions.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-faint">No matches</p>
        ) : (
          visibleOptions.map((option) => (
            <label
              key={`${typeof option.value}:${option.value}`}
              className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-ink hover:bg-surface-sunken"
            >
              <input
                type="checkbox"
                checked={selected.has(option.value)}
                onChange={() => toggle(option.value)}
                className="h-4 w-4 rounded border-border accent-brand"
              />
              <span>{option.label}</span>
            </label>
          ))
        )}
      </div>
      <button
        type="button"
        onClick={onApply}
        className="mt-3 w-full rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-on-accent hover:bg-accent-ink"
      >
        Apply
      </button>
    </div>
  );
}

interface CheckboxFilterDropdownProps<T extends CheckboxFilterValue>
  extends CheckboxFilterInputs<T> {
  onApply: (next: Set<T>) => void;
}

export function CheckboxFilterDropdown<T extends CheckboxFilterValue>({
  label,
  options,
  selected,
  onApply,
}: CheckboxFilterDropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Set<T>>(() => new Set(selected));
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const disabled = options.length === 0;

  function discardAndClose() {
    setDraft(new Set(selected));
    setQuery("");
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;

    searchInputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    function discardLatestAndClose() {
      setDraft(new Set(selected));
      setQuery("");
      setOpen(false);
    }

    function closeOnOutsideMouseDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) discardLatestAndClose();
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      discardLatestAndClose();
      triggerRef.current?.focus();
    }

    document.addEventListener("mousedown", closeOnOutsideMouseDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideMouseDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, selected]);

  function toggleOpen() {
    if (open) {
      discardAndClose();
      return;
    }
    setDraft(new Set(selected));
    setQuery("");
    setOpen(true);
  }

  function applyDraft() {
    const available = allOptionValues(options);
    const sanitized = new Set([...draft].filter((value) => available.has(value)));
    onApply(sanitized);
    setDraft(sanitized);
    setQuery("");
    setOpen(false);
    triggerRef.current?.focus();
  }

  const triggerText = disabled
    ? `${label} — none available`
    : selected.size > 0
      ? `${label} · ${selected.size}`
      : label;

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={toggleOpen}
        className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink hover:bg-surface-sunken disabled:cursor-not-allowed disabled:text-faint disabled:opacity-60"
      >
        {triggerText}
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-30 mt-2">
          <CheckboxFilterPanel
            label={label}
            options={options}
            selected={draft}
            onChange={setDraft}
            onApply={applyDraft}
            query={query}
            onQueryChange={setQuery}
            autoFocus
            searchInputRef={searchInputRef}
          />
        </div>
      ) : null}
    </div>
  );
}
