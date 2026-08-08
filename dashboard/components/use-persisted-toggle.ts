"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  readPersistedToggle,
  subscribePersistedToggle,
  writePersistedToggle,
} from "@/lib/persisted-toggle";

/**
 * A boolean that remembers itself in localStorage.
 *
 * Built on useSyncExternalStore rather than useState plus a mount effect, for two reasons that
 * both already bit this codebase:
 *
 *  - The server cannot know what this browser last chose, so reading storage during render
 *    guarantees a hydration mismatch. `getServerSnapshot` returns the default instead, and the
 *    client corrects on hydration. Same shape as components/emoji-hint.tsx.
 *  - Calling setState synchronously inside an effect triggers a cascading render, and the lint
 *    rule that catches it is an error in this project, not a warning.
 *
 * Lives in components/ rather than lib/ because it imports React: `lib/*.test.ts` runs under
 * `--conditions=react-server`, where `react` is CommonJS and `useSyncExternalStore` is not a
 * named export. The storage logic it wraps lives in lib/persisted-toggle.ts and is unit-tested
 * there; this file is covered by browser verification.
 */
export function usePersistedToggle(
  key: string,
  defaultOn: boolean
): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(
    subscribePersistedToggle,
    () => readPersistedToggle(key, defaultOn),
    () => defaultOn
  );
  const set = useCallback((next: boolean) => writePersistedToggle(key, next), [key]);
  return [value, set];
}
