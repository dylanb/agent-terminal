import type { ChildProcess } from 'node:child_process';
import type { ElectronApplication, TestInfo } from '@playwright/test';

/** The app's main process while Playwright still holds it; `process()` throws once the app has been closed. */
function liveProcess(running: ElectronApplication): ChildProcess | null {
  let proc: ChildProcess;
  try {
    proc = running.process();
  } catch {
    return null;
  }
  return proc.exitCode === null && proc.signalCode === null ? proc : null;
}

/** Stops `running` at the end of a test. After a failure the app may be wedged (a spinning main process, a crashed
 *  renderer), and a graceful close() then never returns, which strands the worker at its teardown timeout; so a
 *  failed test's app is killed, and the kill waits until the process has exited. An app that already closed or
 *  exited is left alone. */
export async function stopApp(running: ElectronApplication | undefined, testInfo: TestInfo): Promise<void> {
  if (running === undefined) return;
  const proc = liveProcess(running);
  if (proc === null) return;
  if (testInfo.status === testInfo.expectedStatus) {
    await running.close();
    return;
  }
  const exited = new Promise<void>((done) => proc.once('exit', () => done()));
  proc.kill('SIGKILL');
  await exited;
}
