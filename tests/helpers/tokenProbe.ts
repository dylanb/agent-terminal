/// <reference lib="dom" />
// Reads a token the way #245 plan R2 defines its value: the colour Chromium paints with
// `color: var(<token>)`. An undefined token paints UNRESOLVED instead of an empty or inherited value, so a
// missing token is a parseable colour that fails an `expect`, never a throw from `parseColor`
// (§28.5.3 counts only an AssertionError as a RED failure).
//
// paintTokens and paintColors are passed to Playwright's `page.evaluate`, which serializes the function
// source: neither may reference anything outside its own body, so the sentinel is spelled inline and
// pinned to UNRESOLVED by tests/browser/tokenProbe.test.ts.
import type { RGBA } from './wcag';

export const UNRESOLVED = 'rgb(1, 2, 3)';

/** Each token's painted colour, as Chromium serializes it, keyed by name. */
export function paintTokens(names: readonly string[]): Record<string, string> {
  const probe = document.createElement('span');
  document.body.appendChild(probe);
  try {
    return Object.fromEntries(
      names.map((name) => {
        probe.style.color = `var(${name}, rgb(1, 2, 3))`;
        return [name, getComputedStyle(probe).color];
      }),
    );
  } finally {
    probe.remove();
  }
}

/** Each CSS colour value as Chromium paints it: the expected side of a token comparison. */
export function paintColors(values: readonly string[]): string[] {
  const probe = document.createElement('span');
  document.body.appendChild(probe);
  try {
    return values.map((value) => {
      probe.style.color = value;
      return getComputedStyle(probe).color;
    });
  } finally {
    probe.remove();
  }
}

/** Equal within one 8-bit step per channel, alpha included. */
export function sameColor(a: RGBA, b: RGBA): boolean {
  return a.every((c, i) => Math.abs((i === 3 ? 255 : 1) * (c - b[i])) <= 1 + 1e-9);
}
