"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type {
  Asset,
  Channel,
  ContentKind,
  ContentStatus,
  Period,
  PeriodMode,
  Post,
  PostPublicationRow,
  Tag,
} from "@/lib/types";
import { channelColor } from "@/lib/format";
import { platformLabel } from "@/lib/platforms";
import { CaptionVariantsEditor, overLimitCaptionVariants } from "./caption-variants-editor";
import { TagEditor } from "./tag-editor";
import { PeriodAttach } from "./period-attach";
import { ConformControl } from "./conform-control";
import { PostSendsPanel } from "./post-sends-panel";

const card = "rounded-card border border-border bg-surface p-5";
const segBtn = (active: boolean) =>
  `rounded-md px-3 py-1.5 text-sm transition-colors ${
    active ? "bg-brand-weak font-medium text-brand-strong" : "text-muted hover:text-ink"
  }`;

export function PostEditor({
  post,
  assets,
  channels,
  sends,
  sendableChannels,
  periods,
  timeOfDayTags,
  topicTags,
  initialTargets,
  initialTagIds,
  initialPeriods,
  initialCaptions,
}: {
  post: Post;
  assets: Asset[];
  channels: Channel[];
  sends: PostPublicationRow[];
  sendableChannels: Channel[];
  periods: Period[];
  timeOfDayTags: Tag[];
  topicTags: Tag[];
  initialTargets: number[];
  initialTagIds: number[];
  initialPeriods: Record<number, PeriodMode>;
  initialCaptions: { platform: string; body: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [kind, setKind] = useState<ContentKind>(post.content_kind);
  const [status, setStatus] = useState<ContentStatus>(post.content_status);
  const [cooldown, setCooldown] = useState(
    post.cooldown_days === null ? "" : String(post.cooldown_days)
  );
  const [targets, setTargets] = useState<Set<number>>(new Set(initialTargets));
  const [tagIds, setTagIds] = useState<number[]>(initialTagIds);
  const [periodModes, setPeriodModes] = useState<Record<number, PeriodMode>>(initialPeriods);
  const [captions, setCaptions] = useState(
    initialCaptions.length ? initialCaptions : [{ platform: "", body: "" }]
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggleTarget = (id: number) =>
    setTargets((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  async function save() {
    setError(null);
    setNotice(null);
    const overLimit = overLimitCaptionVariants(captions);
    if (overLimit.length > 0) {
      setError(
        `Caption is over the limit for: ${overLimit
          .map((v) => `${platformLabel(v.platform)} (${v.length}/${v.limit})`)
          .join(", ")}.`
      );
      return;
    }
    const body = {
      content_kind: kind,
      content_status: status,
      cooldown_days: cooldown.trim() === "" ? null : Number(cooldown),
      target_channel_ids: Array.from(targets),
      tag_ids: tagIds,
      period_links: Object.entries(periodModes).map(([pid, mode]) => ({
        periodId: Number(pid),
        mode,
      })),
      caption_variants: captions
        .filter((v) => v.body.trim())
        .map((v, i) => ({ platform: v.platform || null, body: v.body.trim(), sort_order: i })),
    };
    const res = await fetch(`/api/posts/${post.id}/content`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setError(b.error ?? "Could not save changes.");
      return;
    }
    setNotice("Changes saved.");
    startTransition(() => router.refresh());
  }

  async function deletePost() {
    setDeleteError(null);
    setDeleting(true);
    const res = await fetch(`/api/posts/${post.id}`, { method: "DELETE" });
    setDeleting(false);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      setDeleteError(b.error ?? "Could not delete this post.");
      setConfirmDelete(false);
      return;
    }
    router.push("/library");
  }

  return (
    <div className="space-y-6">
      {/* Read-only context strip */}
      <section className={card}>
        <div className="flex items-start gap-4">
          <div className="flex gap-2">
            {assets.length ? (
              assets.slice(0, 4).map((a) => (
                <div key={a.id}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/media/${a.id}?variant=thumb`}
                    alt=""
                    className="h-16 w-16 rounded-lg object-cover"
                  />
                  {a.needs_review ? (
                    <ConformControl
                      assetId={a.id}
                      conformMode={a.conform_mode}
                      needsReview={a.needs_review}
                    />
                  ) : null}
                </div>
              ))
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-surface-sunken text-center text-xs text-faint">
                {post.post_type === "text" ? "Text post" : "no image"}
              </div>
            )}
          </div>
          <div className="data text-xs text-ink-soft">
            <p>{post.post_type}{assets.length > 1 ? ` · ${assets.length} imgs` : ""}</p>
            <p className="mt-1 text-muted">Schedule status: {post.status}</p>
            <p className="mt-0.5 text-faint">Images and scheduling are managed elsewhere.</p>
          </div>
        </div>
      </section>

      {/* Kind */}
      <section className={card}>
        <h3 className="mb-2 font-display text-sm font-semibold text-ink">Kind</h3>
        <div className="inline-flex rounded-lg border border-border p-0.5">
          <button type="button" className={segBtn(kind === "evergreen")} onClick={() => setKind("evergreen")}>
            Evergreen
          </button>
          <button type="button" className={segBtn(kind === "one_time")} onClick={() => setKind("one_time")}>
            One-time
          </button>
        </div>
      </section>

      {/* Caption variants */}
      <section className={card}>
        <CaptionVariantsEditor value={captions} onChange={setCaptions} />
      </section>

      {/* Targets */}
      <section className={card}>
        <h3 className="mb-2 font-display text-sm font-semibold text-ink">Target accounts</h3>
        <p className="mb-3 text-xs text-muted">Which accounts auto-fill can post this to.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {channels.map((c) => {
            const on = targets.has(c.id);
            const color = channelColor(c.id);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => toggleTarget(c.id)}
                className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  on ? "border-transparent" : "border-border hover:bg-surface-sunken"
                }`}
                style={on ? { backgroundColor: color.bg, boxShadow: `inset 0 0 0 2px ${color.dot}` } : undefined}
              >
                <span className="text-sm text-ink">{c.account_name}</span>
                <span className="ml-auto text-xs text-muted">{c.platform}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Tags */}
      <section className={card}>
        <h3 className="mb-2 font-display text-sm font-semibold text-ink">Tags</h3>
        <TagEditor timeOfDayTags={timeOfDayTags} topicTags={topicTags} value={tagIds} onChange={setTagIds} />
      </section>

      {/* Periods */}
      <PeriodAttach periods={periods} value={periodModes} onChange={setPeriodModes} />

      {/* Scheduled sends (retarget/hold/remove/add) */}
      <PostSendsPanel postId={post.id} postType={post.post_type} sends={sends} channels={sendableChannels} />

      {/* Content status + cooldown + save */}
      <section className={card}>
        <h3 className="mb-1 font-display text-sm font-semibold text-ink">Content status</h3>
        <p className="mb-2 text-xs text-muted">Ready content is eligible for auto-fill; drafts and retired are not.</p>
        <div className="inline-flex rounded-lg border border-border p-0.5">
          <button type="button" className={segBtn(status === "draft")} onClick={() => setStatus("draft")}>Draft</button>
          <button type="button" className={segBtn(status === "ready")} onClick={() => setStatus("ready")}>Ready</button>
          <button type="button" className={segBtn(status === "retired")} onClick={() => setStatus("retired")}>Retired</button>
        </div>

        <div className="mt-4">
          <label className="block text-xs font-medium text-ink-soft mb-1">
            Cooldown override (days) <span className="text-faint">— blank = channel default</span>
          </label>
          <input
            type="number"
            min={0}
            className="w-40 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand"
            value={cooldown}
            onChange={(e) => setCooldown(e.target.value)}
          />
        </div>

        {error ? <p className="mt-3 text-sm text-status-failed">{error}</p> : null}
        {notice ? <p className="mt-3 text-sm text-status-posted">{notice}</p> : null}

        <div className="mt-4 flex justify-end">
          <button
            onClick={save}
            disabled={pending}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-on-brand hover:bg-brand-ink disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </section>

      {/* Delete post — guarded, irreversible */}
      <section className="rounded-card border border-status-failed/30 bg-surface p-5">
        <h3 className="mb-1 font-display text-sm font-semibold text-status-failed">Delete post</h3>
        <p className="mb-3 text-xs text-muted">
          This deletes the post and all its scheduled/failed sends (shared images are kept).
        </p>
        {deleteError ? <p className="mb-3 text-sm text-status-failed">{deleteError}</p> : null}
        {confirmDelete ? (
          <div className="flex items-center gap-2">
            <button
              onClick={deletePost}
              disabled={deleting}
              className="rounded-lg bg-status-failed px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {deleting ? "Deleting…" : "Confirm delete post"}
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
              className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted hover:text-ink disabled:opacity-50"
            >
              Keep post
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirmDelete(true)}
            className="rounded-lg border border-status-failed px-4 py-2 text-sm font-medium text-status-failed hover:bg-status-failed/10"
          >
            Delete post…
          </button>
        )}
      </section>
    </div>
  );
}
