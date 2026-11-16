import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { appendFileSync, mkdirSync, readFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runAppGateDecision, type AppGateDecisionDeps } from '../../src/main/appGateDecision';
import { resolveAppGateRefs } from '../../src/main/appLoopBootstrap';
import { createRealAppGateGitHub } from '../../src/main/appGateGithub';
import { createRealAppGateCommit } from '../../src/main/appGateCommit';
import { createRealAppGatePush } from '../../src/main/appGatePush';
import { runAdoptionStart } from '../../src/main/adoptionStart';
import { createRealAdoptionGit, createRealAdoptionGitHub } from '../../src/main/adoptionPorts';
import { clearAppLoopBootstrap, writeAdoptedPickup, writeAdoptedPickupIntent, type AppLoopRunState } from '../../src/main/appLoopState';
import type { AdoptedPickup, TicketRef } from '../../src/shared/appBootstrap';
import type { RunPickup } from '../../src/main/trustedPickups';
import type { GateOptionDef, LoopDefV2 } from '../../src/main/loopDefV2';
import type { AdoptionGhState, StandInComment, StandInPull } from '../helpers/adoptionGh';
import { createAdoptionWorld, type AdoptionWorld, type AdoptionWorldOptions } from '../helpers/adoptionWorld';
import { forcePushes, gitSubcommand, outwardWrites } from '../helpers/outwardWrites';

// Each row drives real git against a bare remote, which a loaded parallel run slows well past vitest's default.
vi.setConfig({ testTimeout: 30_000 });

// #304 slice 4 — approving an adopting run's gate with `publish-pr-review` publishes exactly one outcome (a draft fix
// PR into the reviewed PR's head branch plus a linking run comment, a report comment, or a report-and-patch comment),
// or writes nothing and holds the gate with the reason. The run is started by the real adoption start in the adoption
// world, and the gate runs the app's real side-effect executors against its git and gh stand-in.

const STEP = 'review';
const TURN_KEY = 'consolidate-review';
const AT_GATE: AppLoopRunState = { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'complete', round: 1, verdict: 'clean' };
const STARTED_AT = 1_700_000_000_000;
const PUBLISH: GateOptionDef[] = [{ option: 'approve', sideEffects: [{ kind: 'gh', args: { action: 'publish-pr-review', artifact: 'report' } }] }];
const REPORT = 'A report this run wrote.\n\nIt found one thing to fix.\n';
const LIMIT = 65_536;

interface Adopted {
  w: AdoptionWorld;
  pickup: AdoptedPickup;
  /** Where the adopting step's report artifact lives. */
  report: string;
}

async function adoptedRun(options: Omit<AdoptionWorldOptions, 'prefix'> = {}, pick?: TicketRef): Promise<Adopted> {
  const w = createAdoptionWorld({ prefix: 'publish-pr-review', ...options });
  onTestFinished(({ task }) => {
    try {
      w.dispose();
    } catch (e) {
      if (task.result?.state !== 'fail') throw e;
    }
  });
  w.activate();
  appendFileSync(join(w.repo, '.git', 'info', 'exclude'), '.agent-terminal/\n');
  return startRun(w, STARTED_AT, pick);
}

/** Starts an adopting run on the world's PR with the real adoption start, and writes its report. */
async function startRun(w: AdoptionWorld, startedAt: number, pick?: TicketRef): Promise<Adopted> {
  const started = await runAdoptionStart(
    {
      git: createRealAdoptionGit(w.repo),
      github: createRealAdoptionGitHub(w.repo),
      prepareRecord: (intent) => writeAdoptedPickupIntent(w.repo, intent),
      writeRecord: (pickup) => writeAdoptedPickup(w.repo, pickup),
      clearRecord: () => clearAppLoopBootstrap(w.repo),
    },
    { pr: w.prNumber, startedAt, ...(pick === undefined ? {} : { pick }) },
  );
  if (!started.ok) throw new Error(`the adoption start was refused: ${started.kind === 'error' ? started.error : started.kind}`);
  const report = join(w.repo, '.agent-terminal', 'report.md');
  mkdirSync(join(w.repo, '.agent-terminal'), { recursive: true });
  writeFileSync(report, REPORT);
  return { w, pickup: started.identity, report };
}

/** One fix commit on the checked-out fix branch, as the run's loop would make it. */
function commitFix(run: Adopted, path: string, contents: string, message: string): string {
  writeFileSync(join(run.w.repo, path), contents);
  run.w.git(run.w.repo, ['add', '--', path]);
  run.w.git(run.w.repo, ['commit', '-q', '-m', message]);
  return run.w.git(run.w.repo, ['rev-parse', 'HEAD']);
}

interface Outcome {
  accepted: number;
  advanced: number;
  errors: string[];
}

interface ApproveOptions {
  /** The pickup the gate trusts; default the run's own. */
  pickup?: RunPickup | null;
  /** The report artifact's path; default the run's report. */
  reportPath?: string;
}

