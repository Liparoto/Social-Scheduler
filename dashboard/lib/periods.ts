/** Date fields needed to evaluate a recurring or one-off period. */
export interface PeriodWindow {
  recurs_yearly: boolean | 0 | 1;
  start_month: number | null;
  start_day: number | null;
  end_month: number | null;
  end_day: number | null;
  start_date: string | null;
  end_date: string | null;
}

function monthDay(month: number, day: number): number {
  return month * 100 + day;
}

/** Return whether a local YYYY-MM-DD date falls within a period, inclusively. */
export function periodContains(period: PeriodWindow, evaluationDate: string): boolean {
  if (period.recurs_yearly) {
    const start = monthDay(period.start_month!, period.start_day!);
    const end = monthDay(period.end_month!, period.end_day!);
    const current = monthDay(
      Number(evaluationDate.slice(5, 7)),
      Number(evaluationDate.slice(8, 10))
    );

    if (start <= end) {
      return start <= current && current <= end;
    }
    return current >= start || current <= end;
  }

  return period.start_date! <= evaluationDate && evaluationDate <= period.end_date!;
}

/** Derive the local YYYY-MM-DD date for an explicit instant and IANA timezone. */
export function localDate(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)!.value;

  return `${value("year")}-${value("month")}-${value("day")}`;
}

/** Blackout wins; otherwise at least one green must match when green periods exist. */
export function inSeason(
  green: PeriodWindow[],
  blackout: PeriodWindow[],
  evaluationDate: string
): boolean {
  if (blackout.some((period) => periodContains(period, evaluationDate))) {
    return false;
  }
  if (green.length > 0 && !green.some((period) => periodContains(period, evaluationDate))) {
    return false;
  }
  return true;
}
