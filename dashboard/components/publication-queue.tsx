"use client";

import { useState } from "react";
import type { PublicationRow } from "@/lib/queries";
import type { PublicationStatus } from "@/lib/types";
import { ChannelChip, StatusBadge } from "@/components/ui";
import { PublicationActions } from "@/components/publication-actions";
import { formatInTz, tzAbbrev } from "@/lib/format";

type StatusFilter = "all" | PublicationStatus;

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "scheduled", label: "Scheduled" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "posted", label: "Posted" },
  { value: "failed", label: "Failed" },
];

const selectCls =
  "rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-ink focus:border-brand";

export function PublicationQueue({
  pubs,
  channels,
  workerOnline = true,
}: {
  pubs: PublicationRow[];
  channels: { id: number; account_name: string; platform: string }[];
  workerOnline?: boolean;
}) {
  const [account, setAccount] = useState<"all" | number>("all");
  const [platform, setPlatform] = useState<"all" | "instagram" | "facebook">("all");
  const [status, setStatus] = useState<StatusFilter>("all");

  const shown = pubs.filter((p) => {
    if (account !== "all" && p.channel_id !== account) return false;
    if (platform !== "all" && p.channel_platform !== platform) return false;
    if (status !== "all" && p.status !== status) return false;
    return true;
  });

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          className={selectCls}
          value={account === "all" ? "all" : String(account)}
          onChange={(e) => setAccount(e.target.value === "all" ? "all" : Number(e.target.value))}
        >
          <option value="all">All accounts</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.account_name}
            </option>
          ))}
        </select>
        <select
          className={selectCls}
          value={platform}
          onChange={(e) => setPlatform(e.target.value as "all" | "instagram" | "facebook")}
        >
          <option value="all">All platforms</option>
          <option value="instagram">Instagram</option>
          <option value="facebook">Facebook</option>
        </select>
        <select
          className={selectCls}
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="data ml-auto text-[11px] text-muted">
          showing {shown.length} of {pubs.length}
        </span>
      </div>

      {shown.length === 0 ? (
        <div className="rounded-card border border-border bg-surface px-4 py-6 text-center text-sm text-muted">
          No sends match these filters.
        </div>
      ) : (
        <div className="overflow-hidden rounded-card border border-border bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-faint">
                <th className="px-4 py-2.5 font-medium">Post</th>
                <th className="px-4 py-2.5 font-medium">Channel</th>
                <th className="px-4 py-2.5 font-medium">When</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} className="border-b border-border last:border-0 align-top">
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      <div className="h-11 w-11 shrink-0 overflow-hidden rounded-md border border-border bg-surface-sunken">
                        {p.first_asset_id ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={`/api/media/${p.first_asset_id}?variant=thumb`}
                            alt=""
                            className="h-full w-full object-cover"
                          />
                        ) : null}
                      </div>
                      <div className="min-w-0">
                        <p className="line-clamp-2 max-w-xs text-ink">
                          {p.post_caption || (
                            <span className="text-faint italic">No caption</span>
                          )}
                        </p>
                        <p className="data mt-0.5 text-[11px] text-faint">
                          {p.post_type}
                          {p.asset_count > 1 ? ` · ${p.asset_count} imgs` : ""}
                          {p.remote_post_id && p.remote_post_id !== "DRYRUN"
                            ? ` · ${p.remote_post_id}`
                            : ""}
                        </p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <ChannelChip
                      id={p.channel_id}
                      platform={p.channel_platform}
                      name={p.channel_name}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <span className="data text-xs text-ink-soft">
                      {formatInTz(p.scheduled_at, p.channel_timezone)}
                    </span>
                    <span className="data block text-[10px] text-faint">
                      {tzAbbrev(p.channel_timezone)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5">
                      <StatusBadge status={p.status} dryRun={p.is_dry_run === 1} />
                      {p.is_held === 1 ? (
                        <span
                          className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium"
                          style={{
                            color: "var(--color-status-draft)",
                            backgroundColor:
                              "color-mix(in srgb, var(--color-status-draft) 12%, white)",
                          }}
                        >
                          Held
                        </span>
                      ) : null}
                    </span>
                    {p.status === "posted" && p.m_fetched_at ? (
                      p.channel_platform === "facebook" ? (
                        <p className="data mt-1 flex gap-2.5 text-[11px] text-ink-soft">
                          <span title="Reactions">♥ {p.m_likes ?? "—"}</span>
                          <span title="Comments">💬 {p.m_comments ?? "—"}</span>
                          <span title="Shares">↪ {p.m_shares ?? "—"}</span>
                          {/* Reach is best-effort on Facebook (Meta keeps retiring the metric
                              names), so show it only when we actually got a number — an empty
                              slot would read as "broken" on every normal row. */}
                          {p.m_reach != null ? (
                            <span title="Reach">◎ {p.m_reach}</span>
                          ) : null}
                        </p>
                      ) : (
                        <p className="data mt-1 flex gap-2.5 text-[11px] text-ink-soft">
                          <span title="Reach">◎ {p.m_reach ?? "—"}</span>
                          <span title="Saves">⤓ {p.m_saves ?? "—"}</span>
                          <span title="Likes">♥ {p.m_likes ?? "—"}</span>
                        </p>
                      )
                    ) : p.status === "posted" && p.is_dry_run !== 1 ? (
                      <p className="data mt-1 text-[10px] text-faint">metrics pending…</p>
                    ) : null}
                    {p.last_error ? (
                      <p className="mt-1 max-w-xs text-[11px] text-status-failed line-clamp-2">
                        {p.last_error}
                      </p>
                    ) : null}
                    {p.attempt_count > 0 && p.status !== "failed" ? (
                      <p className="data mt-0.5 text-[10px] text-faint">
                        attempt {p.attempt_count}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <PublicationActions
                      id={p.id}
                      status={p.status}
                      isDryRun={p.is_dry_run === 1}
                      workerOnline={workerOnline}
                      isHeld={p.is_held === 1}
                      scheduledAt={p.scheduled_at}
                      channelTimezone={p.channel_timezone}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
