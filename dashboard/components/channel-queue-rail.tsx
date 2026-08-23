"use client";

import { ChannelChip } from "@/components/ui";
import { channelColor, formatInTz, tzAbbrev } from "@/lib/format";

/**
 * The per-channel queue rail at the top of the Overview — and, since 2026-08-23, a filter.
 *
 * These cards already answered "where and when"; people kept trying to click them to
 * answer "show me just that one". Now they do: clicking toggles a channel, several can be
 * on at once, and the publications below narrow to the selection. It drives exactly the
 * same state as the Accounts dropdown, so the two can never disagree about what is shown.
 *
 * Nothing selected means everything, which is what an unfiltered list already meant —
 * there is no separate "all" chip to get out of sync with the cards.
 */

export interface RailChannel {
  id: number;
  platform: string;
  account_name: string;
  color_hue: number | null;
  avatar_path: string | null;
  timezone: string;
}

export function ChannelQueueRail({
  channels,
  counts,
  nextAt,
  selected,
  onToggle,
}: {
  channels: RailChannel[];
  counts: Map<number, number>;
  nextAt: Map<number, string>;
  selected: Set<number>;
  onToggle: (channelId: number) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {channels.map((c) => {
        const color = channelColor(c.id, c.color_hue);
        const count = counts.get(c.id) ?? 0;
        const next = nextAt.get(c.id);
        const isOn = selected.has(c.id);
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onToggle(c.id)}
            aria-pressed={isOn}
            // aria-pressed carries the state for assistive tech; the ring carries it
            // visually. Colour alone would not be enough on its own.
            className={`rounded-card border bg-surface p-4 text-left transition-colors ${
              isOn
                ? "border-brand ring-2 ring-brand/30"
                : "border-border hover:bg-surface-sunken/40"
            }`}
            style={{ borderLeft: `3px solid ${color.dot}` }}
            title={isOn ? `Showing only ${c.account_name} — click to clear` : `Show only ${c.account_name}`}
          >
            <div className="flex items-center justify-between">
              <ChannelChip
                id={c.id}
                platform={c.platform}
                name={c.account_name}
                colorHue={c.color_hue}
                avatarPath={c.avatar_path}
              />
              <span className="data text-lg font-semibold text-ink">{count}</span>
            </div>
            <p className="mt-2 text-xs text-muted">
              {count === 0
                ? "Nothing scheduled ahead"
                : next
                  ? `Next ${formatInTz(next, c.timezone)} ${tzAbbrev(c.timezone)}`
                  : ""}
            </p>
          </button>
        );
      })}
    </div>
  );
}