async function approve(run: Adopted, options: ApproveOptions = {}): Promise<Outcome> {
  const outcome: Outcome = { accepted: 0, advanced: 0, errors: [] };
  const pickup = options.pickup === undefined ? run.pickup : options.pickup;
  const def = { gate: PUBLISH, inputs: [], outputs: [{ id: 'report', path: options.reportPath ?? run.report }], work: { recipe: '/r', artifact: 'report' } } as unknown as LoopDefV2;
  const deps: AppGateDecisionDeps = {
    readRunState: () => AT_GATE,
    resolveDef: () => ({ ok: true, def, tierRoot: run.w.repo, defDir: run.w.repo }),
    refs: () => resolveAppGateRefs({ pr: run.w.prNumber }, pickup),
    runSideEffect: createRealAppGateGitHub(run.w.repo),
    runCommitSideEffect: createRealAppGateCommit(run.w.repo),
    runPushSideEffect: createRealAppGatePush(run.w.repo),
    failureHoldsGate: () => true,
    assembleReport: () => {},
    recordBaseline: () => {},
    persistAccept: () => void (outcome.accepted += 1),
    advanceFlow: () => void (outcome.advanced += 1),
    audit: () => {},
    emitError: (reason) => void outcome.errors.push(reason),
    emitNotice: () => {},
    onViewChanged: () => {},
    deliverFeedback: () => true,
    deliverRedo: () => true,
    enterPolish: () => {},
    clearPolish: () => {},
    reopenSlice: () => false,
    recordSliceBrief: () => {},
    clearSliceBrief: () => {},
    reopenStep: () => null,
    sourceSliceCount: () => {},
    maybeBeginEpicPromotion: () => ({ kind: 'not-epic' }),
    readStepDecision: () => ({ kind: 'none' }),
    recordDecision: () => ({ undo: () => true }),
    auditDecision: () => undefined,
  };
  await runAppGateDecision(run.w.repo, STEP, TURN_KEY, 'approve', deps);
  return outcome;
}

const prUrl = (w: AdoptionWorld, number: number): string => `https://github.com/${w.origin}/pull/${number}`;
/** Whether a run comment links to PR `number`: its URL, or the `#N` reference GitHub links. */
const linksTo = (w: AdoptionWorld, body: string | undefined, number: number | undefined): boolean =>
  body !== undefined && number !== undefined && (body.includes(prUrl(w, number)) || new RegExp(`(^|[^\\w/])#${number}(?!\\d)`).test(body));
const pulls = (w: AdoptionWorld): StandInPull[] => w.gh.read().pulls;
/** The PRs opened from `branch`, other than the reviewed PR. */
const fixPrs = (w: AdoptionWorld, branch: string): StandInPull[] => pulls(w).filter((p) => p.number !== w.prNumber && p.headRefName === branch);
const comments = (w: AdoptionWorld): StandInComment[] => w.gh.read().comments[String(w.prNumber)] ?? [];
const runComments = (w: AdoptionWorld): StandInComment[] => comments(w).filter((c) => c.login === w.gh.read().login);
const pushes = (run: Adopted, from: number) => run.w.calls().slice(from).filter((c) => c.tool === 'git' && gitSubcommand(c.argv).name === 'push');
/** Every number a reason names, commas and spaces between digit groups read as one number. */
/** The sizes a hold reason states: its numbers, past the fix branch's run key and any commit IDs it names. */
const sizesIn = (run: Adopted, reason: string): number[] => numbersIn(reason.split(run.pickup.fixBranch).join(' ').replace(/\b[0-9a-f]{7,40}\b/g, ' '));
const numbersIn = (reason: string): number[] => [...reason.matchAll(/\d[\d,  ]*\d|\d/g)].map((m) => Number(m[0].replace(/[,  ]/g, '')));

