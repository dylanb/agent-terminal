// The launcher installed from the Settings UI of a running app answers `--validate-flow` itself: in the
// foreground, with its result on the calling shell's streams and exit status, launching no app instance and
// leaving the already-open one as it was.

import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { shellQuote } from '../../src/shared/shellQuote';
import { flowLocations, writeFlow } from '../helpers/flowFixtures';
import { useInstalledLauncher } from './installedLauncher';
import {
  bundledFlowFolders,
  PASSED,
  passOutcome,
  problemLine,
  problemOutcome,
  usageOutcome,
  USAGE,
  useValidateRuntime,
  VALIDATE_FLOW_FLAG,
  type RunResult,
} from './validateFlowHarness';

const EXIT_MARKER = 'validate-exit:';

/** Types `command --validate-flow <operand>` into the app's own terminal, from `cwd`, the way an agent in the
 *  session runs it, and reads back what it printed and returned. The shell captures each stream to a file and
 *  echoes the exit status on a row of its own, so a long line that wraps on screen cannot change the result. */
async function runInTerminal(page: Page, command: string, operand: string, cwd: string, outDir: string, name: string): Promise<RunResult> {
  const [out, err] = [join(outDir, `${name}.out`), join(outDir, `${name}.err`)];
  await page.locator('[data-viewbtn="1"]').click();
  await page.locator('.xterm-screen').click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  const line = `cd ${shellQuote(cwd)} && ${shellQuote(command)} ${VALIDATE_FLOW_FLAG} ${shellQuote(operand)} >${shellQuote(out)} 2>${shellQuote(err)}; echo "${EXIT_MARKER}${name}:$?"`;
  await page.keyboard.type(line, { delay: 5 });
  await page.keyboard.press('Enter');
  const marker = page.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${EXIT_MARKER}${name}:\\d+\\s*$`) });
  await expect(marker).toHaveCount(1, { timeout: 0 });
  const status = Number(((await marker.textContent()) ?? '').trim().slice(`${EXIT_MARKER}${name}:`.length));
  return { status, signal: null, stdout: readFileSync(out, 'utf8'), stderr: readFileSync(err, 'utf8') };
}

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

  test('run from a shell in the app\'s own terminal, it passes a bundled flow and names a loop no tier holds', async () => {
    const { page } = await launcher.launch();
    const command = await launcher.install(page);
    const world = runtime.world();
    const outDir = world.dir('terminal-runs');
    const [folder] = bundledFlowFolders(runtime.runtimeMain());

    const pass = await runInTerminal(page, command, folder, world.dir('caller'), outDir, 'pass');
    expect.soft(passOutcome(pass)).toEqual(PASSED);

    const repo = world.dir('repo');
    const flowFile = writeFlow(flowLocations.repoCatalogEntry(repo, 'f'), { name: 'f', steps: [{ id: 'build', kind: 'loop', loop: 'missing-loop' }] });
    const broken = await runInTerminal(page, command, join('.agent-terminal', 'flows', 'f'), repo, outDir, 'broken');
    expect(problemOutcome(broken, realpathSync(flowFile))).toEqual(problemLine(expect.stringContaining('missing-loop')));
  });
});
