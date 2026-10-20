import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';
import { createControllerFixture } from '../helpers/controllerFixture';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';

export type ControllerTestApplication =
  | { kind: 'development'; entry: string }
  | { kind: 'packaged'; executablePath: string };

export function createControllerHarness() {
  const fixture = createControllerFixture();
  const apps: ElectronApplication[] = [];
  let nextProfile = 0;
  return {
    fixture,
    async launch(target: ControllerTestApplication, launchDir: string): Promise<{ app: ElectronApplication; page: Page }> {
      const profile = join(fixture.root, `profile-${nextProfile++}`);
      const app = await electron.launch({
        ...(target.kind === 'packaged' ? { executablePath: target.executablePath } : {}),
        args: [...(target.kind === 'development' ? [target.entry] : []), `--user-data-dir=${profile}`],
        cwd: fixture.nonGit,
        env: { ...fixture.env, APP_LAUNCH_DIR: launchDir },
        timeout: WINDOW_TIMEOUT_MS,
      });
      apps.push(app);
      return { app, page: await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS }) };
    },
    async dispose(): Promise<void> {
      const results = await Promise.allSettled(apps.splice(0).map(app => app.close()));
      fixture.dispose();
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Application cleanup failed');
    },
  };
}
