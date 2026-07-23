"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

export function ChannelToggle({
  id,
  field,
  value,
  labelOn,
  labelOff,
}: {
  id: number;
  field: "requires_approval" | "is_active";
  value: boolean;
  labelOn: string;
  labelOff: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  async function toggle() {
    await fetch(`/api/channels/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: !value }),
    });
    startTransition(() => router.refresh());
  }

  return (
    <button
      onClick={toggle}
      disabled={pending}
      className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
        value
          ? "border-brand/30 bg-brand-weak text-brand-ink"
          : "border-border bg-surface text-muted hover:bg-surface-sunken"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${value ? "bg-brand" : "bg-faint"}`}
        aria-hidden
      />
      {value ? labelOn : labelOff}
    </button>
  );
}
