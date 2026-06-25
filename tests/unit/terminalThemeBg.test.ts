// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { wireTerminalThemeBackground } from '../../src/renderer/src/terminal';

// §7.1/§7.4: the xterm gutter fill is xterm's inline theme background. The themed --term-bg differs per
// theme, so a live data-theme toggle must re-seed the background or the scrollbar strip reappears one
// theme behind. The observable boundary is the applyBg callback firing with the re-read background.
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

afterEach(() => document.documentElement.removeAttribute('data-theme'));

describe('wireTerminalThemeBackground (§7.1/§7.4 live theme toggle)', () => {
  it('re-applies the terminal background when the document theme toggles', async () => {
    const applied: (string | undefined)[] = [];
    let bg = 'light-bg';
    const dispose = wireTerminalThemeBackground({ applyBg: (v) => applied.push(v), readBg: () => bg });

    bg = 'dark-bg';
    document.documentElement.setAttribute('data-theme', 'dark');
    await tick();

    expect(applied).toContain('dark-bg');
    dispose();
  });

  it('stops re-applying once disposed', async () => {
    const applied: (string | undefined)[] = [];
    const dispose = wireTerminalThemeBackground({ applyBg: (v) => applied.push(v), readBg: () => 'x' });
    dispose();

    document.documentElement.setAttribute('data-theme', 'dark');
    await tick();

    expect(applied).toHaveLength(0);
  });
});
