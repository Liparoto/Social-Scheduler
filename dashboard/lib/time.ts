// Convert a wall-clock time entered for a specific IANA timezone into a UTC ISO
// string for storage. All scheduled_at values live in UTC; the channel timezone
// governs how they're entered and displayed.

export function zonedTimeToUtc(local: string, timeZone: string): string {
  // `local` is a datetime-local value like "2026-08-01T18:00" (no zone).
  // Interpret those wall-clock digits AS-IF UTC, then subtract the target zone's
  // offset at that moment (standard Intl offset trick).
  const asIfUtc = new Date(`${local}:00Z`);
  if (Number.isNaN(asIfUtc.getTime())) {
    throw new Error(`Invalid datetime: ${local}`);
  }
  const inZone = new Date(asIfUtc.toLocaleString("en-US", { timeZone }));
  const inUtc = new Date(asIfUtc.toLocaleString("en-US", { timeZone: "UTC" }));
  const offset = inZone.getTime() - inUtc.getTime();
  return new Date(asIfUtc.getTime() - offset).toISOString();
}
