import { afterEach, expect, it } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import '../helpers/rendererTokens';
import '../../src/renderer/src/styles.css';
import { accentIn, bringForwardIn, cardHeaderIn, cardsIn, controlName, directoryPattern, showFullReasonIn, statusRowIn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { directoryConflictFixture, workStatus } from '../helpers/controllerStatusFixture';
import { readColors, sameColor } from '../helpers/tokenProbe';
import { compositeOver, contrastRatio, parseColor, ringOver, type RGBA } from '../helpers/wcag';

const { members, unrelated } = directoryConflictFixture();
const directory = members[0].launchDirectory;
const card = (host: HTMLElement) => cardsIn(host).find(item => directoryPattern(directory).test(controlName(item)));
const header = (host: HTMLElement) => { const item = card(host); return item && cardHeaderIn(item, directory); };
const viewport = { width: window.innerWidth, height: window.innerHeight };
const settled = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
afterEach(async () => { document.body.replaceChildren(); document.documentElement.removeAttribute('data-theme'); await page.viewport(viewport.width, viewport.height); });

function background(element: Element): RGBA {
  const layers: RGBA[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) layers.push(parseColor(getComputedStyle(node).backgroundColor));
  return layers.reduceRight((behind, color) => compositeOver(color, behind), [255, 255, 255, 1]);
}


function opacity(element: Element): number {
  let alpha = 1;
  for (let node: Element | null = element; node; node = node.parentElement) alpha *= Number(getComputedStyle(node).opacity);
  return alpha;
}

it.each(['light', 'dark'])('paints conflict warning and accent as errors with long accessible identity at 320px in %s', async theme => {
  await page.viewport(320, 700);
  document.documentElement.dataset.theme = theme;
  const longPath = '/work/' + 'very-long-directory-'.repeat(18);
  const { host, dispose } = mountControllerPanes({ terminals: members.slice(0, 2).map(member => ({ ...member, launchDirectory: longPath, work: workStatus() })), oneColumn: true });
  host.style.width = '100%';
  try {
    await settled();
    const first = cardsIn(host)[0];
    const button = first && cardHeaderIn(first, longPath);
    button?.focus();
    await expect.poll(() => {
      const first = cardsIn(host)[0];
      const warning = first && statusRowIn(first);
      const accent = first && accentIn(first);
      const action = first && bringForwardIn(first);
      const expected = readColors(['--status-error', '--status-error-text']);
      const errorColor = expected['--status-error'];
      const errorTextColor = expected['--status-error-text'];
      const readable = (element: HTMLElement | null | undefined) => Boolean(element && element.checkVisibility({ visibilityProperty: true })
        && contrastRatio(ringOver(getComputedStyle(element).color, opacity(element), background(element)), background(element)) >= 4.5);
      return {
        warning: warning?.textContent?.includes('Duplicate directory') ?? false,
        warningColor: Boolean(warning && errorTextColor && sameColor(parseColor(getComputedStyle(warning).color), errorTextColor)),
        accentColor: Boolean(accent && errorColor && sameColor(parseColor(getComputedStyle(accent).backgroundColor), errorColor)),
        warningReadable: readable(warning), actionReadable: readable(action),
        named: controlName(first).includes(longPath),
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        focus: Boolean(button && getComputedStyle(button).outlineStyle !== 'none' && parseFloat(getComputedStyle(button).outlineWidth) > 0
          && contrastRatio(ringOver(getComputedStyle(button).outlineColor, opacity(button), background(button.parentElement!)), background(button.parentElement!)) >= 3),
      };
    }).toEqual({ warning: true, warningColor: true, accentColor: true, warningReadable: true, actionReadable: true, named: true, pageOverflow: false, focus: true });
  } finally { dispose(); }
});

it('toggles conflict by pointer, Enter and Space without activation and keeps warning and count when collapsed', async () => {
  const { host, service, dispose } = mountControllerPanes({ terminals: members.slice(0, 2) });
  try {
    const button = header(host);
    if (button) await userEvent.click(button);
    await settled();
    expect.soft(header(host)?.getAttribute('aria-expanded')).toBe('false');
    expect.soft(header(host)?.textContent).toContain('Duplicate directory');
    expect.soft(header(host)?.textContent).toMatch(/2 (?:live )?(?:instances|terminals|connections)/i);
    expect.soft(header(host)?.textContent).not.toMatch(/human|unavailable/i);
    await userEvent.keyboard('{Enter}');
    await settled();
    expect.soft(header(host)?.getAttribute('aria-expanded')).toBe('true');
    await userEvent.keyboard(' ');
    await settled();
    expect.soft(header(host)?.getAttribute('aria-expanded')).toBe('false');
    expect.soft(document.activeElement).toBe(header(host));
    expect.soft(service.activated).toEqual([]);
  } finally { dispose(); }
});

it('falls back from an ordinary reason to its directory header on conflict and preserves equivalent focus on survivor change', async () => {
  const first = { ...members[0], work: workStatus({ attention: { status: 'review', reasons: ['Long reason\n'.repeat(20)] } }) };
  const { host, service, dispose } = mountControllerPanes({ terminals: [unrelated, first] });
  try {
    await settled();
    const reason = card(host) && showFullReasonIn(card(host)!);
    reason?.focus();
    expect.soft(document.activeElement).toBe(reason);
    service.publish([unrelated, first, members[1]]);
    await settled();
    expect.soft(document.activeElement).toBe(header(host));
    const button = card(host) && bringForwardIn(card(host)!);
    button?.focus();
    service.publish([unrelated, members[1]]);
    await settled();
    expect.soft(document.activeElement).toBe(card(host) && bringForwardIn(card(host)!));
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();
    service.publish([unrelated, ...members]);
    await settled();
    expect.soft(document.activeElement).toBe(outside);
  } finally { dispose(); }
});
