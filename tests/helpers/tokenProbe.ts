/// <reference lib="dom" />
import { parseColor, type RGBA } from './wcag';

const UNRESOLVED = 'rgb(1, 2, 3)';

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

export function readColors(names: readonly string[]): Record<string, RGBA | null> {
  const unresolved = parseColor(UNRESOLVED);
  return Object.fromEntries(
    Object.entries(paintTokens(names)).map(([name, value]) => {
      const color = parseColor(value);
      return [name, sameColor(color, unresolved) ? null : color];
    }),
  );
}

export function sameColor(a: RGBA, b: RGBA): boolean {
  return a.every((c, i) => Math.abs((i === 3 ? 255 : 1) * (c - b[i])) <= 1 + 1e-9);
}
