import { afterEach, describe, expect, it } from 'vitest';
import '../helpers/rendererTokens';
import {
  EXISTING_TOKENS,
  STATUSES,
  STATUS_TOKENS,
  expectedColor,
  type DesignToken,
  type ExistingToken,
  type Status,
  type StatusToken,
  type Theme,
} from '../helpers/designTokens';
import { UNRESOLVED, mismatchedTokens, paintColors, paintTokens, sameColor } from '../helpers/tokenProbe';
import { compositeOver, contrastRatio, parseColor, type RGBA } from '../helpers/wcag';
import { hslHue, hueDistance } from '../helpers/colorHue';

const html = document.documentElement;
const THEMES: readonly Theme[] = ['light', 'dark'];
const EXISTING = Object.keys(EXISTING_TOKENS) as ExistingToken[];
const STATUS = Object.keys(STATUS_TOKENS) as StatusToken[];
const NEEDS_HUMAN = [
  '--status-needs-human',
  '--status-needs-human-text',
  '--status-needs-human-tint',
  '--status-needs-human-border',
] as const satisfies readonly StatusToken[];
const REVEAL = ['--reveal', '--reveal-wash'] as const satisfies readonly ExistingToken[];
const BORDERED = [
  ['error', '--status-error-border'],
  ['needs-human', '--status-needs-human-border'],
] as const satisfies readonly (readonly [Status, StatusToken])[];
const HUED: readonly Status[] = ['error', 'needs-human', 'working', 'completed'];

const accent = (s: Status): StatusToken => `--status-${s}`;
const text = (s: Status): StatusToken => `--status-${s}-text`;
const tint = (s: Status): StatusToken => `--status-${s}-tint`;

function useTheme(theme: Theme): void {
  if (theme === 'dark') html.setAttribute('data-theme', 'dark');
  else html.removeAttribute('data-theme');
}

afterEach(() => {
  html.removeAttribute('data-theme');
  html.removeAttribute('style');
});

/** Each token that does not paint its table value in `theme`. */
function offTable(names: readonly DesignToken[], theme: Theme): string[] {
  return mismatchedTokens(names, paintTokens(names), paintColors(names.map((name) => expectedColor(name, theme))));
}

/** Each token's painted colour, or null when nothing defines it: an undefined token has no colour to grade. */
function painted(names: readonly string[]): Record<string, RGBA | null> {
  const unresolved = parseColor(UNRESOLVED);
  return Object.fromEntries(
    Object.entries(paintTokens(names)).map(([name, value]) => {
      const color = parseColor(value);
      return [name, sameColor(color, unresolved) ? null : color];
    }),
  );
}

/** Grades `check` over the named colours, or names the ones that are undefined. */
function grade<N extends string>(
  colors: Record<string, RGBA | null>,
  names: readonly N[],
  check: (c: Record<N, RGBA>) => string | null,
): string[] {
  const missing = names.filter((name) => colors[name] === null);
  if (missing.length > 0) return missing.map((name) => `${name} is undefined`);
  const verdict = check(colors as Record<N, RGBA>);
  return verdict === null ? [] : [verdict];
}

