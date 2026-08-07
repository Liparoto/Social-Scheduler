/**
 * The emoji shape, and the search over a list of them.
 *
 * Deliberately free of the generated dataset: this module can be tested against a
 * three-item fixture instead of ~1,900 real entries, and the picker can lazy-load the data
 * without dragging a second copy of the search logic in with it.
 *
 * `Emoji` is declared HERE, in the module with no dependencies, and re-exported by the
 * generated emoji-data.ts. Declaring it in both would let the generated copy drift from the
 * one the picker compiles against.
 */
export interface Emoji {
  /** The emoji itself, e.g. "😀". */
  char: string;
  /** Unicode's name, lowercased, e.g. "grinning face". */
  name: string;
  /** Unicode group, e.g. "Smileys & Emotion". */
  group: string;
  /** Extra search terms that do not appear in the name, e.g. "tada" for 🎉. */
  keywords: string[];
}

/**
 * Emoji matching `query`, name matches first.
 *
 * Two bands rather than one flat filter: someone typing "triangle" means the emoji CALLED
 * triangle, not every emoji that merely lists it as a keyword. Within each band the input
 * order is preserved, which keeps the grid stable as you type.
 *
 * An empty query returns the input untouched so the caller can render the full grid without
 * a special case.
 */
export function searchEmoji(all: Emoji[], query: string): Emoji[] {
  const q = query.trim().toLowerCase();
  if (q === "") return all;

  const nameHits: Emoji[] = [];
  const keywordHits: Emoji[] = [];
  for (const e of all) {
    if (e.name.toLowerCase().includes(q)) nameHits.push(e);
    else if (e.keywords.some((k) => k.toLowerCase().includes(q))) keywordHits.push(e);
  }
  return [...nameHits, ...keywordHits];
}
