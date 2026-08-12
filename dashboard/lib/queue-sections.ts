/**
 * The queue's two halves: work still to come, and work that is over.
 *
 * The split already existed in the ORDER BY — upcoming ranks sort forward from now,
 * finished ones sort backward — but nothing on screen marked the boundary. In a long table
 * the direction quietly reversed partway down, which reads as a bug rather than a rule.
 *
 * The status list here is the SINGLE definition of "finished", shared with the ORDER BY in
 * getPublicationsOverview. If the two ever disagree, rows appear under the wrong heading —
 * a table that is confidently mislabelled, which is worse than one with no headings at all.
 * That is why the SQL builds its status lists from this constant instead of repeating them.
 */

/**
 * A send that is over: it went out, or it was abandoned. Nothing is waiting on it and
 * nothing more will happen to it.
 *
 * Everything else — scheduled, failed, publishing, pending_approval — is live work. Note
 * 'pending_approval' in particular: a send waiting on a human has not gone anywhere yet.
 * It used to fall into the ORDER BY's ELSE branch and sort down among posted sends, which
 * no one noticed only because no channel on this install requires approval.
 */
export const FINISHED_STATUSES = ["posted", "canceled"] as const;

/** SQL list for the same set, so the query cannot drift from the headings. */
export const FINISHED_STATUSES_SQL = FINISHED_STATUSES.map((s) => `'${s}'`).join(", ");

/**
 * Expressed as an explicit finished list rather than "not in the live list", so the
 * fallback points the safe way: a status added to the schema and forgotten here shows up
 * among live work, where it is visible and obviously out of place, instead of being filed
 * under Done where nobody would look for it again.
 */
export function isFinished(status: string): boolean {
  return (FINISHED_STATUSES as readonly string[]).includes(status);
}

export interface QueueSection<T> {
  /** Stable React key. */
  key: "unfinished" | "finished";
  title: string;
  /** Why this section reads the direction it does — shown beside the heading. */
  hint: string;
  rows: T[];
}

/**
 * Split sorted rows into their sections, preserving the order within each.
 *
 * Filtering rather than scanning for a boundary: the two halves are contiguous today
 * because of the ORDER BY, but relying on that would turn a future sort change into a
 * mislabelled table rather than a merely differently-ordered one.
 *
 * An empty section is dropped, so a queue of only posted sends gets no headings to
 * disagree with — and neither does the status filter when it narrows to one half.
 */
export function splitQueueSections<T extends { status: string }>(
  rows: T[]
): QueueSection<T>[] {
  const sections: QueueSection<T>[] = [
    {
      key: "unfinished",
      title: "In the queue",
      hint: "soonest first",
      rows: rows.filter((r) => !isFinished(r.status)),
    },
    {
      key: "finished",
      title: "Done",
      hint: "newest first",
      rows: rows.filter((r) => isFinished(r.status)),
    },
  ];
  return sections.filter((s) => s.rows.length > 0);
}
