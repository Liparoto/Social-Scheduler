import {
  periodContains,
  PeriodWindowRangeError,
  PeriodWindowTypeError,
  type PeriodWindow,
} from "./periods";

export type LibraryLifecycleStatus = "draft" | "ready" | "retired";
export type LibrarySeasonStatus =
  | "Live"
  | "Dormant"
  | "Blocked"
  | "Invalid period"
  | "Draft"
  | "Retired";

export interface LibrarySeasonPeriod extends PeriodWindow {
  id: number;
  name: string;
  mode: "green" | "blackout";
}

export interface LibrarySeasonBadgeDetails {
  descriptionId: string;
  description: string;
  triggerProps: {
    type: "button";
    "aria-describedby": string;
  };
  tooltipProps: {
    id: string;
    role: "tooltip";
  };
}

/** Accessible explanation shared by the ready badge's hover and focus treatments. */
export function librarySeasonBadgeDetails(
  postId: number,
  status: LibrarySeasonStatus,
  evaluationDate: string,
  evaluationTimezone: string
): LibrarySeasonBadgeDetails {
  const context =
    `Advisory season status for ${evaluationDate} in ${evaluationTimezone}. ` +
    "The worker evaluates eligibility using each target channel's timezone.";
  const descriptionId = `post-${postId}-season-status-description`;
  const description =
    status === "Invalid period"
      ? `Invalid period configuration must be fixed. ${context}`
      : context;
  return {
    descriptionId,
    description,
    triggerProps: {
      type: "button",
      "aria-describedby": descriptionId,
    },
    tooltipProps: {
      id: descriptionId,
      role: "tooltip",
    },
  };
}

/** Advisory Library-card status for one explicit local calendar date. */
export function librarySeasonStatus(
  lifecycle: LibraryLifecycleStatus,
  periods: LibrarySeasonPeriod[],
  evaluationDate: string
): LibrarySeasonStatus {
  if (lifecycle === "draft") return "Draft";
  if (lifecycle === "retired") return "Retired";

  try {
    const blackouts = periods.filter((period) => period.mode === "blackout");
    if (blackouts.some((period) => periodContains(period, evaluationDate))) return "Blocked";

    const green = periods.filter((period) => period.mode === "green");
    if (green.length > 0 && !green.some((period) => periodContains(period, evaluationDate))) {
      return "Dormant";
    }
    return "Live";
  } catch (error) {
    if (error instanceof PeriodWindowTypeError || error instanceof PeriodWindowRangeError) {
      return "Invalid period";
    }
    throw error;
  }
}
