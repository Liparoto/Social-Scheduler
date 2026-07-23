"use client";

import { useState } from "react";
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
      ? "border-brand bg-brand-weak font-medium text-brand-ink"
      : "border-border text-muted hover:text-ink"
  }`;

export function TagEditor({
  timeOfDayTags,
  topicTags,
  value,
  onChange,
}: {
  timeOfDayTags: Tag[];
  topicTags: Tag[];
  value: number[];
  onChange: (ids: number[]) => void;
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
          {bands.map((t) => (
            <button key={t.id} type="button" className={chip(has(t.id))} onClick={() => toggle(t.id)}>
              {BAND_LABEL[t.name] ?? t.name}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-faint">
          Sets when auto-fill posts this. Anytime (or none) uses the channel's default time.
        </p>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-ink-soft">Topics</p>
        <div className="flex flex-wrap gap-2">
          {topics.map((t) => (
            <button key={t.id} type="button" className={chip(has(t.id))} onClick={() => toggle(t.id)}>
              {t.name}
            </button>
          ))}
        </div>
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
      </div>
    </div>
  );
}
