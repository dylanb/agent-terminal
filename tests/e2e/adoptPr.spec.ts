import { seedExampleReviewers } from '../helpers/e2eExampleConfig';
import { writeExampleFlow } from './fakeTools';
/// <reference lib="dom" />
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import { controllerOf, electron } from './registeredElectron';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';
import { AGENT_LOGS_BRANCH_SH, agentCommitsFixSh, agentSwitchesBranchSh, exampleConfigDir, seedFakeAgentV2 } from './fakeTools';
import { createAdoptionWorld, type AdoptionWorld, type AdoptionWorldOptions } from '../helpers/adoptionWorld';
import { forcePushes, outwardWrites } from '../helpers/outwardWrites';
import { readPickupRecord } from '../../src/main/appLoopState';
import { isAdoptedPickup } from '../../src/shared/appBootstrap';
import { createTrustedPickups } from '../../src/main/trustedPickups';
import { inProgressRunIdentity } from '../../src/main/gateRunState';
import { createFlowStateStore } from '../../src/main/flowState';
import { auditRepoDir, auditRootDir } from '../../src/main/auditPaths';
import { parseAuditStream } from '../../src/shared/audit';
import { shellQuote } from '../../src/shared/shellQuote';
import { REVIEWER_HANDOFF_BEGIN, REVIEWER_HANDOFF_END, reviewerHandoffLines } from '../../src/main/reviewTurn';
import { ticketPromptLines } from '../../src/shared/currentTicket';
import type { AdoptTicketAnswer, AdoptTicketOffer } from '../../src/shared/ipc';

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

const QUIET_GATE = [{ option: 'approve' }, { option: 'request-changes' }];

// The fixture's loop def: the shipped plan-loop, adopting the step's pr input, with `gate` (default: one that
// publishes nothing).
function seedAdoptingConfig(gate: unknown[] = QUIET_GATE): string {
  const root = tempDir('agent-term-e2e-adopt-config-');
  const target = join(root, 'loops-v2', 'plan-loop');
  cpSync(join(exampleConfigDir, 'loops-v2', 'plan-loop'), target, { recursive: true });
  const defFile = join(target, 'plan-loop.yaml');
  const def = load(readFileSync(defFile, 'utf8')) as Record<string, unknown>;
  def.pickup = { adopt: 'pr' };
  def.gate = gate;
  writeFileSync(defFile, dump(def));
  seedExampleReviewers(root, 'adopt-pr-fixture', ['plan-loop']);
  return root;
}

