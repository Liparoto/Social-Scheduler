/**
 * The next slide index for a step of `delta`, clamped to the ends.
 *
 * Deliberately does not wrap. The ends of a carousel are meaningful — looping silently
 * from the last slide back to the first hides where you are in the sequence, which is
 * most of what the viewer is there to find out.
 *
 * Also clamps `current` itself, so an index left over from a longer list (the post lost a
 * slide while the lightbox was open) resolves to something in range instead of undefined.
 */
export function stepIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  const last = length - 1;
  // If current is already out of bounds, clamp it and return (don't step).
  if (current < 0 || current > last) {
    return Math.min(Math.max(current, 0), last);
  }
  // Current is in bounds, so apply the step and clamp the result.
  const next = current + delta;
  return Math.min(Math.max(next, 0), last);
}
