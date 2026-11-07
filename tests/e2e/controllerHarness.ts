import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { once } from 'node:events';
import { createControllerFixture } from '../helpers/controllerFixture';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';
import { withSetupCheckOff } from './setupCheckEnv';

export type ControllerTestApplication =
  | { kind: 'development'; entry: string }
  | { kind: 'packaged'; executablePath: string };

declare const controllerProfile: unique symbol;
/** An earlier launch's `--user-data-dir`; only `launch` mints one. */
export type ControllerProfile = string & { readonly [controllerProfile]: true };

export function createControllerHarness() {
  const fixture = createControllerFixture();
  const apps: ElectronApplication[] = [];
  let nextProfile = 0;
  return {
    fixture,
    async launch(
      target: ControllerTestApplication,
      launchDir: string,
      options: { profile?: ControllerProfile; env?: Record<string, string> } = {},
    ): Promise<{ app: ElectronApplication; page: Page; profile: ControllerProfile }> {
      const profile = options.profile ?? join(fixture.root, `profile-${nextProfile++}`) as ControllerProfile;
      const app = await electron.launch({
        ...(target.kind === 'packaged' ? { executablePath: target.executablePath } : {}),
        args: [...(target.kind === 'development' ? [target.entry] : []), `--user-data-dir=${profile}`],
        cwd: fixture.nonGit,
        env: { ...withSetupCheckOff({ ...fixture.env, ...options.env }), APP_LAUNCH_DIR: launchDir },
        timeout: WINDOW_TIMEOUT_MS,
      });
      apps.push(app);
      return { app, page: await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS }), profile };
    },
    async crash(app: ElectronApplication): Promise<void> {
      const child = app.process();
      if (child.exitCode !== null || child.signalCode !== null) return;
      const closed = once(child, 'close', { signal: AbortSignal.timeout(WINDOW_TIMEOUT_MS) });
      child.kill('SIGKILL');
      await closed;
    },
    async dispose(): Promise<void> {
      const results = await Promise.allSettled(apps.splice(0).map(app => app.close()));
      fixture.dispose();
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Application cleanup failed');
    },
  };
}

/** Resolves only once the renderer reports the new width, so no caller asserts against the old layout. */
export async function setContentWidth({ app, page }: { app: ElectronApplication; page: Page }, width: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, width) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(width, window.getContentSize()[1]);
  }, width);
  await page.waitForFunction(width => window.innerWidth === width, width, { timeout: WINDOW_TIMEOUT_MS });
}
