"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { US_TIMEZONES, isPresetTimezone, isValidTimezone } from "@/lib/timezones";

const CUSTOM = "__custom__";

/**
 * Timezone control: the four continental US zones as a dropdown, with a Custom
 * option that takes any IANA name.
 *
 * The shortlist is a convenience, not a constraint — this repo is meant to be
 * cloned by anyone, so the long tail has to stay reachable. A saved value that
 * isn't one of the four (including today's default of "UTC") opens the control
 * in Custom mode with the value already filled, so nothing is ever silently
 * rewritten just by rendering the form.
 *
 * `onValidityChange` lets the parent disable its own Save button — validation
 * has to live here because only this component knows what's in the text box.
 */
export function TimezonePicker({
  value,
  onChange,
  onValidityChange,
  className,
}: {
  value: string;
  onChange: (tz: string) => void;
  onValidityChange?: (valid: boolean) => void;
  className?: string;
}) {
  const [custom, setCustom] = useState(() => (isPresetTimezone(value) ? "" : value));
  const [isCustom, setIsCustom] = useState(() => !isPresetTimezone(value));

  const valid = isValidTimezone(value);

  useEffect(() => {
    onValidityChange?.(valid);
  }, [valid, onValidityChange]);

  function selectPreset(next: string) {
    if (next === CUSTOM) {
      setIsCustom(true);
      onChange(custom); // may be "" — the parent's Save stays disabled until it's valid
      return;
    }
    setIsCustom(false);
    onChange(next);
  }

  const selectCls =
    className ??
    "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink focus:border-brand";

  return (
    <div className="space-y-2">
      <select
        className={selectCls}
        value={isCustom ? CUSTOM : value}
        onChange={(e) => selectPreset(e.target.value)}
      >
        {US_TIMEZONES.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label} — {t.value}
          </option>
        ))}
        <option value={CUSTOM}>Other (type an IANA name)…</option>
      </select>

      {isCustom ? (
        <input
          className={selectCls}
          placeholder="Europe/London"
          value={custom}
          autoFocus
          onChange={(e) => {
            setCustom(e.target.value);
            onChange(e.target.value.trim());
          }}
        />
      ) : null}

      <TimezonePreview timezone={value} valid={valid} />
    </div>
  );
}

const MINUTE = 60_000;

/**
 * The current minute, as a client-only value.
 *
 * useSyncExternalStore rather than a useState/useEffect pair: the server
 * snapshot is `null`, so SSR emits no clock at all and there is nothing to
 * mismatch on hydration — without setting state inside an effect, and without
 * calling the impure `Date.now()` during render.
 *
 * The snapshot is truncated to the minute so it is stable between renders (a
 * raw Date.now() would be a new value every read, which makes the store loop).
 * We only ever display minutes, so truncating costs no accuracy; the subscribe
 * tick is finer than a minute purely so the flip happens promptly.
 */
function useCurrentMinute(): number | null {
  return useSyncExternalStore(
    (onChange) => {
      const t = setInterval(onChange, 15_000);
      return () => clearInterval(t);
    },
    () => Math.floor(Date.now() / MINUTE),
    () => null
  );
}

/**
 * The "is this the one I meant?" line: zone abbreviation and the current local
 * time there. Nobody can verify "America/Denver" by reading it, but everyone can
 * verify "MDT · 1:42 PM".
 */
function TimezonePreview({ timezone, valid }: { timezone: string; valid: boolean }) {
  const minute = useCurrentMinute();

  let now: string | null = null;
  if (valid && minute !== null) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).formatToParts(new Date(minute * MINUTE));
    const abbrev = parts.find((p) => p.type === "timeZoneName")?.value ?? timezone;
    const clock = parts
      .filter((p) => ["hour", "minute", "literal", "dayPeriod"].includes(p.type))
      .map((p) => p.value)
      .join("")
      .trim();
    now = `${abbrev} · ${clock}`;
  }

  if (!valid) {
    return (
      <p className="text-xs text-status-failed">
        {timezone.trim()
          ? `"${timezone}" isn't a timezone name — try America/New_York.`
          : "Enter an IANA timezone name, e.g. America/New_York."}
      </p>
    );
  }
  return (
    <p className="data text-xs text-muted">
      {now ? `${now} right now` : " "}
    </p>
  );
}