/** The fenced blocks of a Markdown body, as CommonMark closes them: a fence of the same character at least as long. */
function fencedBlocks(body: string): string[] {
  const lines = body.split('\n');
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i] ?? '');
    if (open === null) continue;
    const fence = open[1] ?? '';
    const close = lines.findIndex((l, j) => j > i && new RegExp(`^ {0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(l));
    const end = close < 0 ? lines.length : close;
    blocks.push(`${lines.slice(i + 1, end).join('\n')}\n`);
    i = end;
  }
  return blocks;
}

/** The `git format-patch` series a run comment carries, if any. */
const patchIn = (body: string): string | undefined => fencedBlocks(body).find((b) => /^From [0-9a-f]{40} /m.test(b) && /^Subject: /m.test(b));

interface Applied {
  error: string | null;
  /** Each applied commit's whole message, oldest first. */
  messages: string[];
  tree: string | null;
}

/** Each commit's whole message in `range`, oldest first. */
const messagesIn = (w: AdoptionWorld, dir: string, range: string): string[] =>
  w.git(dir, ['log', '--reverse', '--format=%B%x00', range]).split('\0').map((m) => m.trim()).filter((m) => m !== '');

/** Applies `patch` with `git am` in a fresh repository holding only `base` and its history. */
function applyPatch(w: AdoptionWorld, base: string, patch: string | undefined): Applied {
  if (patch === undefined) return { error: 'no patch in the comment', messages: [], tree: null };
  const dir = mkdtempSync(join(tmpdir(), 'publish-pr-review-am-'));
  try {
    w.git(dir, ['init', '-q']);
    w.git(dir, ['fetch', '-q', w.repo, base]);
    w.git(dir, ['checkout', '-q', '--detach', base]);
    const file = join(dir, '..', `${basename(dir)}.patch`);
    writeFileSync(file, patch);
    try {
      w.git(dir, ['am', '-q', file]);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), messages: [], tree: null };
    } finally {
      rmSync(file, { force: true });
    }
    return { error: null, messages: messagesIn(w, dir, `${base}..HEAD`), tree: w.git(dir, ['rev-parse', 'HEAD^{tree}']) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A fix commit message whose body holds lines of backticks, which a patch carries unprefixed. */
const FENCED_MESSAGE = 'Quote the reviewed code in the message\n\n```\nconst quoted = true;\n````\n```';

const treeOf = (run: Adopted): string => run.w.git(run.w.repo, ['rev-parse', `${run.pickup.fixBranch}^{tree}`]);
const fixHead = (run: Adopted): string => run.w.git(run.w.repo, ['rev-parse', run.pickup.fixBranch]);

describe('approving with fix commits when the operator can push opens a draft fix PR and links it (#304 AC 9)', () => {
  it('pushes the fix branch without force, opens a draft PR into the head branch whose body is the report, and posts one linking run comment', async () => {
    const run = await adoptedRun();
    commitFix(run, 'change.txt', 'the fixed change\n', 'Fix the reviewed change');
    const before = run.w.calls().length;

    const outcome = await approve(run);

    const opened = fixPrs(run.w, run.pickup.fixBranch);
    expect.soft(outcome.errors).toEqual([]);
    expect.soft(outcome.accepted).toBe(1);
    expect.soft(outcome.advanced).toBe(1);
    expect.soft(run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)).toBe(fixHead(run));
    expect.soft(pushes(run, before)).not.toEqual([]);
    expect.soft(forcePushes(run.w.calls().slice(before))).toEqual([]);
    expect.soft(opened).toHaveLength(1);
    expect.soft(opened[0]?.isDraft).toBe(true);
    expect.soft(opened[0]?.baseRefName).toBe(run.w.headBranch);
    expect.soft(opened[0]?.body.trim()).toBe(REPORT.trim());
    expect.soft(opened[0]?.title.trim()).not.toBe('');
    expect.soft(opened[0]?.title ?? '').not.toContain('Reviewed PR title, never intent');
    expect.soft(runComments(run.w)).toHaveLength(1);
    expect.soft(linksTo(run.w, runComments(run.w)[0]?.body, opened[0]?.number)).toBe(true);
    expect.soft(run.w.contractBreaches()).toEqual([]);
  });

  it("still publishes when the PR's author force-pushed its head after the start, and the fix PR is the fix branch as it is", async () => {
    const run = await adoptedRun();
    commitFix(run, 'change.txt', 'the fixed change\n', 'Fix the reviewed change');
    run.w.forcePushPrHead('Reviewed PR change, reworded by its author');

    const outcome = await approve(run);

    expect.soft(outcome.errors).toEqual([]);
    expect.soft(outcome.accepted).toBe(1);
    expect.soft(run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)).toBe(fixHead(run));
    expect.soft(fixPrs(run.w, run.pickup.fixBranch)).toHaveLength(1);
    expect.soft(runComments(run.w)).toHaveLength(1);
  });
});

describe('approving with no fix commits posts the report as the run comment (#304 AC 10)', () => {
  it('pushes nothing, opens no PR, and posts one run comment holding the report', async () => {
    const run = await adoptedRun();
    const before = run.w.calls().length;

    const outcome = await approve(run);

    expect.soft(outcome.errors).toEqual([]);
    expect.soft(outcome.accepted).toBe(1);
    expect.soft(pushes(run, before)).toEqual([]);
    expect.soft(run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)).toBeNull();
    expect.soft(pulls(run.w)).toHaveLength(1);
    expect.soft(runComments(run.w)).toHaveLength(1);
    expect.soft(runComments(run.w)[0]?.body ?? '').toContain(REPORT.trim());
    expect.soft(run.w.contractBreaches()).toEqual([]);
  });
});

const CANNOT_PUSH: Array<{ title: string; world: Omit<AdoptionWorldOptions, 'prefix'> }> = [
  { title: 'the reviewed PR is a fork', world: { pr: { fork: 'Contributor/Fork' } } },
  { title: 'the operator has no write permission on its head repository', world: { viewerPermission: 'READ' } },
];

describe('approving with fix commits when the operator cannot push posts the report and a git format-patch patch (#304 AC 11)', () => {
  it.each(CANNOT_PUSH)('when $title: no push, no PR, and one comment whose patch applies with git am onto the fetched head, one commit per fix commit', async ({ world }) => {
    const run = await adoptedRun(world);
    commitFix(run, 'change.txt', 'the fixed change\n', 'Fix the reviewed change');
    commitFix(run, 'quoted.ts', 'export const quoted = true;\n', FENCED_MESSAGE);
    const before = run.w.calls().length;

    const outcome = await approve(run);

    const comment = runComments(run.w)[0]?.body ?? '';
    const applied = applyPatch(run.w, run.w.startHeadOid, patchIn(comment));
    expect.soft(outcome.errors).toEqual([]);
    expect.soft(outcome.accepted).toBe(1);
    expect.soft(pushes(run, before)).toEqual([]);
    expect.soft(pulls(run.w)).toHaveLength(1);
    expect.soft(runComments(run.w)).toHaveLength(1);
    expect.soft(comment).toContain(REPORT.trim());
    expect.soft(patchIn(comment) ?? '').toContain(run.w.startHeadOid);
    expect.soft(applied.error).toBeNull();
    expect.soft(applied.messages).toEqual(messagesIn(run.w, run.w.repo, `${run.w.startHeadOid}..${run.pickup.fixBranch}`));
    expect.soft(applied.messages).toHaveLength(2);
    expect.soft(applied.tree).toBe(treeOf(run));
    expect.soft(run.w.contractBreaches()).toEqual([]);
  });

  it('gives one combined commit carrying the whole change when a merge is among the fix commits', async () => {
    const run = await adoptedRun({ pr: { fork: 'Contributor/Fork' } });
    const fixBranch = run.pickup.fixBranch;
    run.w.git(run.w.repo, ['checkout', '-q', '-b', 'side']);
    commitFix(run, 'side.txt', 'a fix made on a side branch\n', 'Fix on the side');
    run.w.git(run.w.repo, ['checkout', '-q', fixBranch]);
    commitFix(run, 'change.txt', 'the fixed change\n', 'Fix the reviewed change');
    run.w.git(run.w.repo, ['merge', '-q', '--no-ff', '-m', 'Merge the side fix', 'side']);

    const outcome = await approve(run);

    const patch = patchIn(runComments(run.w)[0]?.body ?? '');
    const applied = applyPatch(run.w, run.w.startHeadOid, patch);
    expect.soft(outcome.accepted).toBe(1);
    expect.soft(patch ?? '').toContain(run.w.startHeadOid);
    expect.soft(applied.error).toBeNull();
    expect.soft(applied.messages).toHaveLength(1);
    expect.soft(applied.tree).toBe(treeOf(run));
  });

  it("bases the patch on the head the run fetched when the PR's author force-pushed since", async () => {
    const run = await adoptedRun({ pr: { fork: 'Contributor/Fork' } });
    commitFix(run, 'change.txt', 'the fixed change\n', 'Fix the reviewed change');
    const moved = run.w.forcePushPrHead('Reviewed PR change, reworded by its author');

    const outcome = await approve(run);

    const patch = patchIn(runComments(run.w)[0]?.body ?? '');
    const applied = applyPatch(run.w, run.w.startHeadOid, patch);
    expect.soft(outcome.accepted).toBe(1);
    expect.soft(patch ?? '').toContain(run.w.startHeadOid);
    expect.soft(patch ?? '').not.toContain(moved);
    expect.soft(applied.error).toBeNull();
    expect.soft(applied.tree).toBe(treeOf(run));
  });
});

/** Asserts that approving wrote nothing to GitHub and held the gate with one reason; returns the reason. */
async function expectHeld(run: Adopted, options: ApproveOptions = {}): Promise<string> {
  const before = run.w.calls().length;
  const pullsBefore = JSON.stringify(pulls(run.w));
  const commentsBefore = JSON.stringify(run.w.gh.read().comments);
  const outcome = await approve(run, options);
  expect.soft(outcome.accepted).toBe(0);
  expect.soft(outcome.advanced).toBe(0);
  expect.soft(outcome.errors).toHaveLength(1);
  expect.soft(JSON.stringify(pulls(run.w))).toBe(pullsBefore);
  expect.soft(JSON.stringify(run.w.gh.read().comments)).toBe(commentsBefore);
  expect.soft(outwardWrites(run.w.calls().slice(before))).toEqual([]);
  expect.soft(forcePushes(run.w.calls().slice(before))).toEqual([]);
  expect.soft(run.w.contractBreaches()).toEqual([]);
  return outcome.errors.join('\n');
}

/** A reason that names the report: the artifact, or its file. */
const NAMES_REPORT = /report/i;

describe('a report that is not this run’s writes nothing and holds the gate (#304 AC 12)', () => {
  it('a missing report', async () => {
    const run = await adoptedRun();
    commitFix(run, 'fix.txt', 'a fix\n', 'Fix the reviewed change');
    rmSync(run.report);
    const reason = await expectHeld(run);
    expect.soft(run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)).toBeNull();
    expect.soft(reason).toMatch(NAMES_REPORT);
    expect.soft(reason).toMatch(/missing|not found|no such|does not exist|absent|ENOENT|could not (be )?read/i);
  });

  it('an empty report', async () => {
    const run = await adoptedRun();
    commitFix(run, 'fix.txt', 'a fix\n', 'Fix the reviewed change');
    writeFileSync(run.report, '  \n\n');
    const reason = await expectHeld(run);
    expect.soft(run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)).toBeNull();
    expect.soft(reason).toMatch(NAMES_REPORT);
    expect.soft(reason).toMatch(/empty|blank/i);
  });

  it('a report that is a symlink out of the repository', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'publish-pr-review-outside-'));
    onTestFinished(() => rmSync(outside, { recursive: true, force: true }));
    const run = await adoptedRun();
    commitFix(run, 'fix.txt', 'a fix\n', 'Fix the reviewed change');
    writeFileSync(join(outside, 'secret.md'), 'a file outside the repository\n');
    rmSync(run.report);
    symlinkSync(join(outside, 'secret.md'), run.report);
    const reason = await expectHeld(run);
    expect.soft(run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)).toBeNull();
    expect.soft(reason).toMatch(NAMES_REPORT);
    expect.soft(reason).toMatch(/link|outside|escapes|not a (regular )?file/i);
  });

  it("a report that is the reviewed PR's own file at that path, unchanged", async () => {
    const run = await adoptedRun();
    commitFix(run, 'fix.txt', 'a fix\n', 'Fix the reviewed change');
    const reason = await expectHeld(run, { reportPath: join(run.w.repo, 'change.txt') });
    expect.soft(run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)).toBeNull();
    expect.soft(reason).toMatch(/change\.txt|report/i);
    expect.soft(reason).toMatch(/unchanged|identical|same|reviewed PR's own|this run/i);
  });

  it("a report that is the reviewed PR's own file as checked out through an end-of-line filter", async () => {
    const run = await adoptedRun();
    commitFix(run, 'fix.txt', 'a fix\n', 'Fix the reviewed change');
    const committed = readFileSync(join(run.w.repo, 'change.txt'), 'utf8');
    writeFileSync(join(run.w.repo, '.gitattributes'), 'change.txt text eol=crlf\n');
    writeFileSync(join(run.w.repo, 'change.txt'), committed.replace(/\r?\n/g, '\r\n'));
    const reason = await expectHeld(run, { reportPath: join(run.w.repo, 'change.txt') });
    expect.soft(run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)).toBeNull();
    expect.soft(reason).toMatch(/unchanged|identical|same|reviewed PR's own|this run/i);
  });

  it("publishes a report at a path the reviewed PR also has, once this run changed it", async () => {
    const run = await adoptedRun();
    const report = 'This run’s report, written over the reviewed PR’s file\n';
    commitFix(run, 'change.txt', report, 'Fix the reviewed change');

    const outcome = await approve(run, { reportPath: join(run.w.repo, 'change.txt') });

    expect.soft(outcome.errors).toEqual([]);
    expect.soft(outcome.accepted).toBe(1);
    expect.soft(fixPrs(run.w, run.pickup.fixBranch)[0]?.body).toBe(report);
  });
});

describe('a fix branch that appeared on GitHub after the start writes nothing and holds, naming it (#304 AC 19)', () => {
  it('leaves the remote branch as it is, opens no PR and posts no comment', async () => {
    const run = await adoptedRun();
    commitFix(run, 'change.txt', 'the fixed change\n', 'Fix the reviewed change');
    const theirs = run.w.pushAs(run.pickup.fixBranch, 'other.txt', 'someone else\n', 'Someone else’s commit', run.w.startHeadOid);

    expect.soft(await expectHeld(run)).toContain(run.pickup.fixBranch);
    expect.soft(run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)).toBe(theirs);
  });

  it('holds a run with no fix commit, posting no report comment', async () => {
    const run = await adoptedRun();
    const theirs = run.w.pushAs(run.pickup.fixBranch, 'other.txt', 'someone else\n', 'Someone else’s commit', run.w.startHeadOid);

    expect.soft(await expectHeld(run)).toContain(run.pickup.fixBranch);
    expect.soft(run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)).toBe(theirs);
  });

  it('holds a run that cannot push, posting no patch comment', async () => {
    const run = await adoptedRun({ viewerPermission: 'READ' });
    commitFix(run, 'change.txt', 'the fixed change\n', 'Fix the reviewed change');
    const theirs = run.w.pushAs(run.pickup.fixBranch, 'other.txt', 'someone else\n', 'Someone else’s commit', run.w.startHeadOid);

    expect.soft(await expectHeld(run)).toContain(run.pickup.fixBranch);
    expect.soft(run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)).toBe(theirs);
  });
});

describe('a body over the size limit writes nothing and holds, naming the body and its size (#304 AC 20)', () => {
  it('a report over the limit, as the fix PR body', async () => {
    const run = await adoptedRun();
    commitFix(run, 'change.txt', 'the fixed change\n', 'Fix the reviewed change');
    writeFileSync(run.report, 'r'.repeat(LIMIT + 1));

    const reason = await expectHeld(run);
    expect.soft(run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)).toBeNull();
    expect.soft(reason).toMatch(/fix PR|PR body|pull request/i);
    expect.soft(sizesIn(run, reason)).toContain(LIMIT + 1);
    expect.soft(sizesIn(run, reason)).toContain(LIMIT);
  });

  it('a report under the limit that is over it with the patch, as the run comment', async () => {
    const run = await adoptedRun({ pr: { fork: 'Contributor/Fork' } });
    commitFix(run, 'change.txt', `${'x'.repeat(2_000)}\n`, 'Fix the reviewed change');
    writeFileSync(run.report, 'r'.repeat(LIMIT - 500));

    const reason = await expectHeld(run);
    expect.soft(reason).toMatch(/comment/i);
    expect.soft(sizesIn(run, reason).some((n) => n > LIMIT && n < 2 * LIMIT)).toBe(true);
    expect.soft(sizesIn(run, reason)).toContain(LIMIT);
  });

  it('a report of exactly the limit, as the run comment, is over it with the marker', async () => {
    const run = await adoptedRun();
    writeFileSync(run.report, '€'.repeat(LIMIT));

    const reason = await expectHeld(run);
    expect.soft(reason).toMatch(/comment/i);
    expect.soft(sizesIn(run, reason).some((n) => n > LIMIT && n < 2 * LIMIT)).toBe(true);
    expect.soft(sizesIn(run, reason)).toContain(LIMIT);
  });

  it('publishes a fix PR body of exactly the limit, in three-byte characters, intact', async () => {
    const run = await adoptedRun();
    commitFix(run, 'change.txt', 'the fixed change\n', 'Fix the reviewed change');
    const report = '€'.repeat(LIMIT);
    writeFileSync(run.report, report);

    const outcome = await approve(run);

    expect.soft(outcome.errors).toEqual([]);
    expect.soft(outcome.accepted).toBe(1);
    expect.soft(fixPrs(run.w, run.pickup.fixBranch)[0]?.body).toBe(report);
    expect.soft(runComments(run.w)).toHaveLength(1);
    expect.soft(run.w.contractBreaches()).toEqual([]);
  });
});

const NOT_THE_RECORDED_PR: Array<{ title: string; change: (pr: StandInPull, state: AdoptionGhState) => void; reason: RegExp }> = [
  { title: 'the PR is closed', change: (pr) => void (pr.state = 'CLOSED'), reason: /closed/i },
  { title: 'the PR is merged', change: (pr) => void (pr.state = 'MERGED'), reason: /merged/i },
  { title: 'the PR no longer closes the recorded ticket', change: (pr) => void (pr.closingIssues = []), reason: /176/ },
  {
    title: "the PR closes the recorded ticket's number in another repository instead",
    change: (pr) => void (pr.closingIssues = [{ repo: 'contributor/fork', number: 176 }]),
    reason: /176/,
  },
  { title: 'its head branch differs from the record', change: (pr) => void (pr.headRefName = 'feature/renamed'), reason: /feature\/renamed|head branch/i },
  {
    title: 'its head repository differs from the record',
    change: (pr, state) => {
      pr.headRepo = 'owner/elsewhere';
      state.repositories.push({ nameWithOwner: 'owner/elsewhere', defaultBranch: 'main', viewerPermission: 'WRITE' });
    },
    reason: /owner\/elsewhere|head repositor/i,
  },
  { title: 'its fork flag differs from the record', change: (pr) => void (pr.isCrossRepository = true), reason: /fork|another repository|cross/i },
  { title: 'GitHub reports no head repository', change: (pr) => void (pr.headRepo = null), reason: /head repositor|deleted|fork/i },
];

describe('a reviewed PR that is no longer the one the run recorded writes nothing and holds with the reason (#304 AC 21)', () => {
  it.each(NOT_THE_RECORDED_PR)('$title', async ({ change, reason }) => {
    const run = await adoptedRun();
    commitFix(run, 'change.txt', 'the fixed change\n', 'Fix the reviewed change');
    run.w.gh.update((state) => {
      const pr = state.pulls.find((p) => p.number === run.w.prNumber);
      if (pr) change(pr, state);
    });

    expect.soft(await expectHeld(run)).toMatch(reason);
    expect.soft(run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)).toBeNull();
  });

  it.each([
    { title: 'the ticket that is not the primary', dropped: 177 },
    { title: 'the primary ticket', dropped: 176 },
  ])('the PR stops closing one of two recorded tickets: $title', async ({ dropped }) => {
    const run = await adoptedRun({ pr: { closingIssues: [{ repo: 'owner/repo', number: 176 }, { repo: 'owner/repo', number: 177 }] } }, { repo: 'owner/repo', number: 176 });
    commitFix(run, 'change.txt', 'the fixed change\n', 'Fix the reviewed change');
    run.w.gh.update((state) => {
      for (const pr of state.pulls) if (pr.number === run.w.prNumber) pr.closingIssues = pr.closingIssues.filter((t) => t.number !== dropped);
    });

    expect.soft(await expectHeld(run)).toMatch(new RegExp(`(^|\\D)${dropped}(\\D|$)`));
    expect.soft(run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)).toBeNull();
  });

  it('no trusted pickup', async () => {
    const run = await adoptedRun();
    commitFix(run, 'change.txt', 'the fixed change\n', 'Fix the reviewed change');
    expect.soft(await expectHeld(run, { pickup: null })).toMatch(/pickup|adopt/i);
    expect.soft(run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)).toBeNull();
  });

  it("a ticket run's pickup", async () => {
    const run = await adoptedRun();
    commitFix(run, 'change.txt', 'the fixed change\n', 'Fix the reviewed change');
    const ticketRun = { kind: 'opened' as const, pr: run.w.prNumber, branch: run.pickup.fixBranch, issue: 176, initialStatus: 'planning' };
    expect.soft(await expectHeld(run, { pickup: ticketRun })).toMatch(/adopt/i);
    expect.soft(run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)).toBeNull();
  });
});

describe('the outcome follows whether the operator can push at approval, not at the start (#304 AC 22)', () => {
  it('permission dropped from WRITE to READ after the start gives the patch comment and no push', async () => {
    const run = await adoptedRun();
    commitFix(run, 'change.txt', 'the fixed change\n', 'Fix the reviewed change');
    run.w.gh.update((state) => {
      for (const repo of state.repositories) repo.viewerPermission = 'READ';
    });
    const before = run.w.calls().length;

    const outcome = await approve(run);

    expect.soft(outcome.accepted).toBe(1);
    expect.soft(pushes(run, before)).toEqual([]);
    expect.soft(pulls(run.w)).toHaveLength(1);
    expect.soft(applyPatch(run.w, run.w.startHeadOid, patchIn(runComments(run.w)[0]?.body ?? '')).tree).toBe(treeOf(run));
  });

  it('permission raised from READ to WRITE after the start gives the fix PR', async () => {
    const run = await adoptedRun({ viewerPermission: 'READ' });
    commitFix(run, 'change.txt', 'the fixed change\n', 'Fix the reviewed change');
    run.w.gh.update((state) => {
      for (const repo of state.repositories) repo.viewerPermission = 'WRITE';
    });

    const outcome = await approve(run);

    expect.soft(outcome.accepted).toBe(1);
    expect.soft(run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)).toBe(fixHead(run));
    expect.soft(fixPrs(run.w, run.pickup.fixBranch)).toHaveLength(1);
  });
});

describe('a publish that failed part-way completes on the next approve without writing anything twice (#304 AC 23)', () => {
  it.each([
    { title: 'the run comment failed after the fix PR opened', fail: 'comment-create' as const },
    { title: 'the fix PR failed to open after the push', fail: 'pr-create' as const },
  ])('$title', async ({ fail }) => {
    const run = await adoptedRun();
    commitFix(run, 'change.txt', 'the fixed change\n', 'Fix the reviewed change');
    run.w.gh.set({ failOnce: [fail] });

    const first = await approve(run);
    const second = await approve(run);

    expect.soft(first.accepted).toBe(0);
    expect.soft(first.errors).toHaveLength(1);
    expect.soft(second.errors).toEqual([]);
    expect.soft(second.accepted).toBe(1);
    expect.soft(second.advanced).toBe(1);
    expect.soft(run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)).toBe(fixHead(run));
    expect.soft(fixPrs(run.w, run.pickup.fixBranch)).toHaveLength(1);
    expect.soft(runComments(run.w)).toHaveLength(1);
    expect.soft(linksTo(run.w, runComments(run.w)[0]?.body, fixPrs(run.w, run.pickup.fixBranch)[0]?.number)).toBe(true);
    expect.soft(forcePushes(run.w.calls())).toEqual([]);
    expect.soft(run.w.contractBreaches()).toEqual([]);
  });
});

describe("a retry after the run comment failed gives this run's fix PR the report as it is now (#304 AC 23)", () => {
  it('replaces the fix PR body with the rewritten report', async () => {
    const run = await adoptedRun();
    commitFix(run, 'change.txt', 'the fixed change\n', 'Fix the reviewed change');
    run.w.gh.set({ failOnce: ['comment-create'] });

    const first = await approve(run);
    writeFileSync(run.report, 'The report, rewritten before the retry.\n');
    const second = await approve(run);

    expect.soft(first.accepted).toBe(0);
    expect.soft(second.accepted).toBe(1);
    expect.soft(fixPrs(run.w, run.pickup.fixBranch).map((p) => p.body)).toEqual(['The report, rewritten before the retry.\n']);
  });
});

describe("a later round's approve brings this run's own fix branch up to date without force (operator decision 2026-11-07)", () => {
  it('fast-forwards the fix branch to the new fixes, keeps one fix PR with the new report and one run comment', async () => {
    const run = await adoptedRun();
    commitFix(run, 'change.txt', 'the fixed change\n', 'Fix the reviewed change');
    run.w.gh.set({ failOnce: ['comment-create'] });
    const first = await approve(run);
    commitFix(run, 'more.txt', 'a later fix\n', 'Fix what the next round found');
    writeFileSync(run.report, 'The report after the later round.\n');

    const second = await approve(run);

    expect.soft(first.accepted).toBe(0);
    expect.soft(second.errors).toEqual([]);
    expect.soft(second.accepted).toBe(1);
    expect.soft(run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)).toBe(fixHead(run));
    expect.soft(fixPrs(run.w, run.pickup.fixBranch).map((p) => p.body)).toEqual(['The report after the later round.\n']);
    expect.soft(runComments(run.w)).toHaveLength(1);
    expect.soft(forcePushes(run.w.calls())).toEqual([]);
    expect.soft(run.w.contractBreaches()).toEqual([]);
  });

  it('holds, pushing nothing, when the branch on GitHub is behind but this run has no open fix PR from it', async () => {
    const run = await adoptedRun();
    commitFix(run, 'change.txt', 'the fixed change\n', 'Fix the reviewed change');
    run.w.gh.set({ failOnce: ['pr-create'] });
    await approve(run);
    const pushed = run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`);
    commitFix(run, 'more.txt', 'a later fix\n', 'Fix what the next round found');

    const reason = await expectHeld(run);

    expect.soft(reason).toContain(run.pickup.fixBranch);
    expect.soft(reason).toMatch(/Terminate/);
    expect.soft(run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)).toBe(pushed);
    expect.soft(fixPrs(run.w, run.pickup.fixBranch)).toEqual([]);
  });

  it('still holds, pushing nothing, when the branch on GitHub has a commit this run does not have', async () => {
    const run = await adoptedRun();
    commitFix(run, 'change.txt', 'the fixed change\n', 'Fix the reviewed change');
    run.w.gh.set({ failOnce: ['comment-create'] });
    await approve(run);
    const theirs = run.w.pushAs(run.pickup.fixBranch, 'other.txt', 'someone else\n', 'Someone else’s commit', run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)!);
    commitFix(run, 'more.txt', 'a later fix\n', 'Fix what the next round found');

    expect.soft(await expectHeld(run)).toContain(run.pickup.fixBranch);
    expect.soft(run.w.remoteRef(`refs/heads/${run.pickup.fixBranch}`)).toBe(theirs);
  });
});

