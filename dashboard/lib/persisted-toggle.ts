/**
 * A boolean that remembers itself in localStorage — the storage half, with no React in it.
 *
 * Deliberately free of any React import. The dashboard runs `lib/*.test.ts` under
 * `--conditions=react-server` (see package.json's `test` script), and under that condition
 * `react` resolves to a CommonJS build where `useSyncExternalStore` is not a named export — so
 * a lib module that imports React hooks cannot be unit-tested at all. Keeping the branching
 * logic here and the hook in components/use-persisted-toggle.ts means the part with real edge
 * cases is the part that gets tested.
 *
 * Every storage access is wrapped. A browser with storage disabled, or a private window that
 * throws on access, must degrade to the default rather than taking a page down over a
 * remembered panel state.
 */

// getSnapshot MUST return a stable value across calls or useSyncExternalStore re-renders
// forever. This cache is what makes that true — and it doubles as the in-session source of
// truth, so a write is visible to the very next read even if storage itself rejected it.
const cache = new Map<string, boolean>();
const listeners = new Set<() => void>();

/** Test seam: clears the memoised reads so each case starts clean. */
export function __resetPersistedToggleCacheForTests(): void {
  cache.clear();
}

export function readPersistedToggle(key: string, defaultOn: boolean): boolean {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let value = defaultOn;
  try {
    const raw = localStorage.getItem(key);
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      // Only an actual boolean counts. A corrupt or unexpected value falls through to the
      // default rather than reading as false, which would collapse a panel nobody collapsed.
      if (typeof parsed === "boolean") value = parsed;
    }
  } catch {
    // No storage, or unparseable contents — the default is the honest answer.
  }
  cache.set(key, value);
  return value;
}

export function writePersistedToggle(key: string, next: boolean): void {
  cache.set(key, next);
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Storage full or unavailable. The cache above still holds for this session, so the toggle
    // keeps working — it just will not survive a reload.
  }
  for (const l of listeners) l();
}

/** Subscribe to writes. Returns an unsubscribe function, as useSyncExternalStore expects. */
export function subscribePersistedToggle(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}
