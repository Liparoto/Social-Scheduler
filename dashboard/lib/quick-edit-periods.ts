import type { PeriodMode } from "./types";

/**
 * Period-link handling for the Library's quick-edit dialog.
 *
 * The dialog's control (`<PeriodAttach>`) is one-mode-per-period: Off / Green / Blackout.
 * The DATABASE is not. `post_periods`' primary key is (post_id, period_id, mode), so one
 * post can legitimately hold BOTH a green and a blackout link on the same period, and two
 * existing flows produce exactly that — bulk edit attaches modes independently with
 * `INSERT OR IGNORE`, and merging carousels copies the surviving post's links from every
 * post folded into it.
 *
 * Collapsing that to one mode for display is fine — the full editor already does it. What
 * is NOT fine is sending the collapsed view straight back on save: the route replaces a
 * post's links wholesale, so the mode the dialog couldn't show would be deleted by someone
 * who only came to flip a status. These helpers keep the display collapse but preserve any
 * link the user did not actually touch.
 */

export interface PeriodLinkRow {
  id: number;
  mode: PeriodMode;
}

export interface PeriodLinkPayload {
  periodId: number;
  mode: PeriodMode;
}

/**
 * The one-mode-per-period view the dialog edits. Later rows win, matching what
 * `<PostEditor>` does — this is the display model, not the source of truth.
 */
export function collapsePeriodLinks(rows: PeriodLinkRow[]): Record<number, PeriodMode> {
  return Object.fromEntries(rows.map((row) => [row.id, row.mode]));
}

/** Stable key for comparing two collapsed views — used by the dirty check. */
export function periodModesKey(modes: Record<number, PeriodMode>): string {
  return JSON.stringify(
    Object.entries(modes)
      .map(([id, mode]) => [Number(id), mode] as const)
      .sort((a, b) => a[0] - b[0])
  );
}

/**
 * The `period_links` to PATCH.
 *
 * For a period the user left exactly as the dialog opened it, every original link is sent
 * back — including a second mode the control could not display. For a period the user
 * actually changed, their choice wins and replaces what was there, because that is an
 * edit they made deliberately.
 */
export function periodLinksToSave(
  original: PeriodLinkRow[],
  edited: Record<number, PeriodMode>
): PeriodLinkPayload[] {
  const originalByPeriod = new Map<number, PeriodMode[]>();
  for (const row of original) {
    originalByPeriod.set(row.id, [...(originalByPeriod.get(row.id) ?? []), row.mode]);
  }
  const opened = collapsePeriodLinks(original);
  const periodIds = new Set<number>([
    ...originalByPeriod.keys(),
    ...Object.keys(edited).map(Number),
  ]);

  const links: PeriodLinkPayload[] = [];
  for (const periodId of [...periodIds].sort((a, b) => a - b)) {
    const now = edited[periodId];
    const untouched = now === opened[periodId];
    const originalModes = originalByPeriod.get(periodId) ?? [];
    if (untouched && originalModes.length > 1) {
      for (const mode of originalModes) links.push({ periodId, mode });
      continue;
    }
    if (now) links.push({ periodId, mode: now });
  }
  return links;
}
