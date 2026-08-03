import type { ContentKind, ContentStatus, PeriodMode, Tag } from "./types";

export interface BulkEditDraft {
  tagAction: "add" | "remove";
  tagIds: number[];
  periodAction: "add" | "remove";
  periodModes: Record<number, PeriodMode>;
  contentStatus: ContentStatus | "unchanged";
  contentKind: ContentKind | "unchanged";
  cooldownMode: "unchanged" | "default" | "custom";
  cooldownDays: number;
}

export interface BulkEditPayload {
  post_ids: number[];
  tags?: { add: number[]; remove: number[] };
  periods?: {
    add: { periodId: number; mode: PeriodMode }[];
    remove: { periodId: number; mode: PeriodMode }[];
  };
  content_status?: ContentStatus;
  content_kind?: ContentKind;
  cooldown_days?: number | null;
}

export function buildBulkEditPayload(postIds: number[], draft: BulkEditDraft): BulkEditPayload {
  const payload: BulkEditPayload = { post_ids: postIds };
  if (draft.tagIds.length > 0) {
    payload.tags = {
      add: draft.tagAction === "add" ? draft.tagIds : [],
      remove: draft.tagAction === "remove" ? draft.tagIds : [],
    };
  }
  const periodLinks = Object.entries(draft.periodModes).map(([periodId, mode]) => ({
    periodId: Number(periodId),
    mode,
  }));
  if (periodLinks.length > 0) {
    payload.periods = {
      add: draft.periodAction === "add" ? periodLinks : [],
      remove: draft.periodAction === "remove" ? periodLinks : [],
    };
  }
  if (draft.contentStatus !== "unchanged") payload.content_status = draft.contentStatus;
  if (draft.contentKind !== "unchanged") payload.content_kind = draft.contentKind;
  if (draft.cooldownMode === "default") payload.cooldown_days = null;
  if (draft.cooldownMode === "custom") payload.cooldown_days = draft.cooldownDays;
  return payload;
}

export function bulkEditChangeLabels(
  draft: BulkEditDraft,
  tags: Pick<Tag, "id" | "name">[],
  periods: { id: number; name: string }[]
): string[] {
  const tagNames = draft.tagIds
    .map((id) => tags.find((tag) => tag.id === id)?.name)
    .filter((name): name is string => !!name);
  const labels: string[] = [];
  if (tagNames.length > 0) {
    labels.push(
      `${draft.tagAction === "add" ? "add" : "remove"} tag${tagNames.length === 1 ? "" : "s"} ${tagNames.join(", ")}`
    );
  }
  for (const [periodId, mode] of Object.entries(draft.periodModes)) {
    const name = periods.find((period) => period.id === Number(periodId))?.name;
    if (name) {
      labels.push(`${draft.periodAction === "add" ? "attach" : "detach"} ${name} as ${mode}`);
    }
  }
  if (draft.contentStatus !== "unchanged") {
    labels.push(`set status to ${draft.contentStatus}`);
  }
  if (draft.contentKind !== "unchanged") {
    labels.push(`set kind to ${draft.contentKind === "one_time" ? "one-time" : "evergreen"}`);
  }
  if (draft.cooldownMode === "default") labels.push("clear cooldown to channel default");
  if (draft.cooldownMode === "custom") {
    labels.push(`set cooldown to ${draft.cooldownDays} day${draft.cooldownDays === 1 ? "" : "s"}`);
  }
  return labels;
}
