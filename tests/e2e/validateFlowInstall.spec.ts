// The launcher installed from the Settings UI of a running app answers `--validate-flow` itself: in the
// foreground, with its result on the calling shell's streams and exit status, launching no app instance and
// leaving the already-open one as it was.

import { expect, test, type ElectronApplication } from '@playwright/test';
import { useInstalledLauncher } from './installedLauncher';
import { bundledFlowFolders, PASSED, passOutcome, usageOutcome, USAGE, useValidateRuntime, VALIDATE_FLOW_FLAG } from './validateFlowHarness';

/** Every window of `app`, with what an unrelated launch could change about it. */
function windowStates(app: ElectronApplication): Promise<{ visible: boolean; minimized: boolean; bounds: unknown }[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), minimized: w.isMinimized(), bounds: w.getBounds() })));
}

test.describe('the installed agent-terminal --validate-flow', { tag: '@ownapp' }, () => {
  const runtime = useValidateRuntime();
  const launcher = useInstalledLauncher(runtime, process.platform);

  test('validates a bundled flow and reports a usage error in the foreground, opening no instance', async () => {
    const { app, page } = await launcher.launch();
    const command = await launcher.install(page);
    const before = await windowStates(app);
    const cwd = runtime.world().dir('caller');
    const [folder] = bundledFlowFolders(runtime.runtimeMain());

    const pass = await launcher.run(command, [VALIDATE_FLOW_FLAG, folder], cwd);
    expect.soft(passOutcome(pass)).toEqual(PASSED);
    expect.soft(launcher.survivors(pass)).toEqual([]);

    const usage = await launcher.run(command, [VALIDATE_FLOW_FLAG], cwd);
    expect.soft(usageOutcome(usage)).toEqual(USAGE);
    expect.soft(launcher.survivors(usage)).toEqual([]);

    expect(await windowStates(app)).toEqual(before);
  });
});
