"use client";

import { useEffect, useMemo, useReducer, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { channelColor, formatInTz, videoPreviewSrc } from "@/lib/format";
import {
  createLibraryCheckboxFilterState,
  libraryCheckboxFilterReducer,
  matchesLibraryCheckboxFilters,
  type CheckboxFilterOption,
} from "@/lib/library-checkbox-filters";
import {
  librarySeasonBadgeDetails,
  librarySeasonStatus,
  type LibrarySeasonPeriod,
  type LibrarySeasonStatus,
} from "@/lib/library-season-status";
import { PLATFORMS, incompatibleChannelsForPostType, platformLabel } from "@/lib/platforms";
import { MediaBadge, MediaLightbox, type LightboxAsset } from "@/components/media-lightbox";
import { MergeModal, type MergeCandidatePost } from "@/components/merge-modal";
import { BulkEditModal } from "@/components/bulk-edit-modal";
import { CheckboxFilterDropdown } from "@/components/checkbox-filter-dropdown";
import { ChannelAvatar } from "@/components/ui";
import type { Period, Tag } from "@/lib/types";

interface PostLite {
  id: number;
  caption: string | null;
  post_type: string;
  status: string;
  first_asset_id: number | null;
  first_asset_media_kind: "image" | "video" | null;
  first_asset_cover_frame_ms: number | null;
  first_asset_width: number | null;
  first_asset_height: number | null;
  asset_count: number;
  asset_ids: number[];
  scheduled_count: number;
  posted_count: number;
  last_posted_at: string | null;
  content_kind: "one_time" | "evergreen";
  content_status: "draft" | "ready" | "retired";
  target_count: number;
  periods: LibrarySeasonPeriod[];
  time_of_day_tags: string | null;
  topic_tags: string | null;
  target_platforms: string | null;
  has_queued_publication: boolean;
}
interface ChannelLite {
  id: number;
  account_name: string;
  platform: string;
  timezone: string;
  requires_approval: boolean;
  color_hue: number | null;
  avatar_path: string | null;
}

// The post_type values the Library can filter by, with the label each one gets. Ordered
// the way they're offered in the Format dropdown and counted in the summary line.
type PostFormat = "carousel" | "single" | "reel" | "text";
const POST_FORMATS: { value: PostFormat; label: string }[] = [
  { value: "carousel", label: "Carousel" },
  { value: "single", label: "Single image" },
  { value: "reel", label: "Reel" },
  { value: "text", label: "Text-only" },
];

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function splitTags(value: string | null): string[] {
  return value ? value.split(",") : [];
}

export function LibraryView({
  posts,
  channels,
  periods,
  timeOfDayTags,
  topicTags,
  evaluationDate,
  evaluationTimezone,
}: {
  posts: PostLite[];
  channels: ChannelLite[];
  periods: Period[];
  timeOfDayTags: Tag[];
  topicTags: Tag[];
  evaluationDate: string;
  evaluationTimezone: string;
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
  const [checkboxFilters, dispatchCheckboxFilters] = useReducer(
    libraryCheckboxFilterReducer,
    undefined,
    createLibraryCheckboxFilterState,
  );
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "ready" | "retired">("all");
  // Deliberately separate from statusFilter: content_status is the lifecycle (is this piece
  // usable), sendFilter is publication history (has it actually gone out). Folding them into
  // one select would cost the most useful query in the Library — "Ready but never posted".
  const [sendFilter, setSendFilter] = useState<"all" | "posted" | "never">("all");
  const [kindFilter, setKindFilter] = useState<"all" | "evergreen" | "one_time">("all");
  const [formatFilter, setFormatFilter] = useState<"all" | PostFormat>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"newest" | "recent" | "stale">("newest");
  const [openMedia, setOpenMedia] = useState<{ asset: LightboxAsset; label: string } | null>(
    null
  );
  const [mergeOpen, setMergeOpen] = useState(false);
  const [bulkEditOpen, setBulkEditOpen] = useState(false);

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

  const { allTagNames, allPeriods } = useMemo(() => {
    const tagNames = Array.from(
      new Set(
        posts.flatMap((post) => [
          ...splitTags(post.time_of_day_tags),
          ...splitTags(post.topic_tags),
        ]),
      ),
    ).sort();
    const postPeriods = Array.from(
      new Map<number, string>(
        posts.flatMap((post) => post.periods.map((period) => [period.id, period.name])),
      ),
    )
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { allTagNames: tagNames, allPeriods: postPeriods };
  }, [posts]);
  const periodOptions: CheckboxFilterOption<number>[] = useMemo(
    () => allPeriods.map(({ id, name }) => ({ value: id, label: name })),
    [allPeriods],
  );
  const tagOptions: CheckboxFilterOption<string>[] = useMemo(
    () => allTagNames.map((name) => ({ value: name, label: name })),
    [allTagNames],
  );
  const platformOptions: CheckboxFilterOption<string>[] = useMemo(
    () =>
      PLATFORMS.map((platform) => ({
        value: platform.value,
        label: platformLabel(platform.value),
      })),
    [],
  );
  const availableCheckboxFilters = useMemo(
    () => ({
      periods: new Set(periodOptions.map((option) => option.value)),
      tags: new Set(tagOptions.map((option) => option.value)),
      platforms: new Set(platformOptions.map((option) => option.value)),
    }),
    [periodOptions, tagOptions, platformOptions],
  );

  useEffect(() => {
    dispatchCheckboxFilters({
      type: "reconcile-available",
      available: availableCheckboxFilters,
    });
  }, [availableCheckboxFilters]);

  // Counted over the whole library, not the filtered view, so the numbers stay put while
  // you click between formats instead of collapsing to "N Carousel" the moment one is on.
  const formatCounts = POST_FORMATS.map((f) => ({
    ...f,
    count: posts.filter((p) => p.post_type === f.value).length,
  })).filter((f) => f.count > 0);

  const q = search.trim().toLowerCase();
  const shown = posts.filter((p) => {
    if (
      !matchesLibraryCheckboxFilters(
        {
          periods: p.periods.map((period) => period.id),
          tags: [...splitTags(p.time_of_day_tags), ...splitTags(p.topic_tags)],
          platforms: splitTags(p.target_platforms),
        },
        checkboxFilters.applied,
      )
    )
      return false;
    if (statusFilter !== "all" && p.content_status !== statusFilter) return false;
    // posted_count counts publications that actually reached "posted", so a post sitting in
    // the queue still reads as never posted here — matching the card's own badge.
    if (sendFilter === "posted" && p.posted_count === 0) return false;
    if (sendFilter === "never" && p.posted_count > 0) return false;
    if (kindFilter !== "all" && p.content_kind !== kindFilter) return false;
    if (formatFilter !== "all" && p.post_type !== formatFilter) return false;
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
  const effectiveChans = new Set([...chans].filter((id) => !incompatibleChannelIds.has(id)));

  // In SELECTION order (not `posts` order) — `selected` is the ordered array, and the merge
  // API treats its first entry as the surviving post. A stale id (deleted between load and
  // click, or filtered out of the current view) is dropped rather than crashing the modal.
  const selectedForMerge: MergeCandidatePost[] = selected.flatMap((id) => {
    const p = posts.find((post) => post.id === id);
    return p
      ? [{ id: p.id, caption: p.caption, asset_ids: p.asset_ids, has_queued_publication: p.has_queued_publication }]
      : [];
  });

  function onMerged() {
    setMergeOpen(false);
    setSelected([]);
    setNotice("Merged into one carousel.");
    startT(() => router.refresh());
  }

  function onBulkEdited(labels: string[]) {
    const postCount = selected.length;
    setBulkEditOpen(false);
    setSelected([]);
    setNotice(
      `Updated ${postCount} post${postCount === 1 ? "" : "s"}: ${labels.join("; ")}.`
    );
    startT(() => router.refresh());
  }

  const sorted = [...shown].sort((a, b) => {
    if (sort === "newest") return b.id - a.id;
    const av = a.last_posted_at;
    const bv = b.last_posted_at;
    if (av === null && bv === null) return b.id - a.id;
    if (av === null) return 1; // never-posted always last
    if (bv === null) return -1;
    return sort === "recent" ? bv.localeCompare(av) : av.localeCompare(bv);
  });

  const readySeasonStatusClass: Record<LibrarySeasonStatus, string> = {
    Live: "border-status-posted/30 bg-status-posted/10 text-status-posted",
    Dormant: "border-status-scheduled/30 bg-status-scheduled/10 text-status-scheduled",
    Blocked: "border-status-failed/30 bg-status-failed/10 text-status-failed",
    "Invalid period":
      "border-status-publishing/40 bg-status-publishing/10 text-status-publishing",
    Draft: "",
    Retired: "",
  };

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
        {/* Format counts double as one-click filters — the fastest way to pull up every
            carousel. A format with nothing in it is omitted rather than shown as a dead 0. */}
        {formatCounts.length > 0 ? (
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        ) : null}
        {formatCounts.map(({ value, label, count }) => {
          const on = formatFilter === value;
          return (
            <button
              key={value}
              onClick={() => setFormatFilter(on ? "all" : value)}
              aria-pressed={on}
              className={`rounded px-1 transition-colors hover:text-ink ${
                on ? "text-brand-strong underline underline-offset-2" : ""
              }`}
            >
              {count} {label}
            </button>
          );
        })}
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
        <select
          className={field}
          aria-label="Filter by publication history"
          value={sendFilter}
          onChange={(e) => setSendFilter(e.target.value as typeof sendFilter)}
        >
          <option value="all">Posted &amp; not</option>
          <option value="posted">Posted</option>
          <option value="never">Never posted</option>
        </select>
        <select className={field} value={kindFilter} onChange={(e) => setKindFilter(e.target.value as typeof kindFilter)}>
          <option value="all">All kinds</option>
          <option value="evergreen">Evergreen</option>
          <option value="one_time">One-time</option>
        </select>
        <select
          className={field}
          aria-label="Filter by format"
          value={formatFilter}
          onChange={(e) => setFormatFilter(e.target.value as typeof formatFilter)}
        >
          <option value="all">All formats</option>
          {POST_FORMATS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
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
        <button
          type="button"
          onClick={() => setSelected(shown.map((post) => post.id))}
          disabled={shown.length === 0}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-xs font-medium text-ink hover:bg-surface-sunken disabled:opacity-50"
        >
          Select all {shown.length} shown
        </button>
        {selected.length > 0 ? (
          <button
            type="button"
            onClick={() => setSelected([])}
            className="rounded-lg px-2 py-2 text-xs text-muted underline underline-offset-2 hover:text-ink"
          >
            Clear selection
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink-soft">Filter:</span>
        <CheckboxFilterDropdown
          label="Periods"
          options={periodOptions}
          selected={checkboxFilters.applied.periods}
          onApply={(values) =>
            dispatchCheckboxFilters({ type: "apply-group", group: "periods", values })
          }
        />
        <CheckboxFilterDropdown
          label="Tags"
          options={tagOptions}
          selected={checkboxFilters.applied.tags}
          onApply={(values) =>
            dispatchCheckboxFilters({ type: "apply-group", group: "tags", values })
          }
        />
        <CheckboxFilterDropdown
          label="Platforms"
          options={platformOptions}
          selected={checkboxFilters.applied.platforms}
          onApply={(values) =>
            dispatchCheckboxFilters({ type: "apply-group", group: "platforms", values })
          }
        />
      </div>

      {/* Post grid */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sorted.map((p) => {
          const on = selected.includes(p.id);
          const order = selected.indexOf(p.id) + 1;
          const seasonStatus = librarySeasonStatus(p.content_status, p.periods, evaluationDate);
          const badgeDetails =
            p.content_status === "ready"
              ? librarySeasonBadgeDetails(
                  p.id,
                  seasonStatus,
                  evaluationDate,
                  evaluationTimezone
                )
              : null;
          return (
            <div
              key={p.id}
              role="button"
              tabIndex={0}
              onClick={() => toggle(p.id)}
              onKeyDown={(e) => {
                // Let keyboard activation of the nested title/thumbnail link, or the
                // media badge button, do its own thing without also toggling selection
                // (stopPropagation on their onClick guards mouse clicks, not the bubbling
                // keydown — and without this guard, this handler's preventDefault() below
                // would also cancel the button's own Enter/Space activation).
                if ((e.target as HTMLElement).closest("a, button")) return;
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
                {p.first_asset_id && p.first_asset_media_kind ? (
                  <MediaBadge
                    mediaKind={p.first_asset_media_kind}
                    label={p.caption ?? undefined}
                    onOpen={() =>
                      setOpenMedia({
                        label: p.caption || `Post ${p.id}`,
                        asset: {
                          id: p.first_asset_id as number,
                          media_kind: p.first_asset_media_kind as "image" | "video",
                          cover_frame_ms: p.first_asset_cover_frame_ms,
                          width: p.first_asset_width,
                          height: p.first_asset_height,
                        },
                      })
                    }
                  />
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
                  {p.content_status === "ready" && badgeDetails ? (
                    <span className="group relative inline-flex">
                      <button
                        {...badgeDetails.triggerProps}
                        onClick={(event) => event.stopPropagation()}
                        className={`cursor-help rounded-full border px-1.5 py-px ${readySeasonStatusClass[seasonStatus]}`}
                      >
                        {seasonStatus}
                      </button>
                      <span
                        {...badgeDetails.tooltipProps}
                        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-64 -translate-x-1/2 rounded-md border border-border-strong bg-ink px-2.5 py-2 text-left font-sans text-[11px] leading-4 text-surface opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                      >
                        {badgeDetails.description}
                      </span>
                    </span>
                  ) : (
                    <span className={p.content_status === "draft" ? "text-muted" : "text-faint"}>
                      {seasonStatus}
                    </span>
                  )}
                  <span>
                    {p.target_count > 0 ? `→ ${p.target_count} account(s)` : "no targets"}
                  </span>
                </div>
                {p.periods.length > 0 ? (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {p.periods.map((period) => (
                      <span
                        key={`${period.id}-${period.mode}`}
                        title={period.mode === "green" ? "In-season period" : "Blackout period"}
                        className={`data rounded-full border px-2 py-0.5 text-[11px] ${
                          period.mode === "green"
                            ? "border-status-posted/30 bg-status-posted/10 text-status-posted"
                            : "border-status-failed/30 bg-status-failed/10 text-status-failed"
                        }`}
                      >
                        {period.name}
                      </span>
                    ))}
                  </div>
                ) : null}
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

      {/* Bulk schedule bar. z-20 is load-bearing: the thumbnails' MediaBadge sits at z-10,
          and without a higher layer here those badges punched through the bar's opaque
          background as the grid scrolled under it. Stays below the lightbox's z-50. */}
      <div className="sticky bottom-4 z-20 rounded-card border border-border-strong bg-surface p-4 shadow-lg">
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
                  <ChannelAvatar
                    id={c.id}
                    name={c.account_name}
                    colorHue={c.color_hue}
                    avatarPath={c.avatar_path}
                    size={14}
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

        <div className="mt-3 border-t border-border pt-3">
          <p className="mb-1.5 text-[11px] text-faint">
            Add or remove metadata, or set shared values, across every selected post.
          </p>
          <button
            onClick={() => setBulkEditOpen(true)}
            disabled={pending || selected.length === 0}
            title={selected.length === 0 ? "Select at least one post to edit." : undefined}
            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-sunken disabled:opacity-50"
          >
            Edit metadata
          </button>
        </div>

        <div className="mt-3 border-t border-border pt-3">
          <p className="mb-1.5 text-[11px] text-faint">
            Fold several single-image drafts into one carousel, in review before anything is
            deleted.
          </p>
          <button
            onClick={() => setMergeOpen(true)}
            disabled={pending || selected.length < 2}
            title={selected.length < 2 ? "Select at least two posts to merge." : undefined}
            className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-sunken disabled:opacity-50"
          >
            Merge into carousel
          </button>
        </div>
      </div>

      {openMedia ? (
        <MediaLightbox
          asset={openMedia.asset}
          label={openMedia.label}
          onClose={() => setOpenMedia(null)}
        />
      ) : null}

      {mergeOpen ? (
        <MergeModal
          posts={selectedForMerge}
          onClose={() => setMergeOpen(false)}
          onMerged={onMerged}
        />
      ) : null}

      {bulkEditOpen ? (
        <BulkEditModal
          postIds={selected}
          periods={periods}
          timeOfDayTags={timeOfDayTags}
          topicTags={topicTags}
          onClose={() => setBulkEditOpen(false)}
          onSaved={onBulkEdited}
        />
      ) : null}
    </div>
  );
}
