import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createControllerHarness } from './controllerHarness';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';

const exec = promisify(execFile);
const DESKTOP_POLL_MS = 50;

async function stop(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const closed = once(process, 'close');
  process.kill();
  await closed;
}

export async function createControllerDesktopHarness() {
  if (process.platform !== 'linux') return createControllerHarness();
  const xvfb = spawn('Xvfb', ['-displayfd', '1', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let wm: ChildProcess | undefined;
  let displayTimer: ReturnType<typeof setTimeout> | undefined;
  const lines = createInterface({ input: xvfb.stdout! });
  try {
    const [number] = await Promise.race([
      once(lines, 'line'),
      once(xvfb, 'exit').then(() => { throw new Error('Xvfb exited before assigning its display'); }),
      new Promise<never>((_resolve, reject) => {
        displayTimer = setTimeout(() => reject(new Error('Xvfb did not assign a display')), WINDOW_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(displayTimer);
    if (!/^\d+$/.test(number)) throw new Error(`Invalid X display number: ${number}`);
    const display = `:${number}`;
    const env = { ...process.env, DISPLAY: display };
    wm = spawn('openbox', ['--sm-disable'], { env, stdio: 'ignore' });
    const deadline = Date.now() + WINDOW_TIMEOUT_MS;
    for (;;) {
      const { stdout } = await exec('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], { env });
      if (/window id # 0x[1-9a-f]/i.test(stdout)) break;
      if (Date.now() >= deadline || wm.exitCode !== null) throw new Error('Controller test window manager did not become ready');
      await delay(DESKTOP_POLL_MS);
    }
    const harness = createControllerHarness();
    harness.fixture.env.DISPLAY = display;
    return {
      ...harness,
      async dispose() {
        try { await harness.dispose(); }
        finally { await stop(wm!); await stop(xvfb); }
      },
    };
  } catch (error) {
    if (wm) await stop(wm);
    await stop(xvfb);
    throw error;
  } finally {
    clearTimeout(displayTimer);
    lines.close();
  }
}
