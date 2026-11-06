/// <reference lib="dom" />
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import { electron } from './registeredElectron';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';
import { AGENT_LOGS_BRANCH_SH, exampleConfigDir, seedFakeAgentV2 } from './fakeTools';
import { createAdoptionWorld, type AdoptionWorld, type AdoptionWorldOptions } from '../helpers/adoptionWorld';
import { outwardWrites } from '../helpers/outwardWrites';
import { readPickupRecord } from '../../src/main/appLoopState';
import { createTrustedPickups } from '../../src/main/trustedPickups';
import { inProgressRunIdentity } from '../../src/main/gateRunState';
import { createFlowStateStore } from '../../src/main/flowState';
import { auditRepoDir, auditRootDir } from '../../src/main/auditPaths';
import { parseAuditStream } from '../../src/shared/audit';
import { shellQuote } from '../../src/shared/shellQuote';

// #304 slice 1 — a run started on a pull request number works locally on a fix branch of its own, at the PR's head,
// and publishes nothing; a PR it cannot adopt is refused at start. GitHub is the adoption world: real git against a
// local bare origin, and the strict gh stand-in.

const STEP = 'review';
const ARTIFACT_REL = '.agent-terminal/loop/artifacts/plan.md';
const BRANCHES_SEEN_REL = '.agent-terminal/branches-seen';

const cleanups: Array<() => unknown> = [];
test.afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (e) {
      failures.push(e);
    }
  }
  if (failures.length > 0) throw failures[0];
});

const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function world(options: AdoptionWorldOptions): AdoptionWorld {
  const w = createAdoptionWorld(options);
  cleanups.push(() => {
    try {
      w.dispose();
    } catch (e) {
      // Each test asserts the breaches itself; this net catches only a test that passed over one.
      if (test.info().status === 'passed') throw e;
    }
  });
  return w;
}

// The fixture's loop def: the shipped plan-loop, adopting the step's pr input, with a gate that publishes nothing.
function seedAdoptingConfig(): string {
  const root = tempDir('agent-term-e2e-adopt-config-');
  const target = join(root, 'loops-v2', 'plan-loop');
  cpSync(join(exampleConfigDir, 'loops-v2', 'plan-loop'), target, { recursive: true });
  const defFile = join(target, 'plan-loop.yaml');
  const def = load(readFileSync(defFile, 'utf8')) as Record<string, unknown>;
  def.pickup = { adopt: 'pr' };
  def.gate = [{ option: 'approve' }, { option: 'request-changes' }];
  writeFileSync(defFile, dump(def));
  cpSync(join(exampleConfigDir, 'agents'), join(root, 'agents'), { recursive: true });
  return root;
}

function seedAdoptingFlow(repo: string): void {
  mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(repo, '.agent-terminal', 'flow.yaml'),
    dump({
      name: 'adopt-pr-fixture',
      steps: [
        { id: 'prep', kind: 'manual' },
        { id: STEP, kind: 'loop', loop: 'plan-loop', bootstrap: 'pickup', inputs: [{ name: 'pr', type: 'pr', required: true }] },
      ],
    }),
  );
  writeFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), 'step: prep\nstatus: not_started\n');
}

interface Launched {
  app: ElectronApplication;
  page: Page;
  home: string;
}

async function launch(w: AdoptionWorld, agentTurnShell?: string): Promise<Launched> {
  const home = tempDir('agent-term-e2e-adopt-home-');
  const config = seedAdoptingConfig();
  const agentBin = tempDir('agent-term-e2e-adopt-agent-');
  seedFakeAgentV2(agentBin, {
    stepId: STEP,
    artifactRel: ARTIFACT_REL,
    work: 'complete',
    review: 'full',
    ...(agentTurnShell === undefined ? {} : { extraShell: { work: [agentTurnShell], review: [agentTurnShell], consolidate: [agentTurnShell] } }),
  });
  seedAdoptingFlow(w.repo);
  const app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      ...w.env,
      APP_SHELL: 'bash',
      HOME: home,
      APP_SUBMIT_DELAY_MS: '100',
      APP_TURN_TIMEOUT_MS: '60000',
      CLAUDE_CONFIG_DIR: config,
      PATH: `${agentBin}:${w.env.PATH}`,
    },
  });
  cleanups.push(() => app.close());
  const page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  return { app, page, home };
}

const flowControl = (page: Page): Locator => page.locator('#flow-strip .flow-control');
const inputModal = (page: Page): Locator => page.locator('#flow-modal-host .flow-modal');
const startError = (page: Page): Locator => page.locator('#flow-error-host .flow-modal');

async function typeCommand(page: Page, command: string): Promise<void> {
  await page.locator('.xterm-screen').click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  await page.keyboard.type(command, { delay: 20 });
  await page.keyboard.press('Enter');
}

