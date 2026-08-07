"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Tag } from "@/lib/types";

type TopicTag = Tag & { post_count: number };

function usageLabel(n: number): string {
  if (n === 0) return "Not used on any post";
  return `On ${n} post${n === 1 ? "" : "s"}`;
}

const secondaryBtn =
  "rounded-md border border-border px-3 py-1.5 text-xs font-medium text-ink-soft hover:bg-surface-sunken disabled:opacity-50";

function TagRow({ tag }: { tag: TopicTag }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState<"idle" | "renaming" | "deleting">("idle");
  const [draft, setDraft] = useState(tag.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setMode("idle");
    setDraft(tag.name);
    setError(null);
  }

  async function remove() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/tags/${tag.id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Could not delete the tag.");
      setBusy(false);
      return;
    }
    setMode("idle");
    setBusy(false);
    startTransition(() => router.refresh());
  }

  async function rename() {
    const name = draft.trim();
    if (!name || busy) return;
    if (name === tag.name) {
      reset();
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/tags/${tag.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Could not rename the tag.");
      setBusy(false);
      return;
    }
    setMode("idle");
    setBusy(false);
    startTransition(() => router.refresh());
  }

  return (
    <div className="rounded-card border border-border bg-surface px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        {mode === "renaming" ? (
          <input
            autoFocus
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-faint focus:border-brand"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                rename();
              }
              if (e.key === "Escape") reset();
            }}
          />
        ) : (
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink">{tag.name}</p>
            <p className="mt-0.5 text-xs text-muted">{usageLabel(tag.post_count)}</p>
          </div>
        )}

        {mode === "idle" ? (
          <div className="flex shrink-0 gap-2">
            <button onClick={() => setMode("renaming")} disabled={pending} className={secondaryBtn}>
              Rename
            </button>
            <button
              onClick={() => setMode("deleting")}
              disabled={pending}
              className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-status-failed hover:bg-surface-sunken disabled:opacity-50"
            >
              Delete
            </button>
          </div>
        ) : (
          <div className="flex shrink-0 gap-2">
            <button
              onClick={reset}
              disabled={busy}
              className="rounded-md px-3 py-1.5 text-xs font-medium text-muted hover:text-ink disabled:opacity-50"
            >
              Cancel
            </button>
            {mode === "renaming" ? (
              <button
                onClick={rename}
                disabled={busy || pending || !draft.trim()}
                className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-on-brand hover:bg-brand-ink disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save"}
              </button>
            ) : (
              <button
                onClick={remove}
                disabled={busy || pending}
                className="rounded-md bg-status-failed px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {busy ? "Deleting…" : "Delete for good"}
              </button>
            )}
          </div>
        )}
      </div>

      {mode === "renaming" ? (
        <p className="mt-3 border-t border-border pt-3 text-xs text-ink-soft">
          Fixes the spelling everywhere at once.{" "}
          {tag.post_count === 0 ? (
            <>It isn&rsquo;t on any post yet.</>
          ) : (
            <>
              All{" "}
              <span className="font-medium text-ink">
                {tag.post_count} post{tag.post_count === 1 ? "" : "s"}
              </span>{" "}
              keep the tag under its new name.
            </>
          )}
        </p>
      ) : null}

      {mode === "deleting" ? (
        <p className="mt-3 border-t border-border pt-3 text-xs text-ink-soft">
          {tag.post_count === 0 ? (
            <>
              Delete <span className="font-medium text-ink">{tag.name}</span>? It isn&rsquo;t
              on any post, so nothing else changes.
            </>
          ) : (
            <>
              Delete <span className="font-medium text-ink">{tag.name}</span>? It comes off{" "}
              <span className="font-medium text-ink">
                {tag.post_count} post{tag.post_count === 1 ? "" : "s"}
              </span>
              . The posts themselves — captions, images, schedules — are not touched, and
              any other tags they carry stay put. This cannot be undone.{" "}
              <span className="text-muted">
                Fixing a typo? Cancel and use Rename instead — it keeps the posts attached.
              </span>
            </>
          )}
        </p>
      ) : null}

      {error ? <p className="mt-2 text-xs text-status-failed">{error}</p> : null}
    </div>
  );
}

export function TagManager({
  topicTags,
  bandTags,
}: {
  topicTags: TopicTag[];
  bandTags: Tag[];
}) {
  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-1 font-display text-base font-semibold text-ink">Topics</h2>
        <p className="mb-3 text-sm text-muted">
          Your own labels. Add new ones while composing a post; rename or retire them here.
          Rename fixes a typo everywhere at once and keeps the posts attached — delete takes
          the label off them.
        </p>
        {topicTags.length === 0 ? (
          <div className="rounded-card border border-dashed border-border-strong bg-surface/60 px-6 py-10 text-center text-sm text-muted">
            No topic tags yet. Add one from the tag picker when you compose a post.
          </div>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {topicTags.map((tag) => (
              <TagRow key={tag.id} tag={tag} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-1 font-display text-base font-semibold text-ink">
          Time of day
        </h2>
        <p className="mb-3 text-sm text-muted">
          A fixed set the auto-fill scheduler matches on by name, so these can&rsquo;t be
          deleted. Leave a post untagged (or on Anytime) to use the channel&rsquo;s default
          time.
        </p>
        <div className="flex flex-wrap gap-2">
          {bandTags.map((tag) => (
            <span
              key={tag.id}
              className="rounded-full border border-border bg-surface-sunken px-3 py-1 text-sm capitalize text-muted"
            >
              {tag.name}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}
