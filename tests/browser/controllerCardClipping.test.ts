import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../helpers/rendererTokens';
import '../../src/renderer/src/styles.css';
import { cardIn, cardLocator } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusTerminal } from '../helpers/controllerStatusFixture';

afterEach(() => document.body.replaceChildren());

const clips = (style: CSSStyleDeclaration): boolean => ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX);

/** Whether some painted occurrence of `text` in `root` lies wholly inside every clipping ancestor. */
function fullyVisible(root: HTMLElement, text: string): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const start = node.textContent?.indexOf(text) ?? -1;
    if (start < 0) continue;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + text.length);
    const boxes = [...range.getClientRects()];
    const inside = boxes.length > 0 && boxes.every(box => box.width > 0 && box.height > 0 && ancestors(node.parentElement!, root).every(parent => {
      const style = getComputedStyle(parent);
      const clip = parent.getBoundingClientRect();
      return style.visibility === 'visible' && (!clips(style) || (box.left >= clip.left - 0.5 && box.right <= clip.right + 0.5));
    }));
    if (inside) return true;
  }
  return false;
}

function ancestors(element: HTMLElement, root: HTMLElement): HTMLElement[] {
  const chain: HTMLElement[] = [];
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    chain.push(node);
    if (node === root) break;
  }
  return chain;
}

/** The text node holding `text`'s nearest clipping ancestor inside `root`. */
function clipOf(root: HTMLElement, text: string): HTMLElement | undefined {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.includes(text)) return ancestors(node.parentElement!, root).find(parent => clips(getComputedStyle(parent)));
  }
  return undefined;
}

const hoverText = (root: HTMLElement | undefined, text: string): boolean =>
  Boolean(root && [root, ...root.querySelectorAll<HTMLElement>('[title]')].some(element => element.title === text));

describe('long card text', () => {
  const finalSegment = 'final-segment';
  const directory = `/work/${'middle-segment-'.repeat(16)}${finalSegment}`;
  const title = 'An over-long issue title that cannot fit on one card line '.repeat(4).trim();
  const terminal = { ...statusTerminal({ ticket: { availability: 'known', number: 219, title: { availability: 'known', text: title } } }), launchDirectory: directory };

  it('shortens an over-long directory at its start with an ellipsis, keeps its final segment visible, and names and hovers it in full', async () => {
    const { host, dispose } = mountControllerPanes({ terminals: [terminal] });
    try {
      await expect.poll(() => {
        const card = cardIn(host, directory);
        const clip = card ? clipOf(card, finalSegment) : undefined;
        return {
          card: Boolean(card),
          finalSegmentVisible: card ? fullyVisible(card, finalSegment) : false,
          startCut: card ? !fullyVisible(card, '/work/middle-segment-') : false,
          ellipsis: Boolean(card && ((clip && getComputedStyle(clip).textOverflow === 'ellipsis') || /…/.test(card.textContent ?? ''))),
          hover: hoverText(card, directory),
          named: cardLocator(page.elementLocator(host), directory).query() !== null,
        };
      }).toEqual({ card: true, finalSegmentVisible: true, startCut: true, ellipsis: true, hover: true, named: true });
    } finally { dispose(); }
  });

  it('gives an over-long ticket title its full text on hover and to assistive technology', () => {
    const { host, dispose } = mountControllerPanes({ terminals: [terminal] });
    try {
      const card = cardIn(host, directory);
      expect({ hover: hoverText(card, title), text: card?.textContent?.includes(title) ?? false }).toEqual({ hover: true, text: true });
    } finally { dispose(); }
  });
});
