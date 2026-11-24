import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRecipientInjector } from '../../src/main/recipientInjector';
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

for (const interruption of ['none', 'before paste', 'after paste', 'paste failure'] as const) {
  it(`pane transport preserves submission ownership: ${interruption}`, () => {
    const received: string[] = [];
    const failures: string[] = [];
    let available = interruption !== 'before paste';
    let failing = interruption === 'paste failure';
    const transfer = (data: string): void => {
      if (failing) throw new Error('transport unavailable');
      received.push(data);
    };
    const inject = createRecipientInjector({ canReceive: () => available, paste: transfer, write: transfer,
      onInject: () => {}, onDrop: reason => failures.push(reason) });
    inject('retained text', { submit: true });
    available = interruption !== 'after paste';
    failing = false;
    vi.runAllTimers();
    expect(received).toEqual(interruption === 'none' ? ['retained text', '\r'] : interruption === 'after paste' ? ['retained text'] : []);
    if (interruption === 'none') expect(failures).toEqual([]);
    else expect(failures).toHaveLength(1);
    if (interruption === 'paste failure') expect(failures[0]).toContain('transport unavailable');
  });
}
