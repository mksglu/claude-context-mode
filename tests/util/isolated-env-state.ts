/**
 * Shared mutable state for the test isolation helper.
 *
 * `tests/setup-home.ts` installs `vi.mock("node:os")` which reads `homedir()`
 * and `tmpdir()` from this module. `withIsolatedEnv()` writes the active fake
 * HOME here so the mock returns the current value, and `restore()` reverts it.
 *
 * Kept as its own tiny module so the os mock can import it without pulling in
 * the rest of `isolated-env.ts` (and the cycle / hoisting headaches that
 * implies).
 */

let activeFakeHome: string | undefined;

export function setActiveFakeHome(value: string | undefined): void {
  activeFakeHome = value;
}

export function getActiveFakeHome(): string | undefined {
  return activeFakeHome;
}
