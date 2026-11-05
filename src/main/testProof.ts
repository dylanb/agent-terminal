import { errMsg } from './errno';

export type OpenPullRequest =
  | { kind: 'open'; number: number; headSha: string }
  | { kind: 'none' }
  | { kind: 'several'; numbers: number[] }
  | { kind: 'fork'; number: number }
  | { kind: 'github-unavailable'; reason: string };

export interface ProofWorkingTree {
  dirtyPaths(): Promise<string[]>;
  head(): Promise<string>;
  branch(): Promise<string | null>;
}

export interface BranchPullRequests {
  openFor(branch: string): Promise<OpenPullRequest>;
}

export const TEST_PROOF_CHECKS = { vitest: 'test-proof/vitest', e2e: 'test-proof/e2e' } as const;

export type ProofSuite = keyof typeof TEST_PROOF_CHECKS;

export type ProofCheck = (typeof TEST_PROOF_CHECKS)[ProofSuite];

export type SuiteEnvironment =
  | { runsIn: 'host'; node: string; electron: string }
  | { runsIn: 'container'; node: string; electron: string; image: string };

export interface SuiteResult {
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  skippedTests: string[];
  flakyTests: string[];
  environment: SuiteEnvironment;
}

export type SuiteRun =
  | { kind: 'ran'; exitCode: number; result: SuiteResult }
  | { kind: 'unreadable'; exitCode: number; reason: string }
  | { kind: 'no-exit'; reason: string };

export interface ProofSuites {
  run(suite: ProofSuite): Promise<SuiteRun>;
}

export interface ProofPublisher {
  status(sha: string, check: ProofCheck, description: string): Promise<void>;
  summary(pr: number, body: string): Promise<void>;
}

export interface TestProofPorts {
  workingTree: ProofWorkingTree;
  pullRequests: BranchPullRequests;
  suites: ProofSuites;
  publisher: ProofPublisher;
  report(line: string): void;
}

const PROVED = 0;
const REFUSED = 1;
const RERUN = 'Fix that and run `pnpm run test:proof` again.';
const SUITES: readonly ProofSuite[] = ['vitest', 'e2e'];

type Checked = { kind: 'refused'; cause: string } | { kind: 'ready'; branch: string; pr: number; head: string };