describe.each(THEMES)('tokens.css alone, %s theme', (theme) => {
  it('resolves every existing colour token to its table value', () => {
    useTheme(theme);
    expect(offTable(EXISTING, theme)).toEqual([]);
  });

  it('resolves every status token to its table value', () => {
    useTheme(theme);
    expect(offTable(STATUS, theme)).toEqual([]);
  });

  it('makes each aliased status token follow its target', () => {
    useTheme(theme);
    const aliased = STATUS.flatMap((name) => {
      const target = STATUS_TOKENS[name].alias;
      return target === undefined ? [] : [{ name, target }];
    });
    const targets = [...new Set(aliased.map(({ target }) => target))];
    targets.forEach((target, i) => html.style.setProperty(target, `rgb(7, 77, ${20 + 20 * i})`));
    const overrides = aliased.map(({ target }) => html.style.getPropertyValue(target));
    const names = aliased.map(({ name }) => name);
    expect(mismatchedTokens(names, paintTokens(names), paintColors(overrides))).toEqual([]);
  });

  it('keeps the needs-human tokens when --reveal and --reveal-wash change', () => {
    useTheme(theme);
    html.style.setProperty('--reveal', 'rgb(9, 99, 199)');
    html.style.setProperty('--reveal-wash', 'rgba(9, 99, 199, 0.5)');
    expect(offTable(NEEDS_HUMAN, theme)).toEqual([]);
  });

  it('keeps --reveal and --reveal-wash when any needs-human token changes', () => {
    useTheme(theme);
    const moved = NEEDS_HUMAN.flatMap((changed) => {
      html.style.setProperty(changed, 'rgb(9, 99, 199)');
      const off = offTable(REVEAL, theme).map((m) => `after changing ${changed}: ${m}`);
      html.style.removeProperty(changed);
      return off;
    });
    expect(moved).toEqual([]);
  });

  it('gives each border a hue within 15° of its accent', () => {
    useTheme(theme);
    const colors = painted(BORDERED.flatMap(([status, border]) => [accent(status), border]));
    const violations = BORDERED.flatMap(([status, border]) =>
      grade(colors, [accent(status), border], (c) => {
        const distance = hueDistance(hslHue(c[border]), hslHue(c[accent(status)]));
        return distance <= 15 ? null : `${border} is ${distance}° from ${accent(status)}`;
      }),
    );
    expect(violations).toEqual([]);
  });

  it('paints each border visibly over the card', () => {
    useTheme(theme);
    const colors = painted(['--card', ...BORDERED.map(([, border]) => border)]);
    const violations = BORDERED.flatMap(([, border]) =>
      grade(colors, ['--card', border], (c) =>
        sameColor(compositeOver(c[border], c['--card']), c['--card']) ? `${border} paints as the card` : null,
      ),
    );
    expect(violations).toEqual([]);
  });

  it('gives the needs-human accent and text an amber hue, 30° to 50°', () => {
    useTheme(theme);
    const names = ['--status-needs-human', '--status-needs-human-text'] as const;
    const colors = painted(names);
    const violations = names.flatMap((name) =>
      grade(colors, [name], (c) => {
        const hue = hslHue(c[name]);
        return hue >= 30 && hue <= 50 ? null : `${name} has hue ${hue}°`;
      }),
    );
    expect(violations).toEqual([]);
  });

  it('gives each status tint a hue within 15° of its accent', () => {
    useTheme(theme);
    const colors = painted(HUED.flatMap((s) => [accent(s), tint(s)]));
    const violations = HUED.flatMap((s) =>
      grade(colors, [accent(s), tint(s)], (c) => {
        const distance = hueDistance(hslHue(c[tint(s)]), hslHue(c[accent(s)]));
        return distance <= 15 ? null : `${tint(s)} is ${distance}° from ${accent(s)}`;
      }),
    );
    expect(violations).toEqual([]);
  });

  it('paints each status tint visibly over the card', () => {
    useTheme(theme);
    const colors = painted(['--card', ...STATUSES.map(tint)]);
    const violations = STATUSES.flatMap((s) =>
      grade(colors, ['--card', tint(s)], (c) =>
        sameColor(compositeOver(c[tint(s)], c['--card']), c['--card']) ? `${tint(s)} paints as the card` : null,
      ),
    );
    expect(violations).toEqual([]);
  });

  it('gives each status text 4.5:1 on the card and on its painted tint', () => {
    useTheme(theme);
    const colors = painted(['--card', ...STATUSES.flatMap((s) => [text(s), tint(s)])]);
    const violations = STATUSES.flatMap((s) =>
      grade(colors, ['--card', text(s), tint(s)], (c) => {
        const card = c['--card'];
        const tinted = compositeOver(c[tint(s)], card);
        const onCard = contrastRatio(compositeOver(c[text(s)], card), card);
        const onTint = contrastRatio(compositeOver(c[text(s)], tinted), tinted);
        return onCard >= 4.5 && onTint >= 4.5 ? null : `${text(s)} is ${onCard.toFixed(2)}:1 on the card, ${onTint.toFixed(2)}:1 on ${tint(s)}`;
      }),
    );
    expect(violations).toEqual([]);
  });

  it('gives each status accent 3:1 on the card', () => {
    useTheme(theme);
    const colors = painted(['--card', ...STATUSES.map(accent)]);
    const violations = STATUSES.flatMap((s) =>
      grade(colors, ['--card', accent(s)], (c) => {
        const ratio = contrastRatio(compositeOver(c[accent(s)], c['--card']), c['--card']);
        return ratio >= 3 ? null : `${accent(s)} is ${ratio.toFixed(2)}:1 on the card`;
      }),
    );
    expect(violations).toEqual([]);
  });
});
