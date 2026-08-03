import { periodContains, type PeriodWindow } from "./periods";

export type LibraryLifecycleStatus = "draft" | "ready" | "retired";
export type LibrarySeasonStatus = "Live" | "Dormant" | "Blocked" | "Draft" | "Retired";

export interface LibrarySeasonPeriod extends PeriodWindow {
  id: number;
  name: string;
  mode: "green" | "blackout";
}

/** Advisory Library-card status for one explicit local calendar date. */
export function librarySeasonStatus(
  lifecycle: LibraryLifecycleStatus,
  periods: LibrarySeasonPeriod[],
  evaluationDate: string
): LibrarySeasonStatus {
  if (lifecycle === "draft") return "Draft";
  if (lifecycle === "retired") return "Retired";

  const blackouts = periods.filter((period) => period.mode === "blackout");
  if (blackouts.some((period) => periodContains(period, evaluationDate))) return "Blocked";

  const green = periods.filter((period) => period.mode === "green");
  if (green.length > 0 && !green.some((period) => periodContains(period, evaluationDate))) {
    return "Dormant";
  }
  return "Live";
}
