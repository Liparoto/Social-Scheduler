"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { channelColor, formatInTz, videoPreviewSrc } from "@/lib/format";
import { PLATFORMS, incompatibleChannelsForPostType, platformLabel } from "@/lib/platforms";

interface PostLite {
  id: number;
  caption: string | null;
  post_type: string;
  status: string;
  first_asset_id: number | null;
  asset_count: number;
  scheduled_count: number;
  posted_count: number;
  last_posted_at: string | null;
  content_kind: "one_time" | "evergreen";
  content_status: "draft" | "ready" | "retired";
  target_count: number;
  green_period_count: number;
  blackout_period_count: number;
  time_of_day_tags: string | null;
  topic_tags: string | null;
  target_platforms: string | null;
}
interface ChannelLite {
  id: number;
  account_name: string;
  platform: string;
  timezone: string;
  requires_approval: boolean;
  color_hue: number | null;
}

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function LibraryView({
  posts,
  channels,
}: {
  posts: PostLite[];
  channels: ChannelLite[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<number[]>([]); // ordered = post order
  const [chans, setChans] = useState<Set<number>>(new Set());
  const [everyDays, setEveryDays] = useState(2);
  const [time, setTime] = useState("18:00");
  const [startDate, setStartDate] = useState(tomorrow());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startT] = useTransition();
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [platformFilter, setPlatformFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "ready" | "retired">("all");
  const [kindFilter, setKindFilter] = useState<"all" | "evergreen" | "one_time">("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"newest" | "recent" | "stale">("newest");

  function toggle(id: number) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }
  function toggleChan(id: number) {
    setChans((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function schedule() {
    setError(null);
    setNotice(null);
    if (selected.length === 0) return setError("Select at least one post.");
    if (effectiveChans.size === 0) return setError("Select at least one channel.");
    const res = await fetch("/api/posts/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        post_ids: selected,
        channel_ids: Array.from(effectiveChans),
        every_days: everyDays,
        time,
        start_date: startDate,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error ?? "Could not bulk-schedule.");
      return;
    }
    setNotice(`Scheduled ${body.created} publication${body.created === 1 ? "" : "s"}.`);
    setSelected([]);
    setChans(new Set());
    startT(() => router.refresh());
  }

  async function retarget(action: "add" | "remove") {
    setError(null);
    setNotice(null);
    if (selected.length === 0) return setError("Select at least one post.");
    if (effectiveChans.size === 0) return setError("Select at least one channel.");
    const res = await fetch("/api/posts/targets/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        post_ids: selected,
        channel_ids: Array.from(effectiveChans),
        action,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(body.error ?? "Could not update targets.");
      return;
    }
    const verb = action === "add" ? "Added" : "Removed";
    const prep = action === "add" ? "to" : "from";
    setNotice(
      `${verb} ${effectiveChans.size} account${effectiveChans.size === 1 ? "" : "s"} ${prep} ${
        selected.length
      } post${selected.length === 1 ? "" : "s"}.`
    );
    setSelected([]);
    startT(() => router.refresh());
  }

  const field =
    "rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand";

  const splitTags = (s: string | null) => (s ? s.split(",") : []);
  const allTagNames = Array.from(
    new Set(posts.flatMap((p) => [...splitTags(p.time_of_day_tags), ...splitTags(p.topic_tags)]))
  ).sort();

  const q = search.trim().toLowerCase();
  const shown = posts.filter((p) => {
    if (tagFilter) {
      const names = [...splitTags(p.time_of_day_tags), ...splitTags(p.topic_tags)];
      if (!names.includes(tagFilter)) return false;
    }
    if (platformFilter) {
      if (!splitTags(p.target_platforms).includes(platformFilter)) return false;
    }
    if (statusFilter !== "all" && p.content_status !== statusFilter) return false;
    if (kindFilter !== "all" && p.content_kind !== kindFilter) return false;
    if (q && !(p.caption ?? "").toLowerCase().includes(q)) return false;
    return true;
  });

  // Channels that can't publish at least one of the currently-selected posts' type —
  // disabled in the "To channels" picker below rather than offered and rejected later.
  const selectedPostObjs = posts.filter((p) => selected.includes(p.id));
  const incompatibleChannelIds = new Set(
    selectedPostObjs.flatMap((p) => incompatibleChannelsForPostType(p.post_type, channels).map((c) => c.id))
  );
  // Derived, not written back into `chans` state: changing the post selection (e.g.
  // adding a Threads text post to a selection that had an Instagram channel picked) can
  // make an already-picked channel incompatible. Deriving this instead of syncing it
  // back with a nested setChans-inside-setSelected keeps there nothing to keep in sync —
  // matching the pattern already used in schedule-from-library.tsx's effectiveTargets.
  const effectiveChans = useMemo(
    () => new Set([...chans].filter((id) => !incompatibleChannelIds.has(id))),
    [chans, incompatibleChannelIds]
  );

  const sorted = [...shown].sort((a, b) => {
    if (sort === "newest") return b.id - a.id;
    const av = a.last_posted_at;
    const bv = b.last_posted_at;
    if (av === null && bv === null) return b.id - a.id;
    if (av === null) return 1; // never-posted always last
    if (bv === null) return -1;
    return sort === "recent" ? bv.localeCompare(av) : av.localeCompare(bv);
  });

  return (
    <div className="space-y-5">
      {/* Summary: whole-library makeup */}
      <div className="data flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
        <span><span className="text-status-posted">{posts.filter((p) => p.content_status === "ready").length}</span> Ready</span>
        <span><span className="text-ink-soft">{posts.filter((p) => p.content_status === "draft").length}</span> Draft</span>
        <span><span className="text-faint">{posts.filter((p) => p.content_status === "retired").length}</span> Retired</span>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <span>{posts.filter((p) => p.content_kind === "evergreen").length} Evergreen</span>
        <span>{posts.filter((p) => p.content_kind === "one_time").length} One-time</span>
        <span className="ml-auto">{posts.length} total</span>
      </div>

      {/* Controls: status / kind / search / sort */}
      <div className="flex flex-wrap items-center gap-2">
        <select className={field} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
          <option value="all">All statuses</option>
          <option value="draft">Draft</option>
          <option value="ready">Ready</option>
          <option value="retired">Retired</option>
        </select>
        <select className={field} value={kindFilter} onChange={(e) => setKindFilter(e.target.value as typeof kindFilter)}>
          <option value="all">All kinds</option>
          <option value="evergreen">Evergreen</option>
          <option value="one_time">One-time</option>
        </select>
        <input
          className={`${field} min-w-48 flex-1`}
          placeholder="Search captions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className={field} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="newest">Newest</option>
          <option value="recent">Recently posted</option>
          <option value="stale">Least recently posted</option>
        </select>
        <span className="data text-[11px] text-muted">showing {shown.length} of {posts.length}</span>
      </div>

      {/* Filter bar */}
      {allTagNames.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-soft">Filter:</span>
          {allTagNames.map((name) => {
            const on = tagFilter === name;
            return (
              <button
                key={name}
                onClick={() => setTagFilter(on ? null : name)}
                className={`data rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  on
                    ? "border-brand bg-brand/10 text-brand-strong"
                    : "border-border bg-surface text-muted hover:bg-surface-sunken"
                }`}
              >
                {name}
              </button>
            );
          })}
          <span className="mx-1 h-4 w-px bg-border" />
          {PLATFORMS.map((p) => {
            const on = platformFilter === p.value;
            return (
              <button
                key={p.value}
                onClick={() => setPlatformFilter(on ? null : p.value)}
                className={`data rounded-full border px-2.5 py-1 text-[11px] font-medium capitalize transition-colors ${
                  on
                    ? "border-brand bg-brand/10 text-brand-strong"
                    : "border-border bg-surface text-muted hover:bg-surface-sunken"
                }`}
              >
                {p.value}
              </button>
            );
          })}
          {tagFilter || platformFilter ? (
            <button
              onClick={() => {
                setTagFilter(null);
                setPlatformFilter(null);
              }}
              className="text-[11px] text-faint underline underline-offset-2"
            >
              Clear
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Post grid */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sorted.map((p) => {
          const on = selected.includes(p.id);
          const order = selected.indexOf(p.id) + 1;
          return (
            <div
              key={p.id}
              role="button"
              tabIndex={0}
              onClick={() => toggle(p.id)}
              onKeyDown={(e) => {
                // Let keyboard activation of the nested title/thumbnail link navigate
                // without also toggling selection (stopPropagation on the link guards
                // click, not the bubbling keydown).
                if ((e.target as HTMLElement).closest("a")) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle(p.id);
                }
              }}
              className={`flex cursor-pointer gap-3 rounded-card border bg-surface p-3 text-left transition-colors ${
                on ? "border-brand" : "border-border hover:bg-surface-sunken"
              }`}
            >
              <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md border border-border bg-surface-sunken">
                <Link
                  href={`/library/${p.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="hover:underline"
                >
                  {p.first_asset_id ? (
                    p.post_type === "reel" ? (
                      // No thumbnail file exists for video (no ffmpeg dependency by
                      // design) — render the real file with preload="metadata" so the
                      // browser decodes just the first frame, same approach as
                      // post-editor.tsx / cover-frame-picker.tsx. The #t= fragment
                      // (videoPreviewSrc) is what actually makes that frame paint in
                      // Safari; this list doesn't load cover_frame_ms (would need a new
                      // query), so it always uses the small non-zero fallback offset.
                      <video
                        src={videoPreviewSrc(p.first_asset_id)}
                        preload="metadata"
                        muted
                        playsInline
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/media/${p.first_asset_id}?variant=thumb`}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    )
                  ) : p.post_type === "text" ? (
                    <div className="flex h-full w-full items-center justify-center text-center text-[10px] text-faint">
                      Text post
                    </div>
                  ) : null}
                </Link>
                {on ? (
                  <span className="data absolute inset-0 flex items-center justify-center bg-brand/70 text-sm font-semibold text-white">
                    {order}
                  </span>
                ) : null}
              </div>
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-sm text-ink">
                  <Link
                    href={`/library/${p.id}`}
                    onClick={(e) => e.stopPropagation()}
                    className="hover:underline"
                  >
                    {p.caption || <span className="text-faint italic">No caption</span>}
                  </Link>
                </p>
                <div className="data mt-1 flex flex-wrap gap-x-2 text-[10px] text-faint">
                  <span>{p.post_type}</span>
                  {p.asset_count > 1 ? <span>{p.asset_count} imgs</span> : null}
                  {p.posted_count > 0 ? (
                    <span className="text-status-posted">posted×{p.posted_count}</span>
                  ) : (
                    <span>never posted</span>
                  )}
                  {p.scheduled_count > 0 ? (
                    <span className="text-status-scheduled">queued×{p.scheduled_count}</span>
                  ) : null}
                </div>
                <div className="data mt-1 flex flex-wrap gap-x-2 text-[10px] text-faint">
                  <span>{p.content_kind === "evergreen" ? "Evergreen" : "One-time"}</span>
                  <span
                    className={
                      p.content_status === "ready"
                        ? "text-status-posted"
                        : p.content_status === "draft"
                          ? "text-muted"
                          : "text-faint"
                    }
                  >
                    {p.content_status === "ready"
                      ? "Ready"
                      : p.content_status === "draft"
                        ? "Draft"
                        : "Retired"}
                  </span>
                  <span>
                    {p.target_count > 0 ? `→ ${p.target_count} account(s)` : "no targets"}
                  </span>
                  {p.green_period_count > 0 ? <span>green ×{p.green_period_count}</span> : null}
                  {p.blackout_period_count > 0 ? (
                    <span>blackout ×{p.blackout_period_count}</span>
                  ) : null}
                </div>
                {[...splitTags(p.time_of_day_tags), ...splitTags(p.topic_tags)].length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {[...splitTags(p.time_of_day_tags), ...splitTags(p.topic_tags)].map((name) => (
                      <span
                        key={name}
                        className="data rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] text-muted"
                      >
                        {name}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {/* Bulk schedule bar */}
      <div className="sticky bottom-4 rounded-card border border-border-strong bg-surface p-4 shadow-lg">
        <div className="flex flex-wrap items-end gap-4">
          <div className="text-sm">
            <span className="data text-lg font-semibold text-ink">{selected.length}</span>
            <span className="text-muted"> post{selected.length === 1 ? "" : "s"} selected</span>
          </div>
          <div className="h-8 w-px bg-border" />
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-ink-soft">
              <span className="mb-1 block">Every</span>
              <input
                type="number"
                min={1}
                value={everyDays}
                onChange={(e) => setEveryDays(Number(e.target.value))}
                className={`${field} w-16`}
              />
            </label>
            <span className="pb-2 text-sm text-muted">days at</span>
            <label className="text-xs text-ink-soft">
              <span className="mb-1 block">Time</span>
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className={field}
              />
            </label>
            <label className="text-xs text-ink-soft">
              <span className="mb-1 block">Starting</span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className={field}
              />
            </label>
          </div>
        </div>

        <div className="mt-3">
          <p className="mb-1.5 text-xs text-ink-soft">To channels:</p>
          <div className="flex flex-wrap gap-2">
            {channels.map((c) => {
              const on = effectiveChans.has(c.id);
              const disabled = incompatibleChannelIds.has(c.id);
              const color = channelColor(c.id, c.color_hue);
              return (
                <button
                  key={c.id}
                  onClick={() => !disabled && toggleChan(c.id)}
                  disabled={disabled}
                  title={disabled ? `${platformLabel(c.platform)} can't publish one or more selected posts` : undefined}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${
                    disabled ? "cursor-not-allowed opacity-40" : ""
                  }`}
                  style={
                    on && !disabled
                      ? { color: color.fg, backgroundColor: color.bg, borderColor: color.dot }
                      : { borderColor: "var(--color-border)", color: "var(--color-muted)" }
                  }
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: on && !disabled ? color.dot : "var(--color-faint)" }}
                  />
                  {c.account_name}
                  {disabled ? " — can't post this type" : ""}
                </button>
              );
            })}
          </div>
        </div>

        {error ? <p className="mt-3 text-sm text-status-failed">{error}</p> : null}
        {notice ? <p className="mt-3 text-sm text-brand-strong">{notice}</p> : null}

        <div className="mt-3 flex items-center justify-between gap-4">
          <p className="text-[11px] text-faint">
            {selected.length > 0 && effectiveChans.size > 0
              ? `${selected.length} post(s) × ${effectiveChans.size} channel(s), one every ${everyDays} day(s) from ${formatInTz(
                  `${startDate}T${time}:00Z`,
                  "UTC",
                  { month: "short", day: "numeric" }
                )}.`
              : "Select posts and channels to bulk-schedule."}
          </p>
          <button
            onClick={schedule}
            disabled={pending}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-on-accent hover:bg-accent-ink disabled:opacity-50"
          >
            {pending ? "Scheduling…" : "Bulk schedule"}
          </button>
        </div>

        <div className="mt-3 border-t border-border pt-3">
          <p className="mb-1.5 text-[11px] text-faint">
            Targeting controls which accounts auto-fill can post a piece of content to.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => retarget("add")}
              disabled={pending || selected.length === 0 || effectiveChans.size === 0}
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-sunken disabled:opacity-50"
            >
              Add as target
            </button>
            <button
              onClick={() => retarget("remove")}
              disabled={pending || selected.length === 0 || effectiveChans.size === 0}
              className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-sunken disabled:opacity-50"
            >
              Remove target
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
