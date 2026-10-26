import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createViewportLayout } from '../../src/renderer/src/controllerFrame';

const DEFAULT_VIEWPORT = { width: window.innerWidth, height: window.innerHeight };

afterEach(async () => {
  document.body.replaceChildren();
  await page.viewport(DEFAULT_VIEWPORT.width, DEFAULT_VIEWPORT.height);
});

describe('the frame layout', () => {
  it('reports one column below 640 CSS px and multi-column at 640, and notifies across that edge', async () => {
    await page.viewport(639, 700);
    const layout = createViewportLayout(window);
    let notified = 0;
    const unsubscribe = layout.onChange(() => { notified += 1; });
    const narrow = layout.oneColumn();
    await page.viewport(640, 700);
    await expect.poll(() => ({ narrow, wide: layout.oneColumn(), notified: notified > 0 }))
      .toEqual({ narrow: true, wide: false, notified: true });
    unsubscribe();
  });
});
