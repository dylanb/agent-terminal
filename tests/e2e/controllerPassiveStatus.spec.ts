import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createControllerDesktopHarness } from './controllerDesktop';
import { observeStatus, STATUS_BUDGET_MS } from './controllerStatusObservation';
import { autoGateFlowYaml, loopRoster, runIdentity, seedAutoGateRepo, seedTrustedFlow } from './autoGateHarness';
import { exampleConfigDir, seedFakeAgentV2, seedFakeGhGit } from './fakeTools';
import { currentLockHolder, serializeLockHolder, worktreeLockFile, worktreeLockRoot } from '../../src/main/worktreeLock';
import { auditFilePath, auditRootDir } from '../../src/main/auditPaths';
import { parseAuditStream } from '../../src/shared/audit';
import { shellQuote } from '../../src/shared/shellQuote';
import { cardLocator } from '../helpers/controllerCards';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };
const ABSENCE_WINDOW_MS = 2_000;

test('status publication leaves a pending terminal notice and the failed run intact', { tag: '@ownapp' }, async () => {
  test.setTimeout(240_000);
  const h = await createControllerDesktopHarness();
  const repo = seedAutoGateRepo('controller-passive-', 'red');
  const { binDir, logFile } = seedFakeGhGit('controller-passive-tools-', { realCommitOps: true });
  try {
    seedTrustedFlow(h.fixture.home, repo, 'passive-flow', autoGateFlowYaml([{ id: 'red', kind: 'loop', loop: 'red-loop' }], 'passive-flow'));
    const failureHold = join(binDir, 'failure-hold');
    writeFileSync(failureHold, 'hold');
    seedFakeAgentV2(binDir, {
      holdConsolidate: { sentinel: failureHold },
      stepId: 'red', artifactRel: '.agent-terminal/loop/artifacts/red-result.json', work: 'red',
      roster: loopRoster('red-loop'), verdicts: ['invalid consolidator output'],
    });
    Object.assign(h.fixture.env, { PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile, CLAUDE_CONFIG_DIR: exampleConfigDir, APP_SUBMIT_DELAY_MS: '100' });
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const terminal = await h.launch(terminalTarget, repo);
    await terminal.page.locator('.xterm-screen').click();
    await terminal.page.keyboard.type(`cd ${shellQuote(repo)}; fake-agent`);
    await terminal.page.keyboard.press('Enter');
    const control = terminal.page.locator('#flow-strip .flow-control');
    await expect(control).toHaveText('Start');
    await control.click();
    await expect.poll(() => existsSync(`${failureHold}.pids`), { timeout: 60_000 }).toBe(true);
    const errorStatus = await observeStatus(controller.page, repo, { error: /error/i, attention: /needs? (?:a )?human|human.*needed/i });
    rmSync(failureHold);
    const runFile = join(repo, '.agent-terminal', 'loop', 'run-state.yaml');
    await expect.poll(() => { try { return readFileSync(runFile, 'utf8'); } catch { return ''; } }, { timeout: 60_000 }).toContain('status: error');
    const source = await terminal.page.evaluate(directory => window.flow.state(directory), repo);
    expect(source.loop?.appTurn).toBeTruthy();
    expect(source.loop?.errorReason).toBeTruthy();
    const errorShown = await errorStatus();
    expect.soft(errorShown.shown).toEqual({ error: true, attention: true });
    expect.soft(errorShown.ever(source.loop!.errorReason!)).toBe(true);
    await terminal.app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const send = contents.send.bind(contents);
      const probe = globalThis as typeof globalThis & { heldStatusEvents?: number };
      probe.heldStatusEvents = 0;
      contents.send = (channel: string, ...args: unknown[]) => {
        if (channel === 'flow:onStateChanged') { probe.heldStatusEvents!++; return; }
        send(channel, ...args);
      };
    });
    const lock = worktreeLockFile(worktreeLockRoot(h.fixture.home), repo);
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, serializeLockHolder(currentLockHolder()));
    await terminal.page.evaluate(({ directory, turn }) => window.flow.appRouteOut(directory, turn.step, turn.turnKey, 'terminate'), { directory: repo, turn: source.loop!.appTurn! });
    await expect.poll(() => terminal.app.evaluate(() => (globalThis as typeof globalThis & { heldStatusEvents?: number }).heldStatusEvents)).toBeGreaterThan(0);
    const before = readFileSync(runFile, 'utf8');
    const run = runIdentity(repo);
    const auditFile = auditFilePath(auditRootDir(h.fixture.home), repo, run.flow, new Date(run.startedAt));
    const statusEvents = () => parseAuditStream(readFileSync(auditFile, 'utf8')).events.filter(event => /^(flow|loop|notify)\./.test(event.type));
    const auditBefore = statusEvents();
    await controller.page.evaluate(duration => new Promise<void>(done => setTimeout(done, duration)), ABSENCE_WINDOW_MS);
    const pane = cardLocator(controller.page, repo);
    await expect.soft(pane).toContainText(source.loop!.errorReason!, { timeout: STATUS_BUDGET_MS });
    await expect.soft(pane).toContainText(/needs? (?:a )?human|human.*needed/i, { timeout: STATUS_BUDGET_MS });
    expect.soft(readFileSync(runFile, 'utf8')).toBe(before);
    expect.soft(statusEvents()).toEqual(auditBefore);
    const notice = await terminal.page.evaluate(directory => window.flow.state(directory), repo);
    expect.soft(notice.notice).toContain('Another Agent Terminal window');
    expect.soft(notice.loop?.status).toBe('error');
    expect.soft((await terminal.page.evaluate(directory => window.flow.state(directory), repo)).notice).toBeUndefined();
  } finally {
    try { await h.dispose(); }
    finally { rmSync(repo, { recursive: true, force: true }); rmSync(binDir, { recursive: true, force: true }); }
  }
});

test('indeterminate durable progression cannot be displayed as an unassigned terminal', { tag: '@ownapp' }, async () => {
  test.setTimeout(120_000);
  const h = await createControllerDesktopHarness();
  const repo = h.fixture.repositories[0];
  try {
    mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
    seedTrustedFlow(h.fixture.home, repo, 'unknown-flow', autoGateFlowYaml([{ id: 'work', kind: 'manual' }], 'unknown-flow'));
    writeFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'step: work\nstatus: [corrupt]\n');
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const terminal = await h.launch(terminalTarget, repo);
    await expect.poll(() => terminal.page.evaluate(directory => window.flow.state(directory), repo).catch(() => null)).toMatchObject({ runStarted: 'indeterminate' });
    const pane = cardLocator(controller.page, repo);
    await expect.soft(pane).toContainText(/unavailable|unknown/i, { timeout: STATUS_BUDGET_MS });
    await expect.soft(pane).not.toContainText(/unassigned/i);
  } finally { await h.dispose(); }
});