/** Opens the repo, then Start → prep, Advance → the adopting step, and answers its `pr` input with `pr`. */
async function startOnPr(page: Page, w: AdoptionWorld, withAgent: boolean): Promise<void> {
  await expect(page.locator('.xterm-rows')).not.toHaveText('', { timeout: 15_000 });
  await typeCommand(page, `cd ${shellQuote(w.repo)}`);
  await expect(flowControl(page)).toHaveText('Start', { timeout: 10_000 });
  if (withAgent) await typeCommand(page, 'fake-agent');
  await flowControl(page).click();
  await expect(flowControl(page)).toHaveText('Advance', { timeout: 10_000 });
  await flowControl(page).click();
  await expect(inputModal(page)).toBeVisible({ timeout: 10_000 });
  await inputModal(page).locator('.field input').fill(String(w.prNumber));
  await inputModal(page).locator('.confirm').click();
}

const readIf = (file: string): string => (existsSync(file) ? readFileSync(file, 'utf8') : '');
const checkedOut = (w: AdoptionWorld): string => w.git(w.repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
const localBranches = (w: AdoptionWorld): string[] =>
  w.git(w.repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(Boolean);
const namesPr = (pr: number): RegExp => new RegExp(`(^|\\D)${pr}(\\D|$)`);

function auditedTickets(home: string, repo: string): number[] {
  const dir = auditRepoDir(auditRootDir(home), repo);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .flatMap((f) => parseAuditStream(readFileSync(join(dir, f), 'utf8')).events)
    .flatMap((e) => (e.type === 'ticket.assoc' ? [e.ticket] : []));
}

const savedPickup = (repo: string): string =>
  JSON.stringify(createTrustedPickups({ currentRun: inProgressRunIdentity, persistFailed: () => {}, forgetFailed: () => {} }).get(repo) ?? null);

const BOOTSTRAP_REL = ['.agent-terminal', 'loop', 'bootstrap.yaml'];
const RUN_PICKUP_REL = ['.agent-terminal', 'loop', 'run-pickup.yaml'];
const FLOW_STATE_REL = ['.agent-terminal', 'flow-state.yaml'];

/** `doc` with every leaf equal to `from` replaced by `to`, so a record's field is broken without naming its key. */
function replacing(doc: unknown, from: string | number, to: string | number): unknown {
  if (doc === from) return to;
  if (Array.isArray(doc)) return doc.map((v) => replacing(v, from, to));
  if (doc !== null && typeof doc === 'object') return Object.fromEntries(Object.entries(doc).map(([k, v]) => [k, replacing(v, from, to)]));
  return doc;
}

/** A copy of `repo`'s run files in a fresh directory, with `broken` applied to the copy of `file`. */
function copyRunFiles(repo: string, file: string[], broken: (doc: unknown) => unknown = (doc) => doc): string {
  const copy = tempDir('agent-term-e2e-adopt-record-');
  mkdirSync(join(copy, '.agent-terminal', 'loop'), { recursive: true });
  for (const rel of [BOOTSTRAP_REL, RUN_PICKUP_REL, FLOW_STATE_REL]) {
    const source = join(repo, ...rel);
    if (!existsSync(source)) continue;
    const doc = load(readFileSync(source, 'utf8'));
    writeFileSync(join(copy, ...rel), dump(rel === file ? broken(doc) : doc));
  }
  return copy;
}

test('a run started on a PR number works every turn on its own fix branch from the PR head, and writes nothing to GitHub (#304 AC 1, 8, 16)', { tag: '@ownapp' }, async () => {
  test.setTimeout(WINDOW_TIMEOUT_MS + 150_000);
  // Origin's ticket in another case is acceptable; the third repository's is not, so the PR closes one ticket.
  const w = world({ prefix: 'agent-term-e2e-adopt-tracer', pr: { closingIssues: [{ repo: 'OWNER/Repo', number: 176 }, { repo: 'elsewhere/other', number: 9 }] } });
  const { page, home } = await launch(w, AGENT_LOGS_BRANCH_SH);
  await startOnPr(page, w, true);

  await expect.soft.poll(() => readPickupRecord(w.repo).kind, { timeout: 30_000 }).toBe('complete');
  const fixBranch = checkedOut(w);
  expect.soft(fixBranch).not.toBe('main');
  expect.soft(fixBranch).not.toBe(w.headBranch);
  expect.soft(fixBranch).toMatch(namesPr(w.prNumber));
  expect.soft(w.git(w.repo, ['rev-parse', fixBranch])).toBe(w.startHeadOid);
  const record = JSON.stringify(readPickupRecord(w.repo));
  expect.soft(record).toContain(fixBranch);
  expect.soft(record).toContain(w.startHeadOid);
  expect.soft(record).toContain(w.startBaseOid);
  await expect.soft.poll(() => savedPickup(w.repo), { timeout: 30_000 }).toContain(fixBranch);

  // The readers fail closed: a copy of either file with one field broken reads as untrusted.
  expect.soft(readPickupRecord(copyRunFiles(w.repo, BOOTSTRAP_REL)).kind).toBe('complete');
  expect.soft(readPickupRecord(copyRunFiles(w.repo, BOOTSTRAP_REL, (d) => replacing(d, fixBranch, 'bad..branch'))).kind).toBe('invalid');
  expect.soft(readPickupRecord(copyRunFiles(w.repo, BOOTSTRAP_REL, (d) => replacing(d, w.startHeadOid, 'not-an-object-id'))).kind).toBe('invalid');
  expect.soft(readPickupRecord(copyRunFiles(w.repo, BOOTSTRAP_REL, (d) => replacing(d, 176, 0))).kind).toBe('invalid');
  expect.soft(savedPickup(copyRunFiles(w.repo, RUN_PICKUP_REL))).toContain(fixBranch);
  expect.soft(savedPickup(copyRunFiles(w.repo, RUN_PICKUP_REL, (d) => replacing(d, fixBranch, 'bad..branch')))).toBe('null');

  const runState = join(w.repo, '.agent-terminal', 'loop', 'run-state.yaml');
  await expect.soft.poll(() => readIf(runState), { timeout: 90_000 }).toContain('verdict: clean');
  const seen = readIf(join(w.repo, BRANCHES_SEEN_REL)).split('\n').filter(Boolean);
  expect.soft(seen.length).toBeGreaterThanOrEqual(3);
  expect.soft(seen.filter((branch) => branch !== fixBranch)).toEqual([]);
  expect.soft(auditedTickets(home, w.repo)).toEqual([176]);
  expect.soft(outwardWrites(w.calls())).toEqual([]);
  expect.soft(w.contractBreaches()).toEqual([]);
});

test("a fork PR whose only ticket is in its head repository starts on a fix branch at the fork's head, fetched from origin (#304 AC 1, 16)", { tag: '@ownapp' }, async () => {
  test.setTimeout(WINDOW_TIMEOUT_MS + 90_000);
  const w = world({ prefix: 'agent-term-e2e-adopt-fork', pr: { fork: 'Contributor/Fork', closingIssues: [{ repo: 'contributor/fork', number: 177 }] } });
  const { page, home } = await launch(w);
  await startOnPr(page, w, true);

  await expect.soft.poll(() => readPickupRecord(w.repo).kind, { timeout: 30_000 }).toBe('complete');
  const fixBranch = checkedOut(w);
  expect.soft(fixBranch).toMatch(namesPr(w.prNumber));
  expect.soft(w.git(w.repo, ['rev-parse', 'HEAD'])).toBe(w.startHeadOid);
  await expect.soft.poll(() => auditedTickets(home, w.repo), { timeout: 30_000 }).toEqual([177]);
  expect.soft(outwardWrites(w.calls())).toEqual([]);
  expect.soft(w.contractBreaches()).toEqual([]);
});

const REFUSALS: Array<{ title: string; pr: AdoptionWorldOptions['pr']; reason: RegExp }> = [
  { title: 'closes no ticket (AC 2)', pr: { closingIssues: [] }, reason: /ticket/i },
  { title: 'closes only a ticket outside its base and head repositories (AC 2)', pr: { closingIssues: [{ repo: 'elsewhere/other', number: 9 }] }, reason: /ticket/i },
  { title: 'is closed (AC 3)', pr: { state: 'CLOSED' }, reason: /closed/i },
  { title: 'is merged (AC 3)', pr: { state: 'MERGED' }, reason: /merged/i },
  { title: 'has a head branch name the pickup record cannot hold', pr: { headBranch: 'feature/a+b' }, reason: /feature\/a\+b/ },
];

for (const refusal of REFUSALS) {
  test(`a PR that ${refusal.title} is refused at start in a dialog, the flow goes back a step, and no branch is created (#304)`, { tag: '@ownapp' }, async () => {
    test.setTimeout(WINDOW_TIMEOUT_MS + 60_000);
    const w = world({ prefix: 'agent-term-e2e-adopt-refused', pr: refusal.pr });
    const { page } = await launch(w);
    await startOnPr(page, w, false);

    await expect.soft(startError(page)).toContainText(refusal.reason, { timeout: 30_000 });
    await expect.soft.poll(() => createFlowStateStore(w.repo).read()?.step, { timeout: 10_000 }).toBe('prep');
    expect.soft(localBranches(w)).toEqual(['main']);
    expect.soft(checkedOut(w)).toBe('main');
    expect.soft(outwardWrites(w.calls())).toEqual([]);
    expect.soft(w.contractBreaches()).toEqual([]);
  });
}