describe('a new run on a PR an earlier run published to publishes its own, leaving the earlier one unchanged (#304 AC 13)', () => {
  it('uses its own fix branch, opens its own fix PR and posts its own run comment', async () => {
    const earlier = await adoptedRun();
    const w = earlier.w;
    commitFix(earlier, 'change.txt', 'an earlier run’s fix\n', 'An earlier run’s fix');
    const earlierOutcome = await approve(earlier);
    const earlierPrs = fixPrs(w, earlier.pickup.fixBranch);
    const earlierState = JSON.stringify({ pulls: pulls(w), comments: comments(w) });
    const earlierOid = fixHead(earlier);
    w.git(w.repo, ['checkout', '-q', 'main']);
    const run = await startRun(w, STARTED_AT + 86_400_000);
    writeFileSync(run.report, 'This run’s own report.\n');
    commitFix(run, 'change.txt', 'this run’s fix\n', 'This run’s fix');

    const outcome = await approve(run);

    const opened = fixPrs(w, run.pickup.fixBranch);
    const ownComment = runComments(w).find((c) => !earlierState.includes(JSON.stringify(c.body)));
    expect.soft(earlierOutcome.accepted).toBe(1);
    expect.soft(earlierPrs).toHaveLength(1);
    expect.soft(run.pickup.fixBranch).not.toBe(earlier.pickup.fixBranch);
    expect.soft(outcome.errors).toEqual([]);
    expect.soft(outcome.accepted).toBe(1);
    expect.soft(opened).toHaveLength(1);
    expect.soft(opened[0]?.number).not.toBe(earlierPrs[0]?.number);
    expect.soft(runComments(w)).toHaveLength(2);
    expect.soft(linksTo(w, ownComment?.body, opened[0]?.number)).toBe(true);
    for (const pr of earlierPrs) expect.soft(JSON.stringify(pulls(w).find((p) => p.number === pr.number))).toBe(JSON.stringify(pr));
    for (const c of JSON.parse(earlierState).comments as StandInComment[]) expect.soft(JSON.stringify(comments(w).find((x) => x.id === c.id))).toBe(JSON.stringify(c));
    expect.soft(w.remoteRef(`refs/heads/${earlier.pickup.fixBranch}`)).toBe(earlierOid);
  });
});

