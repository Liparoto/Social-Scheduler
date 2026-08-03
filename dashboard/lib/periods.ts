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

function assertIsoCalendarDate(value: string | null, label: string): asserts value is string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!match) {
    throw new RangeError(`${label} must be a valid YYYY-MM-DD calendar date`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
    throw new RangeError(`${label} must be a valid YYYY-MM-DD calendar date`);
  }
}

/** Return whether a local YYYY-MM-DD date falls within a period, inclusively. */
export function periodContains(period: PeriodWindow, evaluationDate: string): boolean {
  assertIsoCalendarDate(evaluationDate, "evaluationDate");

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

  assertIsoCalendarDate(period.start_date, "period.start_date");
  assertIsoCalendarDate(period.end_date, "period.end_date");
  return period.start_date <= evaluationDate && evaluationDate <= period.end_date;
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
  assertIsoCalendarDate(evaluationDate, "evaluationDate");

  if (blackout.some((period) => periodContains(period, evaluationDate))) {
    return false;
  }
  if (green.length > 0 && !green.some((period) => periodContains(period, evaluationDate))) {
    return false;
  }
  return true;
}
