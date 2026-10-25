import { page } from 'vitest/browser';
import { afterEach, describe, expect, it } from 'vitest';
import '../helpers/rendererTokens';
import '../../src/renderer/src/styles.css';
import { INSTALLED_APP_NAMES, STARTUP_CARD, STARTUP_CARD_READING_ORDER } from '../helpers/startupCard';
import { VERSION_MESSAGE, cardTextElement, mountStartupScreen, showVersionMessage, unmountStartupScreen } from '../helpers/startupScreen';
import { EXISTING_TOKEN_NAMES, STATUS_TOKEN_NAMES, expectedColor, type Theme } from '../helpers/designTokens';
import { paintColors, sameColor } from '../helpers/tokenProbe';
import { compositeOver, contrastRatio, parseColor, ringOver, type RGBA } from '../helpers/wcag';

const THEMES = ['light', 'dark'] as const satisfies readonly Theme[];
const APP_FAMILIES = ['IBM Plex Sans', 'Fraunces', 'IBM Plex Mono'];
const WIDE = { width: 1280, height: 896 };
const SHORT = { width: 1280, height: 160 };
const NARROW = { width: 320, height: 640 };

afterEach(async () => {
  unmountStartupScreen();
  delete document.documentElement.dataset.theme;
  await page.viewport(WIDE.width, WIDE.height);
});

type Card = {
  screen: HTMLElement;
  card: HTMLElement;
  texts: HTMLElement[];
  inked: HTMLElement[];
  appNames: HTMLElement[];
  marker: HTMLElement | null;
};