describe('what the publish never takes as its own (#304)', () => {
  it("a fork's open PR that reuses this run's fix branch name is never taken as this run's fix PR", async () => {
    const run = await adoptedRun();
    commitFix(run, 'change.txt', 'the fixed change\n', 'Fix the reviewed change');
    run.w.gh.update((state) => {
      state.pulls.push({
        number: 950, state: 'OPEN', title: 'Not this run’s', body: 'A stranger’s PR body.', isDraft: false, author: 'stranger',
        headRefName: run.pickup.fixBranch, headRefOid: run.w.startHeadOid, baseRefName: run.w.headBranch, headRepo: 'stranger/fork', isCrossRepository: true, closingIssues: [],
      });
    });
    const stranger = JSON.stringify(pulls(run.w).find((p) => p.number === 950));

    const outcome = await approve(run);

    const own = fixPrs(run.w, run.pickup.fixBranch).filter((p) => p.number !== 950);
    expect.soft(outcome.accepted).toBe(1);
    expect.soft(own).toHaveLength(1);
    expect.soft(own[0]?.author).toBe(run.w.gh.read().login);
    expect.soft(JSON.stringify(pulls(run.w).find((p) => p.number === 950))).toBe(stranger);
    expect.soft(linksTo(run.w, runComments(run.w)[0]?.body, own[0]?.number)).toBe(true);
    expect.soft(linksTo(run.w, runComments(run.w)[0]?.body, 950)).toBe(false);
  });

  it("a run comment written by another login is never edited; this run posts its own", async () => {
    const run = await adoptedRun();
    const first = await approve(run);
    const posted = runComments(run.w)[0];
    run.w.gh.update((state) => {
      for (const c of state.comments[String(run.w.prNumber)] ?? []) if (c.id === posted?.id) c.login = 'impostor';
    });
    writeFileSync(run.report, 'A second report.\n');

    const second = await approve(run);

    expect.soft(first.accepted).toBe(1);
    expect.soft(posted?.body ?? '').toContain(REPORT.trim());
    expect.soft(second.errors).toEqual([]);
    expect.soft(comments(run.w).find((c) => c.id === posted?.id)?.body).toBe(posted?.body);
    expect.soft(runComments(run.w)).toHaveLength(1);
    expect.soft(runComments(run.w)[0]?.body ?? '').toContain('A second report.');
  });
});

describe('a patch too large for the command output buffer still holds naming its size (#304 AC 20)', () => {
  it('a fork run whose fix makes a patch over 1 MiB holds, naming the run comment and the limit', async () => {
    const run = await adoptedRun({ pr: { fork: 'Contributor/Fork' } });
    const line = `${'x'.repeat(99)}\n`;
    commitFix(run, 'big.txt', line.repeat(12_000), 'Add a large fix');

    const reason = await expectHeld(run);
    expect.soft(reason).toMatch(/comment/i);
    expect.soft(sizesIn(run, reason)).toContain(LIMIT);
  });
});
