import { test, expect } from '@playwright/test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shellQuote } from '../../src/shared/shellQuote';
import { createControllerDesktopHarness } from './controllerDesktop';

test.skip(process.platform !== 'linux', 'the desktop harness starts a window manager only under Xvfb on Linux');

function fakeWindowManager(earlyExits: number): { command: [string]; starts: () => number; remove: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'fake-wm-'));
  const log = join(dir, 'starts');
  const script = join(dir, 'wm');
  writeFileSync(log, '');
  writeFileSync(script, [
    '#!/bin/sh',
    `echo start >> ${shellQuote(log)}`,
    `[ "$(wc -l < ${shellQuote(log)})" -le ${earlyExits} ] && exit 1`,
    'exec openbox --sm-disable',
    '',
  ].join('\n'));
  chmodSync(script, 0o755);
  return {
    command: [script],
    starts: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).length,
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function outcome(windowManager: [string]): Promise<string> {
  try {
    const harness = await createControllerDesktopHarness({ windowManager });
    await harness.dispose();
    return 'ready';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

test('the desktop harness starts its window manager again when the first start exits before it is ready', { tag: '@ownapp' }, async () => {
  const wm = fakeWindowManager(1);
  try {
    expect({ outcome: await outcome(wm.command), starts: wm.starts() }).toEqual({ outcome: 'ready', starts: 2 });
  } finally {
    wm.remove();
  }
});

test('the desktop harness gives up after the window manager exits early on its second start too', { tag: '@ownapp' }, async () => {
  const wm = fakeWindowManager(Number.MAX_SAFE_INTEGER);
  try {
    expect({ outcome: await outcome(wm.command), starts: wm.starts() }).toEqual({
      outcome: 'Controller test window manager did not become ready',
      starts: 2,
    });
  } finally {
    wm.remove();
  }
});

test('the desktop harness starts a healthy window manager once', { tag: '@ownapp' }, async () => {
  const wm = fakeWindowManager(0);
  try {
    expect({ outcome: await outcome(wm.command), starts: wm.starts() }).toEqual({ outcome: 'ready', starts: 1 });
  } finally {
    wm.remove();
  }
});
