/// <reference lib="dom" />
import { expectedColor, type DesignToken, type Theme } from './designTokens';
import { parseColor, type RGBA } from './wcag';

const UNRESOLVED = 'rgb(1, 2, 3)';
const UNRESOLVED_LENGTH = '1234px';

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

export function readColors(names: readonly string[]): Record<string, RGBA | null> {
  const unresolved = parseColor(UNRESOLVED);
  return Object.fromEntries(
    Object.entries(paintTokens(names)).map(([name, value]) => {
      const color = parseColor(value);
      return [name, sameColor(color, unresolved) ? null : color];
    }),
  );
}

export function readLengths(names: readonly string[]): Record<string, string | null> {
  const probe = document.createElement('span');
  document.body.appendChild(probe);
  try {
    return Object.fromEntries(
      names.map((name) => {
        probe.style.paddingLeft = `var(${name}, ${UNRESOLVED_LENGTH})`;
        const length = getComputedStyle(probe).paddingLeft;
        return [name, length === UNRESOLVED_LENGTH ? null : length];
      }),
    );
  } finally {
    probe.remove();
  }
}

export function sameColor(a: RGBA, b: RGBA): boolean {
  return a.every((c, i) => Math.abs((i === 3 ? 255 : 1) * (c - b[i])) <= 1 + 1e-9);
}

export function mismatchedTokens(
  names: readonly string[],
  painted: Readonly<Record<string, string>>,
  expected: readonly string[],
): string[] {
  return names.flatMap((name, i) =>
    sameColor(parseColor(painted[name]), parseColor(expected[i])) ? [] : [`${name} painted ${painted[name]}, expected ${expected[i]}`],
  );
}

export function offTable(names: readonly DesignToken[], theme: Theme): string[] {
  return mismatchedTokens(names, paintTokens(names), paintColors(names.map((name) => expectedColor(name, theme))));
}
