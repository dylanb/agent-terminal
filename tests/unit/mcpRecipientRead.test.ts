import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const processRead = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync: processRead }));
import { sessionRecipient } from '../../src/main/mcpSessionProcess';

const processes = '10 1 S 10 20 pts/0\n20 10 S+ 20 20 pts/0\n30 1 S 30 -1 ?\n40 30 S+ 40 40 pts/1';
let executableDir: string;
beforeEach(() => {
  processRead.mockReset();
  executableDir = mkdtempSync(join(tmpdir(), 'mcp-tmux-reader-'));
  writeFileSync(join(executableDir, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
});
afterEach(() => { rmSync(executableDir, { recursive: true, force: true }); });

it('reads a valid direct recipient without relying on a multiplexer', () => {
  processRead.mockReturnValue(processes);
  expect(sessionRecipient(20, 10)).not.toBe(null);
});

it('reads an active tmux route and refuses a different selected pane', () => {
  let pane = 40;
  processRead.mockImplementation((command, args) => command === 'ps' ? processes : args.includes('show-messages') ? '' : `20 ${pane} 0 0 root 0 %1`);
  expect(sessionRecipient(40, 10, { socket: '/tmp/tmux.sock', searchPath: executableDir })).not.toBe(null);
  pane = 99;
  expect(sessionRecipient(40, 10, { socket: '/tmp/tmux.sock', searchPath: executableDir })).toBe(null);
});

it.each(['ps', 'tmux'])('fails closed when %s cannot be read', failedCommand => {
  processRead.mockImplementation(command => {
    if (command === failedCommand || (failedCommand === 'tmux' && command.endsWith('/tmux'))) throw new Error('unavailable');
    return processes;
  });
  expect(sessionRecipient(40, 10, { socket: '/tmp/tmux.sock', searchPath: executableDir })).toBe(null);
});

it.each([0, -1, 1.5, Number.NaN])('refuses an invalid process identity %s', pid => {
  processRead.mockReturnValue(processes);
  expect(sessionRecipient(pid, 10)).toBe(null);
  expect(sessionRecipient(20, pid)).toBe(null);
});

it('finds tmux on the calling terminal’s PATH even when main has a different PATH', async () => {
  const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const bin = mkdtempSync(join(tmpdir(), 'mcp-tmux-path-'));
  try {
    writeFileSync(join(bin, 'tmux'), "#!/bin/sh\nif [ \"$3\" = show-messages ]; then exit 0; fi\nprintf '20 40 0 0 root 0 %%1\\n'\n", { mode: 0o700 });
    processRead.mockImplementation((file, args, options) => file === 'ps' ? processes : real.execFileSync(file, args, options));
    expect(sessionRecipient(40, 10, { socket: '/tmp/tmux.sock', searchPath: bin })).not.toBe(null);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

it('keeps the caller pane addressable while a popup job owns client input', () => {
  processRead.mockImplementation((command, args) => {
    if (command === 'ps') return processes;
    return args.includes('show-messages') ? 'Job 0: bash [fd=10, pid=77, status=0]\n' : '20 40 0 0 root 0 %1';
  });
  expect(sessionRecipient(40, 10, { socket: '/tmp/tmux.sock', searchPath: executableDir })).toMatchObject({ pane: '%1' });
});

it.each(['', '.'])('does not execute a working-directory tmux through PATH %j', async searchPath => {
  const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const bin = mkdtempSync(join(tmpdir(), 'mcp-tmux-untrusted-'));
  try {
    writeFileSync(join(bin, 'tmux'), "#!/bin/sh\nprintf started > ran\nprintf '%s\\n' '20 40 0 0 root 0 %1'\n", { mode: 0o700 });
    processRead.mockImplementation((file, args, options) => file === 'ps' ? processes : real.execFileSync(file, args, { ...options, cwd: bin }));
    expect(sessionRecipient(40, 10, { socket: '/tmp/tmux.sock', searchPath })).toBe(null);
    expect(existsSync(join(bin, 'ran'))).toBe(false);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
