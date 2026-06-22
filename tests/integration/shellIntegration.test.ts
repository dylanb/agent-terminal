import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createShadowModel } from '../../src/main/shadow';
import { createCommandTracker, type CommandTracker } from '../../src/main/commandTracker';
import { createCwdTracker } from '../../src/main/cwdTracker';
import { resolveRuntimeConfig } from '../../src/main/runtimeConfig';

const SCRIPT = path.resolve(__dirname, '../../src/main/assets/shell-integration.bash');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Drive REAL bash under a PTY allocated by `script(1)` — bash only emits the C/B marks with a
 * terminal. node-pty can't be used here: it is ABI-locked to Electron and won't load under the
 * vitest/node ABI (§test rules); the full real-PTY path is covered by the phase-10 e2e.
 */
function runBashSession(input: string): string {
  try {
    return execFileSync('script', ['-qec', 'bash --norc -i', '/dev/null'], {
      input,
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        PS1: '$ ',
        APP_TERM_INTEGRATION: SCRIPT,
        PROMPT_COMMAND: 'source "$APP_TERM_INTEGRATION"',
      },
    });
  } catch (e) {
    // `script -e` propagates the child's exit status; still capture its stdout.
    const out = (e as { stdout?: string }).stdout;
    if (typeof out === 'string') return out;
    throw e;
  }
}

describe('shell integration script (§15.5 / D3) — real bash under a PTY', () => {
  let shadow: ReturnType<typeof createShadowModel>;
  let tracker: CommandTracker;
  afterEach(() => {
    tracker?.dispose();
    shadow?.dispose();
  });

  it('emits OSC-133 marks so `echo hi` is captured with exit 0 and output "hi"', async () => {
    const output = runBashSession('echo hi\nexit\n');
    expect(output).toContain('\x1b]133;C');

    shadow = createShadowModel({ cols: 80, rows: 24, settleMs: 5, quietMs: 20, onStatus: () => {} });
    tracker = createCommandTracker({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onOsc: (id, cb) => shadow.onOsc(id, cb),
      config: resolveRuntimeConfig({}),
    });
    shadow.write(output);
    await sleep(80);

    const echo = tracker.summaries().find((c) => c.command === 'echo hi');
    expect(echo).toBeTruthy();
    expect(echo!.exitCode).toBe(0);
    expect(tracker.capture(echo!.id)?.text).toContain('hi');
  });

  it('emits OSC 7 on each prompt so the cwd tracker follows a real `cd` (§16.3)', async () => {
    const output = runBashSession('cd /tmp\nexit\n');
    expect(output).toMatch(/\x1b]7;file:\/\//);

    shadow = createShadowModel({ cols: 80, rows: 24, settleMs: 5, quietMs: 20, onStatus: () => {} });
    const cwdTracker = createCwdTracker({ onOsc: (id, cb) => shadow.onOsc(id, cb), resolveRepoKey: (c) => c });
    shadow.write(output);
    await sleep(80);

    // The session's last prompt fires after `cd /tmp`, so the tracker lands there.
    expect(cwdTracker.cwd()).toBe('/tmp');
    cwdTracker.dispose();
  });
});
