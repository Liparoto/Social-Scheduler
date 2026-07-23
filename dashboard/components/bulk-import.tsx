"use client";

import { useState } from "react";
import Link from "next/link";
import type { Channel, ContentKind, ContentStatus, Period, PeriodMode, Tag } from "@/lib/types";
import { TagEditor } from "./tag-editor";
import { PeriodAttach } from "./period-attach";

type Item = { assetId: number; name: string; caption: string; deduped: boolean };

const card = "rounded-card border border-border bg-surface p-5";
const segBtn = (active: boolean) =>
  `rounded-md px-3 py-1.5 text-sm transition-colors ${
    active ? "bg-brand-weak font-medium text-brand-ink" : "text-muted hover:text-ink"
  }`;

export function BulkImport({
  channels,
  periods,
  timeOfDayTags,
  topicTags,
}: {
  channels: Channel[];
  periods: Period[];
  timeOfDayTags: Tag[];
  topicTags: Tag[];
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [uploading, setUploading] = useState(false);
  const [targets, setTargets] = useState<Set<number>>(new Set());
  const [kind, setKind] = useState<ContentKind>("evergreen");
  const [status, setStatus] = useState<ContentStatus>("draft");
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [periodModes, setPeriodModes] = useState<Record<number, PeriodMode>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<number | null>(null);

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);
    setNotice(null);
    setResult(null);
    setUploading(true);
    let dedup = 0;
    for (const file of Array.from(files)) {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/assets/upload", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.error ?? `Couldn't upload ${file.name}.`);
        continue;
      }
      if (body.deduped) dedup += 1;
      setItems((prev) => [
        ...prev,
        { assetId: body.asset.id, name: file.name, caption: "", deduped: body.deduped },
      ]);
    }
    if (dedup > 0) setNotice(`${dedup} image(s) already existed (matched by content) — reused.`);
    setUploading(false);
  }

  const setCaption = (i: number, caption: string) =>
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, caption } : it)));
  const removeItem = (i: number) => setItems((prev) => prev.filter((_, idx) => idx !== i));
  const toggleTarget = (id: number) =>
    setTargets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function create() {
    setError(null);
    setResult(null);
    setCreating(true);
    const res = await fetch("/api/posts/bulk-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: items.map((it) => ({ asset_id: it.assetId, caption: it.caption })),
        target_channel_ids: Array.from(targets),
        content_kind: kind,
        content_status: status,
        tag_ids: tagIds,
        period_links: Object.entries(periodModes).map(([pid, mode]) => ({
          periodId: Number(pid),
          mode,
        })),
      }),
    });
    setCreating(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Could not create drafts.");
      return;
    }
    const b = await res.json();
    setResult(b.created);
    setItems([]);
  }

  return (
    <div className="space-y-6">
      {/* Upload */}
      <section className={card}>
        <label className="inline-flex cursor-pointer items-center rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-ink">
          {uploading ? "Uploading…" : "Add images"}
          <input
            type="file"
            multiple
            accept="image/*"
            className="hidden"
            onChange={(e) => onFiles(e.target.files)}
          />
        </label>
        <p className="mt-2 text-xs text-muted">
          Each image becomes its own Draft. Dedup is by content — the same file won’t be stored twice.
        </p>
        {notice ? <p className="mt-2 text-xs text-status-posted">{notice}</p> : null}
      </section>

      {/* Grid of selected images */}
      {items.length > 0 ? (
        <section className={card}>
          <h3 className="mb-3 font-display text-sm font-semibold text-ink">
            {items.length} image{items.length === 1 ? "" : "s"} — add captions (optional)
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            {items.map((it, i) => (
              <div key={it.assetId} className="flex gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/media/${it.assetId}?variant=thumb`}
                  alt=""
                  className="h-20 w-20 shrink-0 rounded-lg object-cover"
                />
                <div className="flex-1">
                  <textarea
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-brand"
                    rows={2}
                    placeholder="Caption (optional)…"
                    value={it.caption}
                    onChange={(e) => setCaption(i, e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => removeItem(i)}
                    className="mt-1 text-xs text-muted hover:text-status-failed"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Batch defaults */}
      <section className={card}>
        <h3 className="mb-1 font-display text-sm font-semibold text-ink">Batch defaults</h3>
        <p className="mb-3 text-xs text-muted">Applied to every image in this batch. Refine each later in the Library.</p>

        <div className="mb-4">
          <p className="mb-2 text-xs font-medium text-ink-soft">Target accounts</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {channels.map((c) => {
              const on = targets.has(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleTarget(c.id)}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    on ? "border-brand bg-brand-weak" : "border-border hover:bg-surface-sunken"
                  }`}
                >
                  <span className="text-sm text-ink">{c.account_name}</span>
                  <span className="ml-auto text-xs text-muted">{c.platform}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="mb-4">
          <p className="mb-2 text-xs font-medium text-ink-soft">Kind</p>
          <div className="inline-flex rounded-lg border border-border p-0.5">
            <button type="button" className={segBtn(kind === "evergreen")} onClick={() => setKind("evergreen")}>Evergreen</button>
            <button type="button" className={segBtn(kind === "one_time")} onClick={() => setKind("one_time")}>One-time</button>
          </div>
        </div>

        <div className="mb-4">
          <p className="mb-2 text-xs font-medium text-ink-soft">Status</p>
          <div className="inline-flex rounded-lg border border-border p-0.5">
            <button type="button" className={segBtn(status === "draft")} onClick={() => setStatus("draft")}>Draft</button>
            <button type="button" className={segBtn(status === "ready")} onClick={() => setStatus("ready")}>Ready</button>
          </div>
          <p className="mt-1 text-xs text-faint">Ready content is eligible for auto-fill; drafts are not.</p>
        </div>

        <div className="mb-4">
          <p className="mb-2 text-xs font-medium text-ink-soft">Tags</p>
          <TagEditor timeOfDayTags={timeOfDayTags} topicTags={topicTags} value={tagIds} onChange={setTagIds} />
        </div>

        <PeriodAttach periods={periods} value={periodModes} onChange={setPeriodModes} />
      </section>

      {error ? <p className="text-sm text-status-failed">{error}</p> : null}
      {result !== null ? (
        <p className="text-sm text-status-posted">
          Created {result} draft{result === 1 ? "" : "s"}.{" "}
          <Link href="/library" className="underline underline-offset-2">View in Library →</Link>
        </p>
      ) : null}

      <div className="flex justify-end">
        <button
          onClick={create}
          disabled={creating || uploading || items.length === 0}
          className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-ink disabled:opacity-50"
        >
          {creating ? "Creating…" : `Create ${items.length} draft${items.length === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}
