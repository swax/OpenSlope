/**
 * The shared verdict for checks that COUNT rather than throw.
 *
 * Most files under `test/` are straight-line scripts: each `check` prints one `ok`/`FAIL` line and the file
 * exits non-zero at its end if anything failed, so one run reports every broken claim rather than the first.
 * Each file used to carry its own four-line copy of that helper over its own `let failures = 0`; this is the
 * one copy. `failures` is a live binding — import it and read it at exit, as `meshops.fixture.ts` always did —
 * so a file's tail stays `process.exit(failures ? 1 : 0)` or `if (failures) process.exitCode = 1`.
 *
 *   import { check, failures } from './check';
 *   check(actual === expected, 'what should hold');
 *   if (failures) process.exitCode = 1;
 *
 * Checks written against `node:assert` are the other convention in this directory and are not this module's
 * business: they stop at the first failed claim, which is right when the later claims depend on it.
 */

/** Failed checks so far in this process. Read it at exit; only `check` and `recordFailure` write it. */
export let failures = 0;

/**
 * Print one verdict line and count a failure. Never throws, so the file's later checks still run. `detail` is
 * the observed value, for a FAIL line that says by how much rather than only that.
 */
export function check(condition: unknown, label: string, detail = ''): void {
  const line = detail ? `${label} — ${detail}` : label;
  if (condition) console.log(`ok   ${line}`);
  else { failures++; console.error(`FAIL ${line}`); }
}

/** Count a failure found outside a `check` — typically an error caught around a block of them. */
export function recordFailure(): void {
  failures++;
}

/** The throwing form, for a claim that makes everything after it meaningless when false. Narrows `condition`. */
export function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
  console.log(`ok   ${message}`);
}

/** Absolute closeness, for floats that went through a transform. */
export const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

/** `check` for a float, with both numbers on the line so a miss says by how much. */
export function checkNear(actual: number, expected: number, label: string, epsilon = 1e-6): void {
  check(near(actual, expected, epsilon), `${label} (got ${actual}, want ${expected})`);
}