async function checkPreconditions(ports: TestProofPorts): Promise<Checked> {
  const refused = (cause: string): Checked => ({ kind: 'refused', cause });
  const branch = await ports.workingTree.branch();
  if (branch === null) return refused('HEAD is detached, so it is not on a branch with an open PR.');

  const dirty = await ports.workingTree.dirtyPaths();
  if (dirty.length > 0) {
    return refused(`the working tree is not clean (uncommitted or untracked): ${dirty.join(', ')}. Commit or remove them.`);
  }

  const pr = await ports.pullRequests.openFor(branch);
  switch (pr.kind) {
    case 'none':
      return refused(`branch ${branch} has no open PR in this repository. Open one first.`);
    case 'several':
      return refused(`branch ${branch} has several open PRs (${pr.numbers.map((n) => `#${n}`).join(', ')}). Close all but one.`);
    case 'fork':
      return refused(`the open PR for branch ${branch}, #${pr.number}, is headed on a fork. Only a PR from a branch in this repository can be proved.`);
    case 'github-unavailable':
      return refused(`GitHub is unavailable: ${pr.reason}`);
    case 'open':
      break;
  }

  const head = await ports.workingTree.head();
  if (head !== pr.headSha) {
    return refused(`local HEAD ${head} is not the PR head: PR #${pr.number}'s head is ${pr.headSha}. Push HEAD, or check out the PR head.`);
  }
  return { kind: 'ready', branch, pr: pr.number, head };
}

type SuiteVerdict = { passed: true; result: SuiteResult } | { passed: false; cause: string };

function suiteVerdict(suite: ProofSuite, run: SuiteRun): SuiteVerdict {
  if (run.kind === 'no-exit') {
    return { passed: false, cause: `${suite} did not pass: it never reached its own exit (${run.reason}).` };
  }
  if (run.kind === 'unreadable') {
    return { passed: false, cause: `${suite} did not pass: its results are unreadable (${run.reason}); it exited ${run.exitCode}.` };
  }
  if (run.exitCode !== 0 || run.result.failed !== 0) {
    return { passed: false, cause: `${suite} did not pass: it exited ${run.exitCode} with ${run.result.failed} failed.` };
  }
  return { passed: true, result: run.result };
}

export function statusDescription(result: SuiteResult): string {
  return `${result.passed} passed, ${result.skipped} skipped, ${result.flaky} flaky`;
}

/** CommonMark §6.1 */
function codeSpan(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  return `${fence} ${text.replace(/[\r\n]+/g, ' ')} ${fence}`;
}

function nameList(title: string, names: readonly string[]): string[] {
  if (names.length === 0) return [];
  return ['', `**${title}**`, '', ...names.map((name) => `- ${codeSpan(name)}`)];
}

export function summaryBody(sha: string, results: Record<ProofSuite, SuiteResult>): string {
  const lines = [
    `## Test proof for ${sha}`,
    '',
    '| Suite | Passed | Failed | Skipped | Flaky | Node | Electron | Image |',
    '|---|---|---|---|---|---|---|---|',
    ...SUITES.map((suite) => {
      const r = results[suite];
      const env = r.environment;
      return `| ${suite} | ${r.passed} | ${r.failed} | ${r.skipped} | ${r.flaky} | ${codeSpan(env.node)} | ${codeSpan(env.electron)} | ${env.runsIn === 'container' ? codeSpan(env.image) : '—'} |`;
    }),
  ];
  for (const suite of SUITES) {
    lines.push(...nameList(`${suite} skipped (${results[suite].skippedTests.length})`, results[suite].skippedTests));
    lines.push(...nameList(`${suite} flaky (${results[suite].flakyTests.length})`, results[suite].flakyTests));
  }
  return lines.join('\n');
}

export async function runTestProof(args: readonly string[], ports: TestProofPorts): Promise<number> {
  const refuse = (cause: string): number => {
    ports.report(`test:proof refused: ${cause}`);
    ports.report(RERUN);
    return REFUSED;
  };

  if (args.length > 0) {
    return refuse(
      `it takes no arguments, and was given ${args.map((arg) => JSON.stringify(arg)).join(' ')}. A proof is always the full vitest and e2e run.`,
    );
  }

  const before = await checkPreconditions(ports);
  if (before.kind === 'refused') return refuse(before.cause);

  const results = {} as Record<ProofSuite, SuiteResult>;
  for (const suite of SUITES) {
    ports.report(`test:proof: running ${suite} on ${before.head} for PR #${before.pr}.`);
    const verdict = suiteVerdict(suite, await ports.suites.run(suite));
    if (!verdict.passed) return refuse(verdict.cause);
    results[suite] = verdict.result;
    ports.report(`test:proof: ${suite} passed (${statusDescription(verdict.result)}).`);
  }

  const after = await checkPreconditions(ports);
  if (after.kind === 'refused') return refuse(`after the suites ran, ${after.cause}`);
  if (after.head !== before.head) {
    return refuse(`HEAD moved during the run: it is now ${after.head}, but the suites tested ${before.head}.`);
  }

  const publishes: { target: string; publish: () => Promise<void> }[] = [
    ...SUITES.map((suite) => ({
      target: `the ${TEST_PROOF_CHECKS[suite]} status`,
      publish: () => ports.publisher.status(before.head, TEST_PROOF_CHECKS[suite], statusDescription(results[suite])),
    })),
    { target: `the summary comment on PR #${before.pr}`, publish: () => ports.publisher.summary(before.pr, summaryBody(before.head, results)) },
  ];
  let complete = true;
  for (const { target, publish } of publishes) {
    try {
      await publish();
      ports.report(`test:proof: published ${target}.`);
    } catch (e) {
      complete = false;
      ports.report(`test:proof: could not publish ${target}: ${errMsg(e)}`);
    }
  }
  if (!complete) {
    ports.report('test:proof: the proof is incomplete. Run `pnpm run test:proof` again to publish all of it.');
    return REFUSED;
  }
  ports.report(`test:proof: proved ${before.head} for PR #${before.pr}.`);
  return PROVED;
}
