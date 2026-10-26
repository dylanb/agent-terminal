import { electron } from './registeredElectron';
/// <reference lib="dom" />
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordDisposition } from '../../src/main/runDisposition';
import { seedSharedExampleConfig } from '../helpers/e2eExampleConfig';

let app: ElectronApplication;
let page: Page;
let home: string;
let cleanup: string[];

const termRows = () => page.locator('.xterm-rows');
const statusBar = () => page.locator('#status-bar');
const statusTitle = () => page.locator('#status-bar [data-sb-title]');
const statusAlert = () => page.locator('#status-bar [data-status-alert]');
const flowStepName = () => page.locator('#flow-strip .flow.vert .stn').nth(1).locator('.nm');
const flowControl = () => page.locator('#flow-strip .flow-control');

// The shipped §27 loop defs resolve from a shared example config, so a seeded loop step binds a real def with
// gate options.
const exampleConfigDir = seedSharedExampleConfig();

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100', CLAUDE_CONFIG_DIR: exampleConfigDir },
  });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
}

async function relaunch(): Promise<void> {
  await app.close();
  await launch();
}

async function typeCommand(command: string): Promise<void> {
  await page.locator('.xterm-screen').click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  await page.keyboard.type(command, { delay: 20 });
  await page.keyboard.press('Enter');
}

async function enterRepo(repo: string, expectedStep?: string): Promise<void> {
  await typeCommand(`cd "${repo}"`);
  if (expectedStep) await expect(flowStepName()).toHaveText(expectedStep, { timeout: 10_000 });
  else await expect(statusTitle()).toBeVisible({ timeout: 10_000 });
}

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

// A repo whose flow sits AT the §27 loop's clean consolidator gate — a human-needed state (§27.9). The flow
// is persisted already on the loop step (in_progress) with a run-state at the gate, so a passive load
// reconstructs the human-needed loop view WITHOUT an entry action re-driving a turn (the §27 resume path
// never re-drives a reached gate). `infra-loop` resolves from the shared example config. Returns the
// run-state path — the file the app itself never writes.
function seedLoopAtGateRepo(prefix: string): { dir: string; runStateFile: string } {
  const dir = temp(prefix);
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(dir, '.agent-terminal', 'flow.yaml'),
    'name: dev-flow\nsteps:\n  - id: groom\n    kind: manual\n  - id: build\n    kind: loop\n    loop: infra-loop\n    loop_namespace: app\n',
  );
  writeFileSync(join(dir, '.agent-terminal', 'flow-state.yaml'), 'step: build\nstatus: in_progress\n');
  recordDisposition(dir, { source: 'non-catalog' });
  const loopDir = join(dir, '.agent-terminal', 'loop');
  mkdirSync(loopDir, { recursive: true });
  const runStateFile = join(loopDir, 'run-state.yaml');
  writeFileSync(
    runStateFile,
    'schema_version: 1\nloop: infra-loop\nstep: build\nturn_key: consolidate-build\nstatus: complete\nverdict: clean\nround: 1\n',
  );
  return { dir, runStateFile };
}

// A repo whose flow declares a `pr` typed input pre-resolved in flow-state.yaml (§18.4). The PR ref is
// progress-gated: it surfaces (and outranks a user title in the bar) only once the flow enters the step
// that declares it — a pre-`work` manual `groom` step keeps it hidden until Advance.
function seedRefsFlowRepo(prefix: string, pr = '179'): string {
  const dir = temp(prefix);
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(dir, '.agent-terminal', 'flow.yaml'),
    'name: refs-flow\nsteps:\n  - id: groom\n    kind: manual\n' +
      '  - id: work\n    kind: manual\n    inputs:\n      - name: pr\n        type: pr\n',
  );
  writeFileSync(join(dir, '.agent-terminal', 'flow-state.yaml'), `step: groom\nstatus: not_started\ninputs:\n  pr: "${pr}"\n`);
  return dir;
}

test.beforeEach(async () => {
  cleanup = [];
  home = temp('agent-term-e2e-statusbar-home-');
  await launch();
});

test.afterEach(async () => {
  await app.close();
  for (const dir of cleanup.reverse()) rmSync(dir, { recursive: true, force: true });
});