function ownsText(el: HTMLElement): boolean {
  return !el.closest('[aria-hidden="true"]') && [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
}

function locate(screen: HTMLElement, wanted: readonly string[]): Map<string, HTMLElement> {
  const found = new Map<string, HTMLElement>();
  for (const text of wanted) {
    try {
      found.set(text, cardTextElement(screen, text));
    } catch {
      continue;
    }
  }
  expect.soft(wanted.filter((text) => !found.has(text)), 'card text the wait screen does not carry').toEqual([]);
  return found;
}

function mountCard(theme: Theme, { versionMessage = false } = {}): Card {
  document.documentElement.dataset.theme = theme;
  const screen = mountStartupScreen();
  if (versionMessage) showVersionMessage(screen);
  const texts = locate(screen, [...STARTUP_CARD_READING_ORDER, ...(versionMessage ? [VERSION_MESSAGE] : [])]);
  const appNames = [...locate(screen, INSTALLED_APP_NAMES).values()];
  const located = [...texts.values()];
  const unrendered = [...located, ...appNames].filter((el) => ![...el.getClientRects()].some((r) => r.width > 0 && r.height > 0));
  expect.soft(unrendered.map(describeEl), 'located card text that is not rendered').toEqual([]);
  let common = located[0] ?? screen;
  while (common !== screen && !located.every((el) => common.contains(el))) common = common.parentElement ?? screen;
  let card = common;
  while (card !== screen && !opaque(card)) card = card.parentElement ?? screen;
  if (!opaque(card)) card = common;
  const statusLine = texts.get(STARTUP_CARD.statusLine);
  const statusRegion = statusLine?.closest<HTMLElement>('[role="status"]') ?? statusLine;
  const markers = statusRegion
    ? [...statusRegion.querySelectorAll<HTMLElement>('[aria-hidden="true"]')].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
    : [];
  expect.soft(markers,'painted aria-hidden markers inside the status line').toHaveLength(1);
  const inked = [card, ...card.querySelectorAll<HTMLElement>('*')].filter(ownsText);
  return { screen, card, texts: [...located, ...appNames], inked, appNames, marker: markers[0] ?? null };
}

const color = (value: string): RGBA => parseColor(value);
const visible = (c: RGBA) => c[3] > 0;
const opaque = (el: Element) => color(getComputedStyle(el).backgroundColor)[3] === 1;

function paints(el: HTMLElement, { text }: { text: boolean }): { what: string; value: string }[] {
  const s = getComputedStyle(el);
  const border = (['Top', 'Right', 'Bottom', 'Left'] as const).filter((side) => parseFloat(s[`border${side}Width`]) > 0);
  return [
    ...(text ? [{ what: 'color', value: s.color }] : []),
    ...(visible(color(s.backgroundColor)) ? [{ what: 'background', value: s.backgroundColor }] : []),
    ...border.map((side) => ({ what: `border-${side.toLowerCase()}`, value: s[`border${side}Color`] })),
  ];
}

function painted({ card, inked, marker }: Card): { el: HTMLElement; what: string; value: string }[] {
  const ink = new Set<HTMLElement>([...inked, ...(marker ? [marker] : [])]);
  return [card, ...card.querySelectorAll<HTMLElement>('*')].flatMap((el) => paints(el, { text: ink.has(el) }).map((paint) => ({ el, ...paint })));
}
const describeEl = (el: HTMLElement) => `<${el.tagName.toLowerCase()}> "${(el.textContent ?? '').trim().slice(0, 40)}"`;

function offToken(mounted: Card, theme: Theme): string[] {
  const tokens = paintColors([...EXISTING_TOKEN_NAMES, ...STATUS_TOKEN_NAMES].map((name) => expectedColor(name, theme))).map(color);
  return painted(mounted)
    .filter(({ value }) => !tokens.some((token) => sameColor(color(value), token)))
    .map(({ el, what, value }) => `${describeEl(el)} ${what} ${value}`);
}

function backdrop(el: Element, card: HTMLElement): RGBA {
  const chain: Element[] = [];
  for (let at: Element | null = el; at && at !== card; at = at.parentElement) chain.unshift(at);
  return chain.reduce<RGBA>((under, at) => {
    const bg = color(getComputedStyle(at).backgroundColor);
    return visible(bg) ? compositeOver(bg, under) : under;
  }, color(getComputedStyle(card).backgroundColor));
}

function groupOpacity(el: Element): number {
  let alpha = 1;
  for (let at: Element | null = el; at; at = at.parentElement) alpha *= Number(getComputedStyle(at).opacity);
  return alpha;
}

function markerPaint(marker: HTMLElement): RGBA | null {
  const s = getComputedStyle(marker);
  if (visible(color(s.backgroundColor))) return color(s.backgroundColor);
  const side = (['Top', 'Right', 'Bottom', 'Left'] as const).find((at) => parseFloat(s[`border${at}Width`]) > 0 && visible(color(s[`border${at}Color`])));
  if (side) return color(s[`border${side}Color`]);
  return marker.textContent?.trim() ? color(s.color) : null;
}

function isLargeScale(el: HTMLElement): boolean {
  const s = getComputedStyle(el);
  const size = parseFloat(s.fontSize);
  return size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
}

const firstFamily = (el: HTMLElement) => getComputedStyle(el).fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');

function scrollers(el: HTMLElement): Element[] {
  const chain: Element[] = [];
  for (let at = el.parentElement; at; at = at.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(at).overflowY)) chain.push(at);
  }
  return [...chain, ...(document.scrollingElement ? [document.scrollingElement] : [])];
}

describe('the startup card layout (B-1)', () => {
  it('is centred in a window wider and taller than it', async () => {
    await page.viewport(WIDE.width, WIDE.height);
    const { card } = mountCard('light');
    const r = card.getBoundingClientRect();
    const { clientWidth: vw, clientHeight: vh } = document.documentElement;
    expect.soft(r.width, 'card width against the window').toBeLessThan(vw);
    expect.soft(r.height, 'card height against the window').toBeLessThan(vh);
    expect.soft(Math.abs(r.left - (vw - r.right)), 'left gap minus right gap').toBeLessThanOrEqual(1);
    expect.soft(Math.abs(r.top - (vh - r.bottom)), 'top gap minus bottom gap').toBeLessThanOrEqual(1);
  });

  it('scrolls a window shorter than it to reach both of its edges', async () => {
    await page.viewport(SHORT.width, SHORT.height);
    const { card } = mountCard('light');
    const vh = document.documentElement.clientHeight;
    expect.soft(card.getBoundingClientRect().height, 'card height against the short window').toBeGreaterThan(vh);
    for (const el of scrollers(card)) el.scrollTop = 0;
    expect.soft(card.getBoundingClientRect().top, 'card top at the scroll origin').toBeGreaterThanOrEqual(-1);
    for (const el of scrollers(card)) el.scrollTop = el.scrollHeight;
    expect.soft(card.getBoundingClientRect().bottom, 'card bottom at the end of the scroll').toBeLessThanOrEqual(vh + 1);
  });

  for (const theme of THEMES) {
    for (const versionMessage of [false, true]) {
      it(`keeps every line within a 320px window in ${theme}, version message ${versionMessage ? 'shown' : 'hidden'}`, async () => {
        await page.viewport(NARROW.width, NARROW.height);
        const { screen, texts } = mountCard(theme, { versionMessage });
        const root = document.documentElement;
        expect.soft(root.scrollWidth, 'document scroll width').toBeLessThanOrEqual(root.clientWidth);
        expect.soft(screen.scrollWidth, 'wait screen scroll width').toBeLessThanOrEqual(screen.clientWidth);
        const range = document.createRange();
        const outside = texts.flatMap((el) => {
          range.selectNodeContents(el);
          return [...range.getClientRects()]
            .filter((rect) => rect.left < 0 || rect.right > NARROW.width)
            .map((rect) => `${describeEl(el)} line ${rect.left}–${rect.right}`);
        });
        expect.soft(outside, 'card text lines outside the 320px window').toEqual([]);
      });
    }
  }
});

