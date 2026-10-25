import { afterEach, describe, expect, it } from 'vitest';
import { STARTUP_CARD } from '../helpers/startupCard';
import { cardTextElement, mountStartupScreen, unmountStartupScreen } from '../helpers/startupScreen';

let scratch: HTMLElement | null = null;

function scratchRoot(html: string): HTMLElement {
  scratch = document.createElement('div');
  scratch.innerHTML = html;
  document.body.appendChild(scratch);
  return scratch;
}

afterEach(() => {
  scratch?.remove();
  scratch = null;
  unmountStartupScreen();
});

describe('mountStartupScreen', () => {
  it('mounts the wait screen from the real index.html as a direct child of <body>', () => {
    const screen = mountStartupScreen();
    expect(screen.parentElement).toBe(document.body);
    expect(screen.isConnected).toBe(true);
  });

  it('carries the existing text exactly as the ticket quotes it', () => {
    const screen = mountStartupScreen();
    for (const text of [STARTUP_CARD.heading, STARTUP_CARD.explanation, STARTUP_CARD.closeHint]) {
      expect(cardTextElement(screen, text).textContent?.replace(/\s+/g, ' ').trim()).toBe(text);
    }
  });

  it('replaces the previously mounted screen instead of stacking a second copy', () => {
    const first = mountStartupScreen();
    const second = mountStartupScreen();
    expect(first.isConnected).toBe(false);
    expect(second.isConnected).toBe(true);
  });

  it('unmounts the screen it mounted', () => {
    const screen = mountStartupScreen();
    unmountStartupScreen();
    expect(screen.isConnected).toBe(false);
  });
});

describe('cardTextElement', () => {
  it('returns the innermost element whose whole text is the expected string', () => {
    const root = scratchRoot('<div><p><span id="inner">Startup paused</span></p></div>');
    expect(cardTextElement(root, 'Startup paused').id).toBe('inner');
  });

  it('matches across collapsed whitespace and inline children', () => {
    const root = scratchRoot('<ul><li id="step">macOS: Open\n   <code>x.app</code> now.</li></ul>');
    expect(cardTextElement(root, 'macOS: Open x.app now.').id).toBe('step');
  });

  it('ignores text hidden from assistive technology, so an aria-hidden glyph marker does not hide its status line', () => {
    const root = scratchRoot('<p id="status"><span aria-hidden="true">●</span> Startup paused</p>');
    expect(cardTextElement(root, 'Startup paused').id).toBe('status');
  });

  it('throws naming the text when no element carries it, so a check cannot pass over an empty set', () => {
    const root = scratchRoot('<p>Waiting for the controller</p>');
    expect(() => cardTextElement(root, 'Startup paused')).toThrow(/Startup paused/);
  });

  it('does not accept an element whose text only contains the expected string', () => {
    const root = scratchRoot('<p>Startup paused for now</p>');
    expect(() => cardTextElement(root, 'Startup paused')).toThrow(/Startup paused/);
  });

  it('throws when two separate elements carry the text, rather than grading an arbitrary one', () => {
    const root = scratchRoot('<p>Startup paused</p><p>Startup paused</p>');
    expect(() => cardTextElement(root, 'Startup paused')).toThrow(/Startup paused/);
  });
});