test('is always visible and enters attention only while the §27 loop needs a human (§22.3.1 / §24.2.3 T4)', async () => {
  // The bar is always visible; the attention alert appears ONLY when the loop is blocked on a human. A repo
  // with no loop shows none; a repo whose flow sits at the §27 loop's human-needed gate does. The alert is a
  // projection of the derived loop view — cd-ing away from the gated repo clears it with no file write.
  const plain = temp('agent-term-e2e-statusbar-plain-');
  mkdirSync(join(plain, '.git'), { recursive: true });
  const { dir: gate } = seedLoopAtGateRepo('agent-term-e2e-statusbar-gate-');

  await expect(statusBar()).toBeVisible();
  await expect(statusTitle()).toBeVisible();
  await expect(statusAlert()).toHaveCount(0);

  await enterRepo(plain);
  await expect(statusAlert()).toHaveCount(0);

  await enterRepo(gate);
  await expect(statusAlert()).toBeVisible({ timeout: 10_000 }); // the §27 clean consolidator gate is human-needed
  await expect(page.locator('#status-bar [data-attn-dismiss]')).toHaveCount(0);

  await statusAlert().click();
  await expect(page.locator('#app')).toHaveClass(/\bloop-open\b/);
  await expect(page.locator('#loop-panel')).toContainText('complete');

  // cd back to the loop-less repo → the loop view is gone → attention clears; the bar stays visible.
  await enterRepo(plain);
  await expect(statusAlert()).toHaveCount(0, { timeout: 10_000 });
  await expect(statusBar()).toBeVisible();
});

test('persists a user title across relaunch and keeps it while a PR outranks it (§22.3.1)', async () => {
  // The user names the work on the pre-`work` step (its `pr` typed input is not yet in view). The name
  // persists to flow-state.yaml and survives a relaunch. Advancing into `work` surfaces the pr ref, which
  // OUTRANKS the name in the bar's display — yet the name is never lost from flow-state (§18.4).
  const dir = seedRefsFlowRepo('agent-term-e2e-sbname-');
  await enterRepo(dir, 'groom');
  await statusTitle().click();
  const editor = page.locator('#status-bar input[data-sb-title-edit]');
  await editor.fill('Refactor the shadow parser');
  await editor.press('Enter');
  await expect(statusTitle()).toHaveText('Refactor the shadow parser');
  await expect.poll(() => readFileSync(join(dir, '.agent-terminal', 'flow-state.yaml'), 'utf8')).toContain('Refactor the shadow parser');

  await relaunch();
  await enterRepo(dir, 'groom');
  await expect(statusTitle()).toHaveText('Refactor the shadow parser'); // persisted; the pr ref is hidden pre-`work`
  await flowControl().click(); // Start → groom
  await flowControl().click(); // Advance → work: the pr typed-input ref surfaces and outranks the user name
  await expect(statusTitle()).toContainText('PR #179', { timeout: 10_000 });
  expect(readFileSync(join(dir, '.agent-terminal', 'flow-state.yaml'), 'utf8')).toContain('Refactor the shadow parser'); // the name is not lost
});

test('names a directory with no flow and restores the name after relaunch (§22.3.1)', async () => {
  const plain = temp('agent-term-e2e-noflow-');
  await enterRepo(plain);
  await statusTitle().click();
  const editor = page.locator('#status-bar input[data-sb-title-edit]');
  await editor.fill('Spike the shadow parser');
  await editor.press('Enter');
  await expect(statusTitle()).toHaveText('Spike the shadow parser');
  await expect.poll(() => readFileSync(join(plain, '.agent-terminal', 'flow-state.yaml'), 'utf8')).toContain('Spike the shadow parser');

  await relaunch();
  await enterRepo(plain);
  await expect(statusTitle()).toHaveText('Spike the shadow parser');
});

test('rejects unregistered and malformed title-write targets (CWE-73)', async () => {
  const unregistered = temp('agent-term-e2e-unregistered-');
  const currentRepo = await page.evaluate(async () => (await window.monitor.currentRepo())!.repoKey);
  const outcomes = await page.evaluate(async (cases) =>
    Promise.all(cases.map(async ({ repoKey, title }) => {
      try {
        await window.flow.setTitle(repoKey, title);
        return 'resolved';
      } catch {
        return 'rejected';
      }
    })), [
      { repoKey: unregistered, title: 'Must not land' },
      { repoKey: '../relative', title: 'Must not land' },
      { repoKey: currentRepo, title: 'x'.repeat(201) },
    ]);
  expect(outcomes).toEqual(['rejected', 'rejected', 'rejected']);
  expect(existsSync(join(unregistered, '.agent-terminal', 'flow-state.yaml'))).toBe(false);
});

test('surfaces a failed title write and rolls back the optimistic name (§22.3.1)', async () => {
  const plain = temp('agent-term-e2e-nameerr-');
  const elsewhere = temp('agent-term-e2e-nameerr-else-');
  symlinkSync(elsewhere, join(plain, '.agent-terminal'));
  await enterRepo(plain);
  await statusTitle().click();
  const editor = page.locator('#status-bar input[data-sb-title-edit]');
  await editor.fill('Never lands');
  await editor.press('Enter');
  const errorDialog = page.locator('#flow-error-host .flow-modal');
  await expect(errorDialog).toContainText('Could not save the name', { timeout: 10_000 });
  await expect(statusTitle()).not.toHaveText('Never lands');
});