function seedAdoptingFlow(repo: string): void {
  mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
  writeExampleFlow(
    join(repo, '.agent-terminal', 'flow.yaml'),
    dump({
      name: 'adopt-pr-fixture',
      steps: [
        { id: 'prep', kind: 'manual' },
        { id: STEP, kind: 'loop', loop: 'plan-loop', bootstrap: 'pickup', inputs: [{ name: 'pr', type: 'pr', required: true }] },
        { id: 'done', kind: 'manual' },
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

type TurnShell = { work?: string[]; review?: string[]; consolidate?: string[] };

interface LaunchOptions {
  /** The adopting step's gate; default one that publishes nothing. */
  gate?: unknown[];
  /** A relaunch: the earlier launch's home, with the repository's flow and run files left as they are. */
  relaunchOf?: Launched;
}

/** `agentTurnShell` runs at the end of every turn when it is one command, or per turn kind when it is a map. */
async function launch(w: AdoptionWorld, agentTurnShell?: string | TurnShell, agent: { logInjected?: boolean } = {}, options: LaunchOptions = {}): Promise<Launched> {
  const home = options.relaunchOf?.home ?? tempDir('agent-term-e2e-adopt-home-');
  const config = seedAdoptingConfig(options.gate);
  const agentBin = tempDir('agent-term-e2e-adopt-agent-');
  seedFakeAgentV2(agentBin, {
    stepId: STEP,
    artifactRel: ARTIFACT_REL,
    work: 'complete',
    review: 'full',
    ...agent,
    ...(agentTurnShell === undefined
      ? {}
      : { extraShell: typeof agentTurnShell === 'string' ? { work: [agentTurnShell], review: [agentTurnShell], consolidate: [agentTurnShell] } : agentTurnShell }),
  });
  if (options.relaunchOf === undefined) seedAdoptingFlow(w.repo);
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
  await expect.soft.poll(() => auditedTicketRepos(home, w.repo), { timeout: 30_000 }).toEqual([{ ticket: 177, repo: 'contributor/fork' }]);
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

test("a flow whose adopting step breaks the adoption rules fails to load in the app, against the operator's own loop def (#304 AC 25)", { tag: '@ownapp' }, async () => {
  test.setTimeout(WINDOW_TIMEOUT_MS + 60_000);
  const w = world({ prefix: 'agent-term-e2e-adopt-load' });
  const { page } = await launch(w);
  const flowFile = join(w.repo, '.agent-terminal', 'flow.yaml');
  const flowDoc = load(readFileSync(flowFile, 'utf8')) as { steps: Array<Record<string, unknown>> };
  for (const step of flowDoc.steps) if (step.id === STEP) step.gate_authority = 'auto';
  writeFileSync(flowFile, dump(flowDoc));

  await expect(page.locator('.xterm-rows')).not.toHaveText('', { timeout: 15_000 });
  await typeCommand(page, `cd ${shellQuote(w.repo)}`);

  const loadError = page.locator('#flow-strip .flow-error');
  await expect.soft(loadError).toContainText(STEP, { timeout: 10_000 });
  await expect.soft(loadError).toContainText('gate_authority');
  await expect.soft(flowControl(page)).toHaveCount(0);
  expect.soft(localBranches(w)).toEqual(['main']);
  expect.soft(outwardWrites(w.calls())).toEqual([]);
});

test("a turn that starts on a branch other than the run's fix branch is held, naming both branches and the primary ticket with its repository (#304 AC 5)", { tag: '@ownapp' }, async () => {
  test.setTimeout(WINDOW_TIMEOUT_MS + 120_000);
  // The primary lives in the fork, so a reason naming origin's repository in its place is told apart.
  const w = world({ prefix: 'agent-term-e2e-adopt-hold', pr: { fork: 'Contributor/Fork', closingIssues: [{ repo: 'contributor/fork', number: 177 }] } });
  const { app, page } = await launch(w, { work: [agentSwitchesBranchSh('elsewhere')] });
  await startOnPr(page, w, true);

  await expect.poll(() => readPickupRecord(w.repo).kind, { timeout: 30_000 }).toBe('complete');
  const record = readPickupRecord(w.repo);
  const fixBranch = record.kind === 'complete' && isAdoptedPickup(record.bootstrap) ? record.bootstrap.fixBranch : '';
  expect.soft(fixBranch).toMatch(namesPr(w.prNumber));
  const controller = controllerOf(app);
  await expect.poll(() => controller.loopMessage()?.kind, { timeout: 90_000 }).toBe('error');
  const reason = controller.loopMessage()?.reason ?? '';

  expect.soft(reason).toContain('elsewhere');
  expect.soft(reason).toContain(fixBranch);
  expect.soft(reason).toMatch(/contributor\/fork/i);
  expect.soft(reason).toMatch(namesPr(177));
  expect.soft(checkedOut(w)).toBe('elsewhere');
  expect.soft(outwardWrites(w.calls())).toEqual([]);
  expect.soft(w.contractBreaches()).toEqual([]);
});

// #304 slice 3 — the primary ticket of a PR that closes several, and what an adopting run presents as intent.

const ticketChoice = (page: Page): Locator => page.getByRole('dialog').filter({ has: page.getByRole('radio') });
const namesTicket = (repo: string, number: number): RegExp => new RegExp(`${repo.replace('/', '\\/')}\\D*${number}(\\D|$)`, 'i');

/** Keeps every ticket-choice offer main pushes to the renderer, from before the start. */
async function keepOffers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const offers: AdoptTicketOffer[] = [];
    Reflect.set(window, 'adoptOffers', offers);
    window.flow.onAdoptTicketChoice((offer) => offers.push(offer));
  });
}
const lastOffer = (page: Page): Promise<AdoptTicketOffer | null> =>
  page.evaluate(() => {
    const offers = Reflect.get(window, 'adoptOffers') as AdoptTicketOffer[] | undefined;
    return offers?.at(-1) ?? null;
  });
/** Answers main over the renderer's own channel, as a renderer bug or a late answer would. */
const answerOffer = (page: Page, args: { repoKey: string; step: string; choiceId: string; answer: AdoptTicketAnswer }): Promise<unknown> =>
  page.evaluate(({ repoKey, step, choiceId, answer }) => window.flow.resolveAdoptTicket(repoKey, step, choiceId, answer).catch((e: unknown) => ({ threw: String(e) })), args);

/** Uses `control` once it shows; a missing or covered control fails its own soft check, or the checks after it,
 *  rather than ending the test. */
async function use(control: Locator, act: (c: Locator) => Promise<void>): Promise<void> {
  await expect.soft(control).toBeVisible({ timeout: 30_000 });
  if ((await control.count()) === 1) await act(control).catch(() => {});
}

function primaryOf(repo: string): unknown {
  const record = readPickupRecord(repo);
  return record.kind === 'complete' && isAdoptedPickup(record.bootstrap) ? record.bootstrap.primary : record.kind;
}

function auditedTicketRepos(home: string, repo: string): unknown[] {
  const dir = auditRepoDir(auditRootDir(home), repo);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .flatMap((f) => parseAuditStream(readFileSync(join(dir, f), 'utf8')).events)
    .flatMap((e) => (e.type === 'ticket.assoc' ? [{ ticket: e.ticket, repo: 'repo' in e ? e.repo : undefined }] : []));
}

test("a PR closing two acceptable tickets asks which is the primary; the pick is the record's primary, the audit's ticket with its repository, and the ticket the branch hold names (#304 AC 4)", { tag: '@ownapp' }, async () => {
  test.setTimeout(WINDOW_TIMEOUT_MS + 240_000);
  const origin = { repo: 'owner/repo', number: 176 } as const;
  const fork = { repo: 'contributor/fork', number: 177 } as const;
  const w = world({ prefix: 'agent-term-e2e-adopt-choose', pr: { fork: 'Contributor/Fork', closingIssues: [origin, fork] } });
  const { app, page, home } = await launch(w, { work: [agentSwitchesBranchSh('elsewhere')] });
  await keepOffers(page);
  await startOnPr(page, w, true);

  const choice = ticketChoice(page);
  await expect.soft(choice.getByRole('radio', { name: namesTicket(origin.repo, origin.number) })).toBeVisible({ timeout: 30_000 });
  await expect.soft(choice.getByRole('radio', { name: namesTicket(fork.repo, fork.number) })).toBeVisible();

  // An answer to no offer, or naming a ticket the offer did not hold, is refused, and the choice stays open.
  const offer = await lastOffer(page);
  const answering = { repoKey: offer?.repoKey ?? w.repo, step: offer?.step ?? STEP };
  expect.soft(await answerOffer(page, { ...answering, choiceId: 'no-such-offer', answer: { kind: 'ticket', ticket: { ...origin } } })).toMatchObject({ ok: false });
  expect.soft(await answerOffer(page, { ...answering, choiceId: offer?.choiceId ?? 'no-offer', answer: { kind: 'ticket', ticket: { repo: 'owner/repo', number: 999 } } })).toMatchObject({ ok: false });
  await expect.soft(choice).toBeVisible();

  await use(choice.getByRole('radio', { name: namesTicket(fork.repo, fork.number) }), (radio) => radio.check());
  await use(choice.getByRole('button', { name: /^confirm/i }), (button) => button.click());

  await expect.soft.poll(() => primaryOf(w.repo), { timeout: 30_000 }).toEqual(fork);
  await expect.soft.poll(() => auditedTicketRepos(home, w.repo), { timeout: 30_000 }).toEqual([{ ticket: 177, repo: 'contributor/fork' }]);
  const controller = controllerOf(app);
  await expect.soft.poll(() => controller.loopMessage()?.kind, { timeout: 90_000 }).toBe('error');
  const reason = controller.loopMessage()?.reason ?? '';
  expect.soft(reason).toMatch(namesTicket(fork.repo, fork.number));
  expect.soft(reason).not.toMatch(namesPr(origin.number));
  expect.soft(outwardWrites(w.calls())).toEqual([]);
  expect.soft(w.contractBreaches()).toEqual([]);
});

test('Cancel in the ticket choice rolls the step back with no error, creating no branch and writing nothing, and its offer cannot be answered later (#304 AC 4)', { tag: '@ownapp' }, async () => {
  test.setTimeout(WINDOW_TIMEOUT_MS + 180_000);
  const w = world({ prefix: 'agent-term-e2e-adopt-cancel', pr: { closingIssues: [{ repo: 'owner/repo', number: 176 }, { repo: 'owner/repo', number: 178 }] } });
  const { page } = await launch(w);
  await keepOffers(page);
  await startOnPr(page, w, false);

  await expect.soft(ticketChoice(page)).toBeVisible({ timeout: 30_000 });
  const first = await lastOffer(page);
  await use(ticketChoice(page).getByRole('button', { name: /^cancel/i }), (button) => button.click());

  await expect.soft.poll(() => createFlowStateStore(w.repo).read()?.step, { timeout: 30_000 }).toBe('prep');
  await expect.soft(ticketChoice(page)).toHaveCount(0);
  await expect.soft(startError(page)).toHaveCount(0);
  expect.soft(localBranches(w)).toEqual(['main']);
  expect.soft(checkedOut(w)).toBe('main');
  expect.soft(readPickupRecord(w.repo).kind).toBe('none');

  // A second start, on the PR input the rolled-back step kept, offers again; an answer to the cancelled offer is
  // refused, and the new one stays open.
  await use(flowControl(page), (control) => control.click({ timeout: 10_000 }));
  await expect.soft(ticketChoice(page)).toBeVisible({ timeout: 30_000 });
  const second = await lastOffer(page);
  expect.soft(second?.choiceId ?? null).not.toBe(first?.choiceId ?? null);
  const answering = { repoKey: second?.repoKey ?? w.repo, step: second?.step ?? STEP };
  expect.soft(await answerOffer(page, { ...answering, choiceId: first?.choiceId ?? 'no-first-offer', answer: { kind: 'ticket', ticket: { repo: 'owner/repo', number: 176 } } })).toMatchObject({ ok: false });
  await expect.soft(ticketChoice(page)).toBeVisible();
  expect.soft(readPickupRecord(w.repo).kind).toBe('none');
  expect.soft(outwardWrites(w.calls())).toEqual([]);
  expect.soft(w.contractBreaches()).toEqual([]);
});

test("an adopting run's prompts and reviewer hand-offs name its ticket as intent, read in its repository, and its change as the reviewed PR's own commits, never the PR's title or body (#304 AC 6, 7)", { tag: '@ownapp' }, async () => {
  test.setTimeout(WINDOW_TIMEOUT_MS + 150_000);
  // A fork PR stacked on another PR's branch, which has moved on since the reviewed PR branched from it.
  const w = world({ prefix: 'agent-term-e2e-adopt-prompts', pr: { fork: 'Contributor/Fork', stackedOn: 'feature/parent', closingIssues: [{ repo: 'contributor/fork', number: 177 }] } });
  const movedTip = w.pushAs('feature/parent', 'parent-later.txt', 'landed on the parent PR after the reviewed PR branched\n', 'Move the parent PR on');
  const { page } = await launch(w, undefined, { logInjected: true });
  await startOnPr(page, w, true);

  await expect.poll(() => readPickupRecord(w.repo).kind, { timeout: 30_000 }).toBe('complete');
  const record = readPickupRecord(w.repo);
  const fixBranch = record.kind === 'complete' && isAdoptedPickup(record.bootstrap) ? record.bootstrap.fixBranch : '';
  await expect.poll(() => readIf(join(w.repo, '.agent-terminal', 'loop', 'run-state.yaml')), { timeout: 90_000 }).toContain('verdict: clean');
  const log = readIf(join(w.repo, '.agent-terminal', 'injected-log'));
  const work = log.split('This is the review-and-fix turn')[0] ?? '';
  const handoff = log.split(REVIEWER_HANDOFF_BEGIN)[1]?.split(REVIEWER_HANDOFF_END)[0] ?? '';
  const consolidateRecipe = readFileSync(join(exampleConfigDir, 'loops-v2', 'plan-loop', 'prompts', 'consolidate.md'), 'utf8');
  const consolidateLead = consolidateRecipe.split('\n').find((l) => l.trim() !== '') ?? '';
  const consolidate = consolidateLead === '' || !log.includes(consolidateLead) ? '' : log.slice(log.lastIndexOf(consolidateLead));
  const ticketRunTicketLines = [...ticketPromptLines(177), reviewerHandoffLines({ carried: [], ticket: 177 })[0] ?? ''].filter((l) => namesPr(177).test(l));
  const readsTheTicket = (prompt: string): string[] =>
    prompt.split('\n').filter((l) => /\bgh\b/.test(l) && l.includes('github.com') && /contributor\/fork/i.test(l) && namesPr(177).test(l));
  const namesTheRange = (prompt: string): string[] => prompt.split('\n').filter((l) => l.includes(w.startBaseOid) && l.includes(fixBranch));

  expect.soft(fixBranch).toMatch(namesPr(w.prNumber));
  expect.soft(handoff).not.toBe('');
  expect.soft(readsTheTicket(work)).not.toEqual([]);
  expect.soft(readsTheTicket(handoff)).not.toEqual([]);
  expect.soft(namesTheRange(work)).not.toEqual([]);
  expect.soft(namesTheRange(handoff)).not.toEqual([]);
  expect.soft(consolidate).not.toBe('');
  expect.soft(readsTheTicket(consolidate)).not.toEqual([]);
  expect.soft(namesTheRange(consolidate)).not.toEqual([]);
  expect.soft(log.split('\n').filter((l) => ticketRunTicketLines.includes(l))).toEqual([]);
  expect.soft(log).not.toContain(movedTip);
  expect.soft(log).not.toContain('Reviewed PR title, never intent');
  expect.soft(log).not.toContain('Reviewed PR body, never intent');
  expect.soft(outwardWrites(w.calls())).toEqual([]);
  expect.soft(w.contractBreaches()).toEqual([]);
});

test('a pick that is no longer acceptable when the start re-reads the PR rolls the step back, naming it, with no branch and nothing written (#304 AC 4)', { tag: '@ownapp' }, async () => {
  test.setTimeout(WINDOW_TIMEOUT_MS + 120_000);
  const w = world({ prefix: 'agent-term-e2e-adopt-stale-pick', pr: { fork: 'Contributor/Fork', closingIssues: [{ repo: 'owner/repo', number: 176 }, { repo: 'contributor/fork', number: 177 }] } });
  const { page } = await launch(w);
  await startOnPr(page, w, false);

  const choice = ticketChoice(page);
  const forkRadio = choice.getByRole('radio', { name: namesTicket('contributor/fork', 177) });
  await expect.soft(forkRadio).toBeVisible({ timeout: 30_000 });
  // Only the confirm can refuse it: no error shows while the operator is still choosing.
  await expect.soft(startError(page)).toHaveCount(0);
  // GitHub changes while the operator decides: the PR stops closing the fork's ticket.
  w.gh.update((state) => {
    for (const pull of state.pulls) pull.closingIssues = pull.closingIssues.filter((t) => t.number !== 177);
  });
  await use(forkRadio, (radio) => radio.check());
  await use(choice.getByRole('button', { name: /^confirm/i }), (button) => button.click());

  await expect.soft(startError(page)).toContainText(namesTicket('contributor/fork', 177), { timeout: 30_000 });
  await expect.soft.poll(() => createFlowStateStore(w.repo).read()?.step, { timeout: 10_000 }).toBe('prep');
  expect.soft(localBranches(w)).toEqual(['main']);
  expect.soft(checkedOut(w)).toBe('main');
  expect.soft(readPickupRecord(w.repo).kind).toBe('none');
  expect.soft(outwardWrites(w.calls())).toEqual([]);
  expect.soft(w.contractBreaches()).toEqual([]);
});

// #304 slice 4 — approving an adopting run's gate publishes exactly one outcome into the reviewed PR, or writes
// nothing and holds the gate with the reason shown; a relaunch keeps acting on the same PR.

const PUBLISH_GATE = [{ option: 'approve', side_effects: [{ kind: 'gh', action: 'publish-pr-review', artifact: 'plan' }] }, { option: 'request-changes' }];
const COMMITS_FIX = { work: [agentCommitsFixSh('change.txt', 'the fixed change\n', 'Fix the reviewed change')] };
const RUN_STATE_REL = ['.agent-terminal', 'loop', 'run-state.yaml'];

const reviewedPrComments = (w: AdoptionWorld) => w.gh.read().comments[String(w.prNumber)] ?? [];
const runComments = (w: AdoptionWorld) => reviewedPrComments(w).filter((c) => c.login === w.gh.read().login);
const fixPrs = (w: AdoptionWorld, fixBranch: string) => w.gh.read().pulls.filter((p) => p.number !== w.prNumber && p.headRefName === fixBranch);
const linksTo = (body: string | undefined, w: AdoptionWorld, number: number | undefined): boolean =>
  body !== undefined && number !== undefined && (body.includes(`https://github.com/${w.origin}/pull/${number}`) || new RegExp(`(^|[^\\w/])#${number}(?!\\d)`).test(body));
const gitPushes = (w: AdoptionWorld, from = 0) => w.calls().slice(from).filter((c) => c.tool === 'git' && c.argv.includes('push'));
const ghWrites = (w: AdoptionWorld, from = 0) => outwardWrites(w.calls().slice(from)).filter((c) => c.tool === 'gh');
const flowStep = (w: AdoptionWorld): string | undefined => createFlowStateStore(w.repo).read()?.step;
const reportOf = (w: AdoptionWorld): string => readIf(join(w.repo, ARTIFACT_REL));

function fixBranchOf(w: AdoptionWorld): string {
  const record = readPickupRecord(w.repo);
  return record.kind === 'complete' && isAdoptedPickup(record.bootstrap) ? record.bootstrap.fixBranch : '';
}

/** Starts the run on the PR and waits for its gate. */
async function toGate(page: Page, w: AdoptionWorld): Promise<void> {
  await startOnPr(page, w, true);
  await expect.poll(() => readIf(join(w.repo, ...RUN_STATE_REL)), { timeout: 90_000 }).toContain('verdict: clean');
}

/** Presses Approve on the gate, opening the loop read-out first when the gate is not showing. */
async function approveAtGate(page: Page): Promise<void> {
  const approveOption = page.locator('#loop-panel [data-gate-option="approve"]');
  if (!(await approveOption.isVisible())) await use(page.locator('#flow-strip .loopstat'), (readout) => readout.click());
  await use(approveOption, (option) => option.click());
}

/** The loop message once it is an error; null when none shows in time. */
async function heldReason(app: ElectronApplication): Promise<string | null> {
  const controller = controllerOf(app);
  await expect.soft.poll(() => controller.loopMessage()?.kind, { timeout: 30_000 }).toBe('error');
  const message = controller.loopMessage();
  return message?.kind === 'error' ? message.reason : null;
}

const OUTCOMES: Array<{ title: string; world: Omit<AdoptionWorldOptions, 'prefix'>; fixes: boolean; outcome: 'fix-pr' | 'report-comment' | 'patch-comment' }> = [
  { title: 'with a fix the operator can push, opens a draft fix PR into the head branch and links it (AC 9)', world: {}, fixes: true, outcome: 'fix-pr' },
  { title: 'with no fix, posts the report as the run comment (AC 10)', world: {}, fixes: false, outcome: 'report-comment' },
  { title: 'with a fix on a fork, posts the report and a patch based on the fetched head (AC 11)', world: { pr: { fork: 'Contributor/Fork' } }, fixes: true, outcome: 'patch-comment' },
  { title: 'with a fix and no write permission, posts the report and a patch based on the fetched head (AC 11)', world: { viewerPermission: 'READ' }, fixes: true, outcome: 'patch-comment' },
];

for (const o of OUTCOMES) {
  test(`approving an adopting run's gate ${o.title} (#304)`, { tag: '@ownapp' }, async () => {
    test.setTimeout(WINDOW_TIMEOUT_MS + 180_000);
    const w = world({ prefix: 'agent-term-e2e-adopt-publish', ...o.world });
    const { page } = await launch(w, o.fixes ? COMMITS_FIX : undefined, {}, { gate: PUBLISH_GATE });
    await toGate(page, w);
    const fixBranch = fixBranchOf(w);
    const report = reportOf(w).trim();
    const before = w.calls().length;

    await approveAtGate(page);

    await expect.soft.poll(() => flowStep(w), { timeout: 30_000 }).toBe('done');
    const comments = runComments(w);
    const opened = fixPrs(w, fixBranch);
    expect.soft(report).not.toBe('');
    expect.soft(comments).toHaveLength(1);
    expect.soft(forcePushes(w.calls())).toEqual([]);
    if (o.outcome === 'fix-pr') {
      expect.soft(w.remoteRef(`refs/heads/${fixBranch}`)).toBe(w.git(w.repo, ['rev-parse', fixBranch]));
      expect.soft(opened).toHaveLength(1);
      expect.soft(opened[0]?.isDraft).toBe(true);
      expect.soft(opened[0]?.baseRefName).toBe(w.headBranch);
      expect.soft(opened[0]?.body.trim()).toBe(report);
      expect.soft(linksTo(comments[0]?.body, w, opened[0]?.number)).toBe(true);
    } else {
      expect.soft(gitPushes(w, before)).toEqual([]);
      expect.soft(w.gh.read().pulls).toHaveLength(1);
      expect.soft(comments[0]?.body ?? '').toContain(report);
      if (o.outcome === 'patch-comment') {
        expect.soft(comments[0]?.body ?? '').toMatch(/^From [0-9a-f]{40} /m);
        expect.soft(comments[0]?.body ?? '').toContain(w.startHeadOid);
        expect.soft(comments[0]?.body ?? '').toContain('Fix the reviewed change');
      }
    }
    expect.soft(w.contractBreaches()).toEqual([]);
  });
}

const HOLDS: Array<{ title: string; before: (w: AdoptionWorld, fixBranch: string) => void; reason: (fixBranch: string) => RegExp }> = [
  { title: 'the report is missing at approval (AC 12)', before: (w) => rmSync(join(w.repo, ARTIFACT_REL)), reason: () => /report|plan\.md/i },
  {
    title: "a branch with the run's fix branch name appeared on GitHub after the start (AC 19)",
    before: (w, fixBranch) => void w.pushAs(fixBranch, 'other.txt', 'someone else\n', 'Someone else’s commit', w.startHeadOid),
    reason: (fixBranch) => new RegExp(fixBranch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')),
  },
  {
    title: 'the reviewed PR was closed before approval (AC 21)',
    before: (w) =>
      w.gh.update((state) => {
        for (const pull of state.pulls) if (pull.number === w.prNumber) pull.state = 'CLOSED';
      }),
    reason: () => /closed/i,
  },
];

for (const h of HOLDS) {
  test(`approving when ${h.title} writes nothing and holds the gate, showing the reason (#304)`, { tag: '@ownapp' }, async () => {
    test.setTimeout(WINDOW_TIMEOUT_MS + 180_000);
    const w = world({ prefix: 'agent-term-e2e-adopt-held' });
    const { app, page } = await launch(w, COMMITS_FIX, {}, { gate: PUBLISH_GATE });
    await toGate(page, w);
    const fixBranch = fixBranchOf(w);
    h.before(w, fixBranch);
    const github = JSON.stringify({ pulls: w.gh.read().pulls, comments: w.gh.read().comments });
    const before = w.calls().length;

    await approveAtGate(page);

    expect.soft(await heldReason(app)).toMatch(h.reason(fixBranch));
    expect.soft(flowStep(w)).toBe(STEP);
    expect.soft(JSON.stringify({ pulls: w.gh.read().pulls, comments: w.gh.read().comments })).toBe(github);
    expect.soft(ghWrites(w, before)).toEqual([]);
    expect.soft(gitPushes(w, before)).toEqual([]);
    expect.soft(forcePushes(w.calls())).toEqual([]);
    expect.soft(w.contractBreaches()).toEqual([]);
  });
}

test('when push permission drops from WRITE to READ after the gate shows, approving with a fix posts the patch comment and pushes nothing (#304 AC 22)', { tag: '@ownapp' }, async () => {
  test.setTimeout(WINDOW_TIMEOUT_MS + 180_000);
  const w = world({ prefix: 'agent-term-e2e-adopt-permission' });
  const { page } = await launch(w, COMMITS_FIX, {}, { gate: PUBLISH_GATE });
  await toGate(page, w);
  w.gh.update((state) => {
    for (const repo of state.repositories) repo.viewerPermission = 'READ';
  });
  const before = w.calls().length;

  await approveAtGate(page);

  await expect.soft.poll(() => flowStep(w), { timeout: 30_000 }).toBe('done');
  expect.soft(runComments(w)).toHaveLength(1);
  expect.soft(runComments(w)[0]?.body ?? '').toMatch(/^From [0-9a-f]{40} /m);
  expect.soft(gitPushes(w, before)).toEqual([]);
  expect.soft(w.gh.read().pulls).toHaveLength(1);
  expect.soft(w.contractBreaches()).toEqual([]);
});

test('a publish whose run comment failed completes on the next approve, with one fix PR and one run comment (#304 AC 23)', { tag: '@ownapp' }, async () => {
  test.setTimeout(WINDOW_TIMEOUT_MS + 180_000);
  const w = world({ prefix: 'agent-term-e2e-adopt-retry' });
  const { app, page } = await launch(w, COMMITS_FIX, {}, { gate: PUBLISH_GATE });
  await toGate(page, w);
  const fixBranch = fixBranchOf(w);
  w.gh.set({ failOnce: ['comment-create'] });

  await approveAtGate(page);
  const firstReason = await heldReason(app);
  expect.soft(flowStep(w)).toBe(STEP);
  expect.soft(fixPrs(w, fixBranch)).toHaveLength(1);
  await approveAtGate(page);

  await expect.soft.poll(() => flowStep(w), { timeout: 30_000 }).toBe('done');
  expect.soft(firstReason).not.toBeNull();
  expect.soft(fixPrs(w, fixBranch)).toHaveLength(1);
  expect.soft(runComments(w)).toHaveLength(1);
  expect.soft(linksTo(runComments(w)[0]?.body, w, fixPrs(w, fixBranch)[0]?.number)).toBe(true);
  expect.soft(forcePushes(w.calls())).toEqual([]);
  expect.soft(w.contractBreaches()).toEqual([]);
});

test("a new run on a PR an earlier run published to opens its own fix PR and run comment, leaving the earlier run's unchanged (#304 AC 13)", { tag: '@ownapp' }, async () => {
  test.setTimeout(WINDOW_TIMEOUT_MS + 180_000);
  const w = world({ prefix: 'agent-term-e2e-adopt-earlier' });
  const earlierBranch = 'agent-terminal/review-pr-41-1600000000000';
  const earlierOid = w.pushAs(earlierBranch, 'earlier.txt', 'an earlier run’s fix\n', 'An earlier run’s fix', w.startHeadOid);
  w.git(w.repo, ['fetch', '-q', 'origin', `${earlierBranch}:${earlierBranch}`]);
  w.gh.update((state) => {
    state.pulls.push({
      number: 880, state: 'OPEN', title: 'Review fixes for #41', body: 'The earlier run’s report.', isDraft: true, author: state.login,
      headRefName: earlierBranch, headRefOid: earlierOid, baseRefName: w.headBranch, headRepo: state.origin, isCrossRepository: false, closingIssues: [],
    });
    state.comments[String(w.prNumber)] = [{ id: 6001, login: state.login, body: `<!-- agent-terminal:pr-review-run:${earlierBranch} -->\nThe earlier run’s fix PR: #880` }];
  });
  const earlier = JSON.stringify({ pull: w.gh.read().pulls.find((p) => p.number === 880), comment: reviewedPrComments(w)[0] });
  const { page } = await launch(w, COMMITS_FIX, {}, { gate: PUBLISH_GATE });
  await toGate(page, w);
  const fixBranch = fixBranchOf(w);

  await approveAtGate(page);

  await expect.soft.poll(() => flowStep(w), { timeout: 30_000 }).toBe('done');
  const own = fixPrs(w, fixBranch);
  expect.soft(fixBranch).not.toBe(earlierBranch);
  expect.soft(own).toHaveLength(1);
  expect.soft(runComments(w)).toHaveLength(2);
  expect.soft(linksTo(runComments(w).find((c) => c.id !== 6001)?.body, w, own[0]?.number)).toBe(true);
  expect.soft(JSON.stringify({ pull: w.gh.read().pulls.find((p) => p.number === 880), comment: reviewedPrComments(w).find((c) => c.id === 6001) })).toBe(earlier);
  expect.soft(w.remoteRef(`refs/heads/${earlierBranch}`)).toBe(earlierOid);
  expect.soft(w.contractBreaches()).toEqual([]);
});

/** Starts a fork run whose primary is the fork's ticket, lets it reach its gate with a fix, then closes the app. */
async function toGateThenClose(w: AdoptionWorld): Promise<Launched> {
  const launched = await launch(w, COMMITS_FIX, {}, { gate: PUBLISH_GATE });
  await toGate(launched.page, w);
  await launched.app.close();
  return launched;
}

const FORK_PRIMARY: Omit<AdoptionWorldOptions, 'prefix'> = { pr: { fork: 'Contributor/Fork', closingIssues: [{ repo: 'contributor/fork', number: 177 }] } };

test('after a relaunch at the gate, approve acts on the same reviewed PR (#304 AC 24)', { tag: '@ownapp' }, async () => {
  test.setTimeout(2 * WINDOW_TIMEOUT_MS + 180_000);
  const w = world({ prefix: 'agent-term-e2e-adopt-relaunch' });
  const first = await launch(w, COMMITS_FIX, {}, { gate: PUBLISH_GATE });
  await toGate(first.page, w);
  const fixBranch = fixBranchOf(w);
  await first.app.close();

  const { page } = await launch(w, COMMITS_FIX, {}, { gate: PUBLISH_GATE, relaunchOf: first });
  await typeCommand(page, `cd ${shellQuote(w.repo)}`);
  await typeCommand(page, 'fake-agent');
  await approveAtGate(page);

  await expect.soft.poll(() => flowStep(w), { timeout: 30_000 }).toBe('done');
  const opened = fixPrs(w, fixBranch);
  expect.soft(opened).toHaveLength(1);
  expect.soft(opened[0]?.baseRefName).toBe(w.headBranch);
  expect.soft(runComments(w)).toHaveLength(1);
  expect.soft(linksTo(runComments(w)[0]?.body, w, opened[0]?.number)).toBe(true);
  expect.soft(w.contractBreaches()).toEqual([]);
});

const pickupConfirm = (page: Page): Locator => page.getByRole('alertdialog').filter({ hasText: /pull request/i });
/** The confirm dialog's text and the values of its fields, as the operator reads them. */
const dialogReads = (dialog: Locator): Promise<string> =>
  dialog.evaluate((el) => `${el.textContent ?? ''} ${[...el.querySelectorAll('input')].map((i) => i.value).join(' ')}`).catch(() => '');
const editableFields = (dialog: Locator): Promise<number> =>
  dialog.evaluate((el) => [...el.querySelectorAll('input, textarea, select')].filter((f) => !(f as HTMLInputElement).readOnly && !(f as HTMLInputElement).disabled).length).catch(() => -1);

test('a relaunched adopting run with no saved pickup is held, showing the PR and its primary read-only, and refuses the gate until confirmed (#304 AC 24)', { tag: '@ownapp' }, async () => {
  test.setTimeout(2 * WINDOW_TIMEOUT_MS + 180_000);
  const w = world({ prefix: 'agent-term-e2e-adopt-confirm', ...FORK_PRIMARY });
  const first = await toGateThenClose(w);
  rmSync(join(w.repo, ...RUN_PICKUP_REL));

  const { app, page } = await launch(w, COMMITS_FIX, {}, { gate: PUBLISH_GATE, relaunchOf: first });
  await typeCommand(page, `cd ${shellQuote(w.repo)}`);
  const dialog = pickupConfirm(page);
  await expect.soft(dialog).toBeVisible({ timeout: 15_000 });
  const reads = await dialogReads(dialog);
  expect.soft(reads).toMatch(namesPr(w.prNumber));
  expect.soft(reads).toMatch(namesTicket('contributor/fork', 177));
  expect.soft(await editableFields(dialog)).toBe(0);

  await use(dialog.getByRole('button', { name: 'Not now' }), (button) => button.click());
  await typeCommand(page, 'fake-agent');
  await approveAtGate(page);
  expect.soft(await heldReason(app)).toMatch(/confirm/i);
  expect.soft(flowStep(w)).toBe(STEP);
  expect.soft(ghWrites(w)).toEqual([]);

  await use(page.getByRole('button', { name: /^confirm .+/i }), (button) => button.click());
  await use(dialog.getByRole('button', { name: 'Confirm' }), (button) => button.click());
  await expect.soft(dialog).toBeHidden({ timeout: 15_000 });
  await approveAtGate(page);
  await expect.soft.poll(() => flowStep(w), { timeout: 30_000 }).toBe('done');
  expect.soft(runComments(w)).toHaveLength(1);
  expect.soft(runComments(w)[0]?.body ?? '').toMatch(/^From [0-9a-f]{40} /m);
  expect.soft(w.contractBreaches()).toEqual([]);
});

test("a relaunched adopting run's confirm passes when the PR also closes a ticket in a third repository (#304 AC 24)", { tag: '@ownapp' }, async () => {
  test.setTimeout(2 * WINDOW_TIMEOUT_MS + 180_000);
  const w = world({
    prefix: 'agent-term-e2e-adopt-confirm-elsewhere',
    pr: { fork: 'Contributor/Fork', closingIssues: [{ repo: 'contributor/fork', number: 177 }, { repo: 'elsewhere/other', number: 9 }] },
  });
  const first = await toGateThenClose(w);
  rmSync(join(w.repo, ...RUN_PICKUP_REL));

  const { page } = await launch(w, COMMITS_FIX, {}, { gate: PUBLISH_GATE, relaunchOf: first });
  await typeCommand(page, `cd ${shellQuote(w.repo)}`);
  const dialog = pickupConfirm(page);
  await expect.soft(dialog).toBeVisible({ timeout: 15_000 });
  await use(dialog.getByRole('button', { name: 'Confirm' }), (button) => button.click());
  await expect.soft(dialog).toBeHidden({ timeout: 15_000 });
  await typeCommand(page, 'fake-agent');
  await approveAtGate(page);
  await expect.soft.poll(() => flowStep(w), { timeout: 30_000 }).toBe('done');
  expect.soft(runComments(w)).toHaveLength(1);
  expect.soft(w.contractBreaches()).toEqual([]);
});

test("a relaunched adopting run's confirm is refused when the PR now closes the primary's number in another repository instead (#304 AC 24)", { tag: '@ownapp' }, async () => {
  test.setTimeout(2 * WINDOW_TIMEOUT_MS + 180_000);
  const w = world({ prefix: 'agent-term-e2e-adopt-confirm-repo', ...FORK_PRIMARY });
  const first = await toGateThenClose(w);
  rmSync(join(w.repo, ...RUN_PICKUP_REL));
  w.gh.update((state) => {
    for (const pr of state.pulls) if (pr.number === w.prNumber) pr.closingIssues = [{ repo: 'owner/repo', number: 177 }];
  });

  const { page } = await launch(w, COMMITS_FIX, {}, { gate: PUBLISH_GATE, relaunchOf: first });
  await typeCommand(page, `cd ${shellQuote(w.repo)}`);
  const dialog = pickupConfirm(page);
  await expect.soft(dialog).toBeVisible({ timeout: 15_000 });
  await use(dialog.getByRole('button', { name: 'Confirm' }), (button) => button.click());
  await expect.soft(dialog.getByRole('alert')).toHaveText(/177/, { timeout: 30_000 });
  await expect.soft(dialog).toBeVisible();
  expect.soft(existsSync(join(w.repo, ...RUN_PICKUP_REL))).toBe(false);
  expect.soft(flowStep(w)).toBe(STEP);
  expect.soft(ghWrites(w)).toEqual([]);
  expect.soft(w.contractBreaches()).toEqual([]);
});

test('a relaunched adopting run with neither its saved pickup nor its start record names the PR, says the primary cannot be recovered, and refuses the confirm (#304 AC 24)', { tag: '@ownapp' }, async () => {
  test.setTimeout(2 * WINDOW_TIMEOUT_MS + 180_000);
  const w = world({ prefix: 'agent-term-e2e-adopt-unrecoverable', ...FORK_PRIMARY });
  const first = await toGateThenClose(w);
  rmSync(join(w.repo, ...RUN_PICKUP_REL));
  rmSync(join(w.repo, ...BOOTSTRAP_REL));

  const { page } = await launch(w, COMMITS_FIX, {}, { gate: PUBLISH_GATE, relaunchOf: first });
  await typeCommand(page, `cd ${shellQuote(w.repo)}`);
  const dialog = pickupConfirm(page);
  await expect.soft(dialog).toBeVisible({ timeout: 15_000 });
  const reads = await dialogReads(dialog);
  expect.soft(reads).toMatch(namesPr(w.prNumber));
  expect.soft(reads).toMatch(/can(no|')t be recovered|cannot recover|unrecoverable/i);
  expect.soft(reads).toMatch(/terminate/i);

  await use(dialog.getByRole('button', { name: 'Confirm' }), (button) => button.click());
  await expect.soft(dialog.getByRole('alert')).toHaveText(/terminat|can(no|')t be recovered|cannot recover|unrecoverable/i, { timeout: 30_000 });
  await expect.soft(dialog).toBeVisible();
  expect.soft(existsSync(join(w.repo, ...RUN_PICKUP_REL))).toBe(false);
  expect.soft(flowStep(w)).toBe(STEP);
  expect.soft(ghWrites(w)).toEqual([]);
  expect.soft(w.contractBreaches()).toEqual([]);
});
