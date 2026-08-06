// The post editor's unsaved-changes guard, extracted from components/post-editor.tsx so it
// can be tested. It is pure — it imports only types — because the two things that consume it
// are both destructive-if-wrong:
//
//   1. "Post now" publishes whatever is SAVED in the database, not what is on screen.
//   2. "Split into separate posts" copies the SAVED row into every new post it creates.
//
// Both read from the database, so an editor with unsaved changes silently acts on stale
// values. This function is what stops that, and a field missing from it is a field the guard
// lies about — see the content_kind/cooldown_days gap this file was extracted to close.

import type { ContentKind, ContentStatus, PostTarget } from "./types";

export interface DirtyCheckInput {
  captions: { platform: string; body: string }[];
  initialCaptions: { platform: string; body: string }[];
  targets: PostTarget[];
  initialTargets: PostTarget[];
  tagIds: number[];
  initialTagIds: number[];
  status: ContentStatus;
  initialStatus: ContentStatus;
  kind: ContentKind;
  initialKind: ContentKind;
  /** Raw editor string. "" means "use the channel default" — same as a null column. */
  cooldown: string;
  initialCooldownDays: number | null;
  /** Raw editor string; "" (or whitespace) means no first comment, same as a null column. */
  firstComment: string;
  initialFirstComment: string | null;
}

/** Stable comparable form of a target set — channel AND surface, order-independent. */
export function targetKeys(targets: PostTarget[]): string[] {
  return targets.map((t) => `${t.channel_id}:${t.surface}`).sort();
}

/** Captions as save() would send them: empties dropped, bodies trimmed, "" platform → null. */
function normalizedCaptions(list: { platform: string; body: string }[]): string {
  return JSON.stringify(
    list
      .filter((v) => v.body.trim())
      .map((v) => ({ platform: v.platform || null, body: v.body.trim() }))
  );
}

/**
 * The cooldown override as save() would send it: `cooldown_days: cooldown.trim() === ""
 * ? null : Number(cooldown)`. Kept identical on purpose — the editor holds a string and the
 * column holds `number | null`, so comparing them raw would report every post that has a
 * cooldown set as permanently dirty.
 */
function normalizedCooldown(cooldown: string): number | null {
  return cooldown.trim() === "" ? null : Number(cooldown);
}

/** The first comment as save() sends it: trimmed, and empty collapsed to null. */
function normalizedFirstComment(value: string | null): string | null {
  return value?.trim() || null;
}

export function isPostDirty(input: DirtyCheckInput): boolean {
  return (
    normalizedCaptions(input.captions) !== normalizedCaptions(input.initialCaptions) ||
    JSON.stringify(targetKeys(input.targets)) !==
      JSON.stringify(targetKeys(input.initialTargets)) ||
    JSON.stringify([...input.tagIds].sort((a, b) => a - b)) !==
      JSON.stringify([...input.initialTagIds].sort((a, b) => a - b)) ||
    input.status !== input.initialStatus ||
    // content_kind and cooldown_days are both persisted by save() and both copied into
    // every new post by unmergeCarousel, so leaving them out made the guard lie about
    // exactly the fields a split silently carries over.
    input.kind !== input.initialKind ||
    normalizedCooldown(input.cooldown) !== input.initialCooldownDays ||
    // The first comment goes out with the post, so an unsaved edit to it is exactly the
    // kind of staleness this guard exists for: "Post now" would publish the old hashtags.
    normalizedFirstComment(input.firstComment) !==
      normalizedFirstComment(input.initialFirstComment)
  );
}
