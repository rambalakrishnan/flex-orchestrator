/**
 * Clock (`src/lib/clock.ts`) — the injectable clock seam.
 *
 * Every production clock read in `src/` flows through this single function so
 * tests and recovery paths can substitute a deterministic clock without
 * patching `Date` or threading timestamps through unrelated modules.
 */

/** Returns the current epoch time in milliseconds. */
export function now(): number {
  return Date.now();
}