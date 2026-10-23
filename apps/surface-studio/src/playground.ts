import { useSyncExternalStore } from "react";

/**
 * An IR document dropped into the Playground.
 *
 * Module-level rather than component state because the route changes as tabs
 * switch, which unmounts the page — and a 3MB document must survive that
 * without being re-read from disk. In memory only: the IR can be large and it
 * is the user's file, not ours to keep.
 */
interface Dropped {
  name: string;
  ir: unknown;
  key: string;
}

let current: Dropped | null = null;
const listeners = new Set<() => void>();

export function setDropped(name: string, ir: unknown): void {
  current = { name, ir, key: `inline:${name}:${Date.now()}` };
  for (const l of listeners) l();
}

export function clearDropped(): void {
  current = null;
  for (const l of listeners) l();
}

export function useDropped(): Dropped | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
