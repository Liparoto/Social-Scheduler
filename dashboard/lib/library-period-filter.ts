export interface PeriodLink {
  id: number;
}

export function matchesPeriodFilter(periods: PeriodLink[], selected: Set<number>): boolean {
  return selected.size === 0 || periods.some((period) => selected.has(period.id));
}
