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

/** Validation failures callers may safely turn into an invalid-period verdict. */
export class PeriodWindowTypeError extends TypeError {}
export class PeriodWindowRangeError extends RangeError {}

function monthDay(month: number, day: number): number {
  return month * 100 + day;
}

function recurringInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value)) {
    throw new PeriodWindowTypeError(`${label} must be an integer`);
  }
  return value as number;
}

/** Return whether a value is a real calendar date in strict YYYY-MM-DD form. */
export function isIsoCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return !(
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]
  );
}

export function hasValidOneOffPeriodDates(period: {
  start_date?: unknown;
  end_date?: unknown;
}): boolean {
  return (
    isIsoCalendarDate(period.start_date) &&
    isIsoCalendarDate(period.end_date) &&
    period.start_date <= period.end_date
  );
}

function assertIsoCalendarDate(value: string | null, label: string): asserts value is string {
  if (!isIsoCalendarDate(value)) {
    throw new PeriodWindowRangeError(`${label} must be a valid YYYY-MM-DD calendar date`);
  }
}

/** Return whether a local YYYY-MM-DD date falls within a period, inclusively. */
export function periodContains(period: PeriodWindow, evaluationDate: string): boolean {
  assertIsoCalendarDate(evaluationDate, "evaluationDate");

  if (period.recurs_yearly) {
    const start = monthDay(
      recurringInteger(period.start_month, "period.start_month"),
      recurringInteger(period.start_day, "period.start_day")
    );
    const end = monthDay(
      recurringInteger(period.end_month, "period.end_month"),
      recurringInteger(period.end_day, "period.end_day")
    );
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
