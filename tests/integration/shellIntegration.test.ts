import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createShadowModel } from '../../src/main/shadow';
import { createCommandTracker, type CommandTracker } from '../../src/main/commandTracker';
import { createCwdTracker } from '../../src/main/cwdTracker';
import { resolveRuntimeConfig } from '../../src/main/runtimeConfig';

const SCRIPT = path.resolve(__dirname, '../../src/main/assets/shell-integration.bash');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const has = (tool: string): boolean => {
  try {
    execFileSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

// The PTY allocator differs by platform: util-linux `script -qec '<cmd>' <file>` creates the
// child's terminal from a piped stdin, but BSD/macOS `script` accepts neither `-c` nor a non-tty
// stdin, so on darwin Python's `pty.spawn` allocates the terminal and copies our piped commands in.
const PTY_DRIVER: { file: string; args: string[] } | null =
  process.platform === 'darwin'
    ? has('python3')
      ? { file: 'python3', args: ['-c', 'import pty; pty.spawn(["bash", "--norc", "-i"])'] }
      : null
    : has('script')
      ? { file: 'script', args: ['-qec', 'bash --norc -i', '/dev/null'] }
      : null;

// OSC 133;C (command-start) is emitted via PS0, which exists only in bash >= 4.4 (macOS ships 3.2).
function bashSupportsPS0(): boolean {
  try {
    const v = execFileSync('bash', ['-c', 'echo "${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}"'], { encoding: 'utf8' });
    const [maj, min] = v.trim().split(/\s+/).map(Number);
    return maj > 4 || (maj === 4 && min >= 4);
  } catch {
    return false;
  }
}

/**
 * Drive REAL bash under a PTY — bash only emits the C/B marks with a terminal. node-pty can't be
 * used here: it is ABI-locked to Electron and won't load under the vitest/node ABI (§test rules);
 * the full real-PTY path is covered by the phase-10 e2e.
 */
function runBashSession(input: string): string {
  if (!PTY_DRIVER) throw new Error('no PTY allocator available');
  try {
    return execFileSync(PTY_DRIVER.file, PTY_DRIVER.args, {
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

  // PS0-sourced OSC 133;C (and the capture pipeline it segments) can't exist on bash < 4.4.
  it.skipIf(!PTY_DRIVER || !bashSupportsPS0())('emits OSC-133 marks so `echo hi` is captured with exit 0 and output "hi"', async () => {
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

  it.skipIf(!PTY_DRIVER)('marks the first prompt, before any command has run, so a fresh shell reads as at its prompt', async () => {
    const output = runBashSession('exit\n');

    shadow = createShadowModel({ cols: 80, rows: 24, settleMs: 5, quietMs: 20, onStatus: () => {} });
    tracker = createCommandTracker({
      reader: shadow.reader,
      addMarker: (r) => shadow.addMarker(r),
      onOsc: (id, cb) => shadow.onOsc(id, cb),
      config: resolveRuntimeConfig({}),
    });
    shadow.write(output);
    await sleep(80);

    expect(tracker.shellPrompted()).toBe(true);
  });

  it.skipIf(!PTY_DRIVER)('emits OSC 7 on each prompt so the cwd tracker follows a real `cd` (§16.3)', async () => {
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
