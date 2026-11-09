import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const command = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync: command }));
import { createPaneInjector } from '../../src/main/mcpPaneInjector';

let executableDir: string;
beforeEach(() => {
  vi.useFakeTimers(); command.mockReset();
  executableDir = mkdtempSync(join(tmpdir(), 'mcp-tmux-transfer-'));
  writeFileSync(join(executableDir, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
});
afterEach(() => { vi.useRealTimers(); rmSync(executableDir, { recursive: true, force: true }); });

for (const interruption of ['none', 'before paste', 'after paste', 'paste failure'] as const) {
  it(`pane transport preserves submission ownership: ${interruption}`, () => {
    const received: string[] = [];
    const failures: string[] = [];
    let available = interruption !== 'before paste';
    let failing = interruption === 'paste failure';
    command.mockImplementation((_file, args, options) => {
      if (args.includes('paste-buffer')) {
        if (failing) throw new Error('transport unavailable');
        received.push(options.input);
      }
      return '';
    });
    const inject = createPaneInjector({ socket: '/tmp/owned.sock', searchPath: executableDir }, '%1', () => available, () => {}, reason => failures.push(reason));
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
