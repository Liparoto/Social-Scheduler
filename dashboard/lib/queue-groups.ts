/**
 * Group the Overview queue so the slides of one Story read as one thing.
 *
 * A 4-slide post aimed at Stories becomes 4 independent publications — that independence is
 * the point (each retries and fails on its own), but as 4 undifferentiated rows it reads as
 * four unrelated sends, and cancelling the lot is four separate two-click confirms.
 *
 * Grouping is PRESENTATION ONLY. The individual publications stay authoritative: each keeps
 * its own status, actions and metrics. The group adds a heading and a bulk cancel.
 */

/** The fields grouping needs. Structural, so tests don't have to build a whole row. */
export interface GroupableRow {
  id: number;
  post_id: number;
  channel_id: number;
  surface: string;
  scheduled_at: string;
  status: string;
}

export interface QueueGroup<T> {
  /** Stable React key. */
  key: string;
  /** True when this is a multi-slide Story worth a heading and a bulk action. */
  isStoryGroup: boolean;
  rows: T[];
}

/**
 * Siblings are story sends of the SAME post, to the SAME channel, at the SAME time — which
 * is exactly what one fan-out produces. Scheduling the same post to Stories twice (say, a
 * morning and an evening slot) correctly yields two separate groups.
 *
 * Order is preserved: the caller's sort is the display order, and a group appears where its
 * FIRST row appeared, so grouping never reorders the queue.
 *
 * A lone story send is not a group — it has nothing to be grouped with, and a heading over a
 * single row is noise.
 */
export function groupQueueRows<T extends GroupableRow>(rows: T[]): QueueGroup<T>[] {
  const groups: QueueGroup<T>[] = [];
  const byKey = new Map<string, QueueGroup<T>>();

  for (const row of rows) {
    if (row.surface !== "story") {
      groups.push({ key: `pub-${row.id}`, isStoryGroup: false, rows: [row] });
      continue;
    }
    const key = `story-${row.post_id}-${row.channel_id}-${row.scheduled_at}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    const group: QueueGroup<T> = { key, isStoryGroup: true, rows: [row] };
    byKey.set(key, group);
    groups.push(group);
  }

  // A single story send gets no heading — isStoryGroup means "several slides, one Story".
  for (const g of groups) {
    if (g.isStoryGroup && g.rows.length < 2) g.isStoryGroup = false;
  }
  return groups;
}

/** Publications in a group that can still be canceled — drives the bulk action. */
export function cancelableIds(rows: GroupableRow[]): number[] {
  return rows
    .filter((r) => r.status === "scheduled" || r.status === "pending_approval")
    .map((r) => r.id);
}
