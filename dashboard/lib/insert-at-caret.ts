/**
 * Splice `insert` into `text` at the caret (or over the selection), and report where the
 * caret should land afterwards.
 *
 * Pure, and deliberately separate from the picker component, because this is the part that
 * goes wrong: appending to the end is the obvious implementation and is incorrect for anyone
 * editing the middle of a caption. Keeping it here means it is tested directly rather than
 * through a DOM.
 *
 * The returned caret is in UTF-16 code units, which is what
 * HTMLTextAreaElement.setSelectionRange expects — an emoji moves it by 2, not 1. This is the
 * same unit captionLength() counts in, for the same underlying reason.
 */
export function insertAtCaret(
  text: string,
  insert: string,
  start: number,
  end: number
): { text: string; caret: number } {
  const next = text.slice(0, start) + insert + text.slice(end);
  return { text: next, caret: start + insert.length };
}
