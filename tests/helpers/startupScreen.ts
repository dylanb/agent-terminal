/// <reference lib="dom" />
/// <reference types="vite/client" />
import indexHtml from '../../src/renderer/index.html?raw';

const SCREEN_ID = 'startup-waiting';
const VERSION_MESSAGE_ID = 'startup-incompatible';

export const VERSION_MESSAGE =
  'This terminal uses controller protocol version 1, but the running controller supports versions 2–3. Update Agent Terminal, then open this terminal again.';

let mounted: HTMLElement | null = null;

export function mountStartupScreen(): HTMLElement {
  unmountStartupScreen();
  const source = new DOMParser().parseFromString(indexHtml, 'text/html').getElementById(SCREEN_ID);
  if (!source) throw new Error(`src/renderer/index.html has no #${SCREEN_ID} to mount`);
  mounted = document.importNode(source, true);
  document.body.appendChild(mounted);
  return mounted;
}

export function showVersionMessage(screen: HTMLElement): void {
  const message = screen.querySelector<HTMLElement>(`#${VERSION_MESSAGE_ID}`);
  if (!message) throw new Error(`the mounted wait screen has no #${VERSION_MESSAGE_ID} for index.ts to fill`);
  message.textContent = VERSION_MESSAGE;
}

export function unmountStartupScreen(): void {
  mounted?.remove();
  mounted = null;
}

function normalised(el: Element): string {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement?.closest('[aria-hidden="true"]')) text += node.textContent ?? '';
  }
  return text.replace(/\s+/g, ' ').trim();
}

export function cardTextElement(root: ParentNode, text: string): HTMLElement {
  const carriers = [...root.querySelectorAll<HTMLElement>('*')].filter((el) => normalised(el) === text);
  const innermost = carriers.filter((el) => !carriers.some((other) => other !== el && el.contains(other)));
  if (innermost.length !== 1) {
    throw new Error(`expected exactly one card element whose text is "${text}", found ${innermost.length}`);
  }
  return innermost[0];
}
