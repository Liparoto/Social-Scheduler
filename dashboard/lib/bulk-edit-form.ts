import type { ContentKind, ContentStatus, PeriodLink, PeriodMode, Tag } from "./types";

export type BulkPeriodSelection = Record<number, PeriodMode> | PeriodLink[];

export interface BulkEditDraft {
  tagAdds: number[];
  tagRemoves: number[];
  periodAdds: BulkPeriodSelection;
  periodRemoves: BulkPeriodSelection;
  contentStatus: ContentStatus | "unchanged";
  contentKind: ContentKind | "unchanged";
  cooldownMode: "unchanged" | "default" | "custom";
  cooldownDays: number;
}

export interface BulkEditPayload {
  post_ids: number[];
  tags?: { add: number[]; remove: number[] };
  periods?: {
    add: PeriodLink[];
    remove: PeriodLink[];
  };
  content_status?: ContentStatus;
  content_kind?: ContentKind;
  cooldown_days?: number | null;
}

export function buildBulkEditPayload(postIds: number[], draft: BulkEditDraft): BulkEditPayload {
  const payload: BulkEditPayload = { post_ids: postIds };
  if (draft.tagAdds.length > 0 || draft.tagRemoves.length > 0) {
    payload.tags = { add: draft.tagAdds, remove: draft.tagRemoves };
  }
  const periodAdds = selectedPeriodLinks(draft.periodAdds);
  const periodRemoves = selectedPeriodLinks(draft.periodRemoves);
  if (periodAdds.length > 0 || periodRemoves.length > 0) {
    payload.periods = { add: periodAdds, remove: periodRemoves };
  }
  if (draft.contentStatus !== "unchanged") payload.content_status = draft.contentStatus;
  if (draft.contentKind !== "unchanged") payload.content_kind = draft.contentKind;
  if (draft.cooldownMode === "default") payload.cooldown_days = null;
  if (draft.cooldownMode === "custom") payload.cooldown_days = draft.cooldownDays;
  return payload;
}

function selectedPeriodLinks(selection: BulkPeriodSelection): PeriodLink[] {
  if (Array.isArray(selection)) return selection;
  return Object.entries(selection).map(([periodId, mode]) => ({
    periodId: Number(periodId),
    mode,
  }));
}

export function bulkEditChangeLabels(
  draft: BulkEditDraft,
  tags: Pick<Tag, "id" | "name">[],
  periods: { id: number; name: string }[]
): string[] {
  const labels: string[] = [];
  for (const [verb, ids] of [
    ["add", draft.tagAdds],
    ["remove", draft.tagRemoves],
  ] as const) {
    const names = ids
      .map((id) => tags.find((tag) => tag.id === id)?.name)
      .filter((name): name is string => !!name);
    if (names.length === 0) continue;
    labels.push(
      `${verb} tag${names.length === 1 ? "" : "s"} ${names.join(", ")}`
    );
  }
  for (const [verb, links] of [
    ["attach", draft.periodAdds],
    ["detach", draft.periodRemoves],
  ] as const) {
    for (const { periodId, mode } of selectedPeriodLinks(links)) {
      const name = periods.find((period) => period.id === periodId)?.name;
      if (name) labels.push(`${verb} ${name} as ${mode}`);
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