describe('the startup card paint (B-2)', () => {
  for (const theme of THEMES) {
    const other: Theme = theme === 'light' ? 'dark' : 'light';

    it(`paints every card colour from the ${theme} tokens`, () => {
      expect.soft(offToken(mountCard(theme, { versionMessage: true }), theme), 'card colours that are no token value').toEqual([]);
    });

    it(`repaints the mounted card in ${other} when the theme switches from ${theme}`, () => {
      const card = mountCard(theme, { versionMessage: true });
      document.documentElement.dataset.theme = other;
      const switched = painted(card).map(({ what, value }) => `${what} ${value}`);
      const fresh = painted(mountCard(other, { versionMessage: true })).map(({ what, value }) => `${what} ${value}`);
      expect.soft(switched, `colours after switching to ${other}, against a card mounted in ${other}`).toEqual(fresh);
    });
  }

  it('sets card text in the app type families, and the installed app names in mono', () => {
    const { inked, appNames } = mountCard('light', { versionMessage: true });
    expect.soft(inked.filter((el) => !APP_FAMILIES.includes(firstFamily(el))).map((el) => `${describeEl(el)} ${firstFamily(el)}`), 'text outside the app families').toEqual([]);
    expect.soft(appNames.map(firstFamily), 'installed app name families').toEqual(INSTALLED_APP_NAMES.map(() => 'IBM Plex Mono'));
  });
});

describe('the startup card contrast (B-3)', () => {
  for (const theme of THEMES) {
    it(`meets SC 1.4.3 for every piece of card text in ${theme}, version message shown`, () => {
      const { card, inked } = mountCard(theme, { versionMessage: true });
      expect.soft(color(getComputedStyle(card).backgroundColor)[3], 'card background alpha').toBe(1);
      if (color(getComputedStyle(card).backgroundColor)[3] !== 1) return;
      const low = inked.flatMap((el) => {
        const behind = backdrop(el, card);
        const ratio = contrastRatio(ringOver(getComputedStyle(el).color, groupOpacity(el), behind), behind);
        return ratio >= (isLargeScale(el) ? 3 : 4.5) ? [] : [`${describeEl(el)} ${ratio.toFixed(2)}:1`];
      });
      expect.soft(low, 'card text below its SC 1.4.3 threshold').toEqual([]);
    });

    it(`meets SC 1.4.11 for the status marker in ${theme}`, () => {
      const { card, marker } = mountCard(theme);
      expect.soft(color(getComputedStyle(card).backgroundColor)[3], 'card background alpha').toBe(1);
      if (!marker || color(getComputedStyle(card).backgroundColor)[3] !== 1) return;
      const markerColor = markerPaint(marker);
      expect.soft(markerColor, 'status marker paints nothing').not.toBeNull();
      if (!markerColor) return;
      const behind = backdrop(marker.parentElement ?? card, card);
      const [r, g, b, a] = markerColor;
      const paint = compositeOver([r, g, b, a * groupOpacity(marker)], behind);
      expect.soft(contrastRatio(paint, behind), 'marker contrast').toBeGreaterThanOrEqual(3);
    });
  }
});
