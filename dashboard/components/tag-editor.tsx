"use client";

import { useState } from "react";
import {
  coverageLabel,
  coverageState,
  removableIds,
  type CoverageState,
} from "@/lib/bulk-edit-context";
import type { Tag } from "@/lib/types";

const BAND_LABEL: Record<string, string> = {
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
  anytime: "Anytime",
};

const chip = (active: boolean) =>
  `rounded-full border px-3 py-1 text-sm transition-colors ${
    active
      ? "border-brand bg-brand-weak font-medium text-brand-strong"
      : "border-border text-muted hover:text-ink"
  }`;

const coverageBadgeClass: Record<CoverageState, string> = {
  all: "border border-status-posted/30 bg-status-posted/15 text-status-posted",
  some: "border border-amber-300 bg-amber-100 text-amber-800",
  none: "border border-border bg-surface-sunken text-faint",
};

export function TagEditor({
  timeOfDayTags,
  topicTags,
  value,
  onChange,
  allowCreateTopic = true,
  coverage,
  selectedPostCount = 0,
  hideZeroCoverage = false,
  disableFullCoverage = false,
  emptyCoverageMessage = "No matching tags.",
}: {
  timeOfDayTags: Tag[];
  topicTags: Tag[];
  value: number[];
  onChange: (ids: number[]) => void;
  allowCreateTopic?: boolean;
  coverage?: Record<number, number>;
  selectedPostCount?: number;
  hideZeroCoverage?: boolean;
  disableFullCoverage?: boolean;
  emptyCoverageMessage?: string;
}) {
  const [topics, setTopics] = useState<Tag[]>(topicTags);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const has = (id: number) => value.includes(id);
  const toggle = (id: number) =>
    onChange(has(id) ? value.filter((x) => x !== id) : [...value, id]);

  // Order the band chips morning -> afternoon -> evening -> anytime.
  const bandOrder = ["morning", "afternoon", "evening", "anytime"];
  const bands = [...timeOfDayTags].sort(
    (a, b) => bandOrder.indexOf(a.name) - bandOrder.indexOf(b.name)
  );

  function visibleTags(tags: Tag[]): Tag[] {
    if (!coverage || !hideZeroCoverage) return tags;
    const byId = new Map(tags.map((tag) => [tag.id, tag]));
    return removableIds(
      tags.map((tag) => tag.id),
      coverage,
      selectedPostCount,
    ).map((id) => byId.get(id)!);
  }

  const visibleBands = visibleTags(bands);
  const visibleTopics = visibleTags(topics);

  function coverageBadge(id: number) {
    if (!coverage) return null;
    const count = coverage[id] ?? 0;
    const state = coverageState(count, selectedPostCount);
    return (
      <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] ${coverageBadgeClass[state]}`}>
        {coverageLabel(count, selectedPostCount)}
      </span>
    );
  }

  function isDisabled(id: number): boolean {
    return Boolean(
      coverage &&
        disableFullCoverage &&
        coverageState(coverage[id] ?? 0, selectedPostCount) === "all",
    );
  }

  async function addTopic() {
    const name = draft.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        const tag: Tag = await res.json();
        if (!topics.some((t) => t.id === tag.id)) setTopics((p) => [...p, tag]);
        if (!has(tag.id)) onChange([...value, tag.id]);
        setDraft("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-xs font-medium text-ink-soft">Time of day</p>
        <div className="flex flex-wrap gap-2">
          {visibleBands.map((t) => (
            <button key={t.id} type="button" className={`${chip(has(t.id))} disabled:cursor-not-allowed disabled:opacity-60`} onClick={() => toggle(t.id)} disabled={isDisabled(t.id)}>
              {BAND_LABEL[t.name] ?? t.name}
              {coverageBadge(t.id)}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-faint">
          Sets when auto-fill posts this. Anytime (or none) uses the channel&apos;s default time.
        </p>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-ink-soft">Topics</p>
        <div className="flex flex-wrap gap-2">
          {visibleTopics.map((t) => (
            <button key={t.id} type="button" className={`${chip(has(t.id))} disabled:cursor-not-allowed disabled:opacity-60`} onClick={() => toggle(t.id)} disabled={isDisabled(t.id)}>
              {t.name}
              {coverageBadge(t.id)}
            </button>
          ))}
        </div>
        {allowCreateTopic ? (
          <div className="mt-2 flex gap-2">
            <input
              className="w-48 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-faint focus:border-brand"
              placeholder="Add a topic…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTopic();
                }
              }}
            />
            <button
              type="button"
              onClick={addTopic}
              disabled={busy || !draft.trim()}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-ink-soft hover:bg-surface-sunken disabled:opacity-50"
            >
              Add
            </button>
          </div>
        ) : null}
      </div>
      {coverage && visibleBands.length === 0 && visibleTopics.length === 0 ? (
        <p className="text-xs text-faint">{emptyCoverageMessage}</p>
      ) : null}
    </div>
  );
}
