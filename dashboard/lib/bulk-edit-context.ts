export type CoverageState = "all" | "some" | "none";

export interface BulkEditContext {
  post_count: number;
  tags: { tag_id: number; count: number }[];
  periods: { period_id: number; mode: "green" | "blackout"; count: number }[];
  content_statuses: { value: "draft" | "ready" | "retired"; count: number }[];
  content_kinds: { value: "evergreen" | "one_time"; count: number }[];
  cooldowns: { value: number | null; count: number }[];
}

function normalizedCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function coverageState(count: number, total: number): CoverageState {
  const safeCount = normalizedCount(count);
  const safeTotal = normalizedCount(total);

  if (safeCount === 0) return "none";
  if (safeTotal === 0) return "some";
  return safeCount >= safeTotal ? "all" : "some";
}

export function coverageLabel(count: number, total: number): string {
  const safeCount = normalizedCount(count);
  const safeTotal = normalizedCount(total);
  const state = coverageState(safeCount, safeTotal);

  if (state === "none") return "None";
  if (safeTotal === 0) return "Some";
  if (state === "all") return `All ${safeTotal}`;
  return `${safeCount} of ${safeTotal}`;
}

export function removableIds(
  ids: number[],
  counts: Record<number, number>,
  total: number,
): number[] {
  return ids
    .map((id, index) => ({ id, index, count: normalizedCount(counts[id] ?? 0) }))
    .filter(({ count }) => count > 0)
    .sort((left, right) => {
      const leftIsFull = coverageState(left.count, total) === "all";
      const rightIsFull = coverageState(right.count, total) === "all";

      if (leftIsFull !== rightIsFull) return leftIsFull ? -1 : 1;
      return right.count - left.count || left.index - right.index;
    })
    .map(({ id }) => id);
}
