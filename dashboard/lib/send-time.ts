/**
 * Which timestamp a send should show, and whether it is the real one.
 *
 * `scheduled_at` is an intention; `published_at` is what happened. The queue used to show
 * the intention for every row, so a send delayed by a sleeping Mac or a dead tunnel still
 * displayed its original slot and looked punctual. Once a send is out, the honest answer
 * is when it actually went.
 *
 * Shared by the Overview queue and the per-post sends panel so the two cannot drift into
 * telling different stories about the same send.
 */

/** Below this, "late" is just the poll interval and is not worth reporting. */
const LATE_THRESHOLD_MINUTES = 5;

export interface SendTime {
  /** The timestamp to render. */
  iso: string;
  /** True when `iso` is the recorded publish time rather than the planned one. */
  actual: boolean;
  /** Whole minutes later than planned, or null when punctual, early, or not yet out. */
  lateMinutes: number | null;
}

export function sendTime(p: {
  status: string;
  scheduled_at: string;
  published_at: string | null;
}): SendTime {
  // Only 'posted' has a real answer. 'publishing' has not been accepted by the platform
  // yet, and a failed or scheduled row never was — for those the due time is the only
  // thing that is true.
  if (p.status !== "posted" || !p.published_at) {
    return { iso: p.scheduled_at, actual: false, lateMinutes: null };
  }

  const planned = Date.parse(p.scheduled_at);
  const went = Date.parse(p.published_at);
  // An unparseable date must not turn into a nonsense duration; still show the real time.
  if (!Number.isFinite(planned) || !Number.isFinite(went)) {
    return { iso: p.published_at, actual: true, lateMinutes: null };
  }

  const minutes = Math.floor((went - planned) / 60_000);
  return {
    iso: p.published_at,
    actual: true,
    lateMinutes: minutes >= LATE_THRESHOLD_MINUTES ? minutes : null,
  };
}

/** "1 h 50 m late", "19 h late", "12 m late" — compact enough for a table cell. */
export function formatLateness(minutes: number): string {
  if (minutes < 60) return `${minutes} m late`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} h ${rest} m late` : `${hours} h late`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} d ${restHours} h late` : `${days} d late`;
}
