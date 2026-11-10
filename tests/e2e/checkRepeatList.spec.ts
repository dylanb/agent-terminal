import { expect, test, type ElectronApplication } from '@playwright/test';
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { snapshotTree } from '../helpers/treeSnapshot';
import { useInstalledLauncher } from './installedLauncher';
import { useInstalledRuntime } from './installedRuntime';
import { PASSED, passOutcome, problemLine, problemOutcome, USAGE, usageOutcome, type RunResult } from './validateFlowHarness';

const CHECK_REPEAT_LIST_FLAG = '--check-repeat-list';
const LIST_FIXTURE = resolve(__dirname, '..', 'fixtures', 'repeat-list-flow', 'steps.json');

const passNaming = (result: RunResult, file: string) => ({ ...passOutcome(result), names: result.stdout.includes(file) });
const PASSED_NAMING = { ...PASSED, names: true };

function windowStates(app: ElectronApplication): Promise<{ visible: boolean; minimized: boolean; bounds: unknown }[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), minimized: w.isMinimized(), bounds: w.getBounds() })));
}

test.describe('agent-terminal --check-repeat-list', { tag: '@ownapp' }, () => {
  const runtime = useInstalledRuntime();
  const launcher = useInstalledLauncher(runtime, process.platform);
  const check = (operands: readonly string[], cwd: string): Promise<RunResult> => runtime.runRaw([CHECK_REPEAT_LIST_FLAG, ...operands], { cwd });

  test('a well-formed file prints one OK line naming its absolute path and exits 0, named absolutely or from the working directory', async () => {
    const caller = runtime.world().dir('caller');
    const file = join(caller, 'steps.json');
    copyFileSync(LIST_FIXTURE, file);
    expect.soft(passNaming(await check([file, 'steps'], runtime.world().root), file)).toEqual(PASSED_NAMING);
    expect.soft(passNaming(await check(['steps.json', 'steps'], caller), file)).toEqual(PASSED_NAMING);
  });

  test('a bad file prints one line, its absolute path then the problem, and exits 1', async () => {
    const caller = runtime.world().dir('caller');
    const empty = join(caller, 'empty.json');
    writeFileSync(empty, '{"steps": []}');
    const untitled = join(caller, 'untitled.json');
    writeFileSync(untitled, '{"steps": [{"title": "a"}, {"name": "b"}]}');
    expect.soft(problemOutcome(await check(['absent.json', 'steps'], caller), join(caller, 'absent.json'))).toEqual(problemLine());
    expect.soft(problemOutcome(await check([empty, 'steps'], caller), empty)).toEqual(problemLine());
    expect.soft(problemOutcome(await check([untitled, 'steps'], caller), untitled)).toEqual(problemLine(expect.stringMatching(/(^|\D)2(\D|$)/)));
    expect.soft(problemOutcome(await check([LIST_FIXTURE, 'not-the-key'], caller), LIST_FIXTURE)).toEqual(problemLine());
  });

  test('a file name and a list key holding spaces and shell metacharacters are each one verbatim operand', async () => {
    const caller = runtime.world().dir('caller');
    const name = `my list; touch evil-marker $(touch pwned).json`;
    const key = 'the "steps"; `touch ticked`';
    const file = join(caller, name);
    writeFileSync(file, JSON.stringify({ [key]: [{ title: 'Only entry' }] }));
    expect.soft(passNaming(await check([name, key], caller), file)).toEqual(PASSED_NAMING);
    expect.soft(['evil-marker', 'pwned', 'ticked'].filter((f) => existsSync(join(caller, f)))).toEqual([]);
  });

  test('fewer or more than two operands print usage to standard error and exit 2', async () => {
    const caller = runtime.world().dir('caller');
    copyFileSync(LIST_FIXTURE, join(caller, 'steps.json'));
    expect.soft(usageOutcome(await check([], caller))).toEqual(USAGE);
    expect.soft(usageOutcome(await check(['steps.json'], caller))).toEqual(USAGE);
    expect.soft(usageOutcome(await check(['steps.json', 'steps', 'extra'], caller))).toEqual(USAGE);
  });

  test('the installed launcher runs it in the foreground, opening no instance and writing nothing', async () => {
    const { app, page } = await launcher.launch();
    const command = await launcher.install(page);
    const before = await windowStates(app);
    const world = runtime.world();
    const lists = world.dir('lists');
    const file = join(lists, 'steps.json');
    copyFileSync(LIST_FIXTURE, file);
    const cwd = world.dir('caller');
    const trees = () => ({ lists: snapshotTree(lists), cwd: snapshotTree(cwd) });
    const untouched = trees();

    const pass = await launcher.run(command, [CHECK_REPEAT_LIST_FLAG, file, 'steps'], cwd);
    expect.soft(passNaming(pass, file)).toEqual(PASSED_NAMING);
    expect.soft(launcher.survivors(pass)).toEqual([]);

    const bad = await launcher.run(command, [CHECK_REPEAT_LIST_FLAG, join(lists, 'absent.json'), 'steps'], cwd);
    expect.soft(problemOutcome(bad, join(lists, 'absent.json'))).toEqual(problemLine());
    expect.soft(launcher.survivors(bad)).toEqual([]);

    expect.soft(trees()).toEqual(untouched);
    expect(await windowStates(app)).toEqual(before);
  });
});
