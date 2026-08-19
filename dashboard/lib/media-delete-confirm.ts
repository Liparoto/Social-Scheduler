/**
 * What decides whether the media editor's "Delete the file entirely" button is offered, and
 * what it says when it isn't — pulled out of components/post-media-editor.tsx so it can be
 * unit-tested with node:test rather than resting on code inspection. This is the thing that
 * gates an irreversible action, so it earns its own tests the way lib/post-media-edit.ts's
 * server-side rules do (same split: pure and DB/DOM-free, one concern per module).
 *
 * Not a duplicate of lib/post-media-edit.ts's checkRemoveAsset(): that module is the
 * server's authority and re-checks everything inside its own transaction. This module only
 * decides whether to OFFER the button from an advisory GET — the server can still refuse
 * even when this says "go ahead", and that's fine (see deleteBlockState's fail-closed
 * handling of a stale or failed lookup).
 */

/** What GET /api/assets/[id]/usage?post_id=… reports — see that route for what each counts. */
export interface UsageCounts {
  otherPosts: number;
  sends: number;
  covers: number;
}

/**
 * Why "Delete the file entirely" can't be offered, as clauses that all read as the subject
 * of "Can't delete the file entirely — …" — deleteBlockState() joins whichever of these
 * apply into one sentence.
 *
 * Three independent reasons because they ARE independent: an asset can be on another post,
 * named by a queued or failed Story send, AND set as a Reel's cover, all at once, and the
 * dialog should say so rather than picking just one.
 */
export function deleteBlockReasons(u: UsageCounts): string[] {
  const reasons: string[] = [];
  if (u.otherPosts > 0) {
    reasons.push(
      u.otherPosts === 1 ? "another post uses it" : `${u.otherPosts} other posts use it`
    );
  }
  if (u.sends > 0) {
    reasons.push("a scheduled or failed send still references it");
  }
  if (u.covers > 0) {
    reasons.push("it's a Reel's cover image");
  }
  return reasons;
}

function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]}, and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

export interface DeleteBlockState {
  blocked: boolean;
  /** Always non-null when blocked is true — there is no "disabled for no stated reason". */
  message: string | null;
}

/**
 * The full decision the confirm dialog renders from: is "Delete the file entirely" offered,
 * and if not, why.
 *
 * Fail-closed on both edges of the lookup, deliberately: `usage === null` (still loading)
 * and a failed lookup are both treated as blocked, never as "assume it's clear". An unknown
 * answer isn't the same claim as "nothing else uses this" — defaulting either case to
 * "available" would let a network blip or a slow request silently offer a button that then
 * fails with a raw server error, or worse, briefly offer a truthful-looking button before
 * the real (blocking) answer arrives.
 */
export function deleteBlockState(usage: UsageCounts | null, usageError: boolean): DeleteBlockState {
  if (usageError) {
    return {
      blocked: true,
      message: "Couldn't check where else this file is used, so deleting it outright isn't offered here.",
    };
  }
  if (usage === null) {
    return { blocked: true, message: "Checking whether this file is used elsewhere…" };
  }
  const reasons = deleteBlockReasons(usage);
  if (reasons.length === 0) return { blocked: false, message: null };
  return { blocked: true, message: `Can't delete the file entirely — ${joinList(reasons)}.` };
}
