"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

interface Props {
  channelId: number;
  groupId: number | null;
  groups: { id: number; name: string }[];
}

export function ChannelGroupSelect({ channelId, groupId, groups }: Props) {
  const router = useRouter();
  const [value, setValue] = useState(groupId === null ? "" : String(groupId));
  const [pending, startT] = useTransition();

  async function change(next: string) {
    setValue(next);
    await fetch(`/api/channels/${channelId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_id: next === "" ? null : Number(next) }),
    });
    startT(() => router.refresh());
  }

  return (
    <label className="mt-4 flex items-center justify-between gap-3 text-xs text-ink-soft">
      <span>Auto-fill group</span>
      <select
        value={value}
        disabled={pending}
        onChange={(e) => change(e.target.value)}
        className="rounded-md border border-border bg-surface px-2 py-1 text-sm text-ink focus:border-brand disabled:opacity-50"
      >
        <option value="">On its own</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
    </label>
  );
}
