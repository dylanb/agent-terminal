import { describe, expect, it } from 'vitest';
import {
  runTestProof,
  type OpenPullRequest,
  type ProofSuite,
  type SuiteResult,
  type SuiteRun,
  type TestProofPorts,
} from '../../src/main/testProof';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const MOVED = 'c'.repeat(40);
const CONTEXTS = { vitest: 'test-proof/vitest', e2e: 'test-proof/e2e' } as const;
const REJECTION = 'HTTP 502: the stand-in GitHub refused the write';

const VITEST: SuiteResult = {
  passed: 5412,
  failed: 0,
  skipped: 26,
  flaky: 13,
  skippedTests: [
    'workspace pane › keeps the scrollback when a very long session is restored from disk',
    'controller protocol › rejects a frame from a peer that negotiated an older version',
  ],
  flakyTests: ['quiescence detector › settles after the configured quiet window on a loaded host'],
  environment: { node: 'v24.3.0', electron: '39.2.4' },
};

const E2E: SuiteResult = {
  passed: 391,
  failed: 0,
  skipped: 58,
  flaky: 47,
  skippedTests: [
    'app.spec.ts › monitor › injects a bracketed paste into an agent that disabled bracketed mode',
    'loop.spec.ts › stops the loop when the operator closes the window during a review turn',
  ],
  flakyTests: [
    'app.spec.ts › terminal › resizes the PTY after the pane is dragged to a narrower width',
    'loop.spec.ts › shows the review history after a checkpoint and a restart of the app',
  ],
  environment: { node: 'v22.11.0', electron: '39.2.5', image: 'sha256:9f8e7d6cfeedbeefcafebabefacade0ddba11c0ffee0ddf00dfab1edeadbea7' },
};

const ran = (result: SuiteResult, exitCode = 0): SuiteRun => ({ kind: 'ran', exitCode, result });

interface World {
  dirty: string[];
  head: string;
  branch: string | null;
  pr: OpenPullRequest;
  runs: Record<ProofSuite, SuiteRun>;
  whileRunning: Partial<Record<ProofSuite, (world: World) => void>>;
}

function world(overrides: Partial<World> = {}): World {
  return {
    dirty: [],
    head: HEAD,
    branch: 'feature/proof',
    pr: { kind: 'open', number: 7, headSha: HEAD },
    runs: { vitest: ran(VITEST), e2e: ran(E2E) },
    whileRunning: {},
    ...overrides,
  };
}

type Target = 'test-proof/vitest' | 'test-proof/e2e' | 'summary';

interface StandInPublisher {
  failing: Set<Target>;
  statuses: { sha: string; context: string; description: string }[];
  summaries: { pr: number; body: string }[];
}

const publisher = (failing: Target[] = []): StandInPublisher => ({ failing: new Set(failing), statuses: [], summaries: [] });

async function prove(args: string[], w: World = world(), published: StandInPublisher = publisher()) {
  const lines: string[] = [];
  const touched: string[] = [];
  const suitesRun: ProofSuite[] = [];
  const touch = (port: string) => touched.push(port);
  const ports: TestProofPorts = {
    workingTree: {
      dirtyPaths: async () => (touch('working tree'), w.dirty),
      head: async () => (touch('working tree'), w.head),
      branch: async () => (touch('working tree'), w.branch),
    },
    pullRequests: {
      openFor: async (asked) => (touch('GitHub'), asked === w.branch ? w.pr : { kind: 'none' }),
    },
    suites: {
      run: async (suite) => {
        suitesRun.push(suite);
        w.whileRunning[suite]?.(w);
        return w.runs[suite];
      },
    },
    publisher: {
      status: async (sha, context, description) => {
        if (published.failing.has(context as Target)) throw new Error(REJECTION);
        published.statuses.push({ sha, context, description });
      },
      summary: async (pr, body) => {
        if (published.failing.has('summary')) throw new Error(REJECTION);
        published.summaries.push({ pr, body });
      },
    },
    report: (line) => lines.push(line),
  };
  const exitCode = await runTestProof(args, ports);
  return { exitCode, lines, output: lines.join('\n'), touched, suitesRun, published };
}

function expectNothingPublished(published: StandInPublisher): void {
  expect.soft(published.statuses).toEqual([]);
  expect.soft(published.summaries).toEqual([]);
}

/** `n` stated as the count of `label`, in either order ("5412 passed", "passed: 5412"). */
const statesCount = (text: string, label: string, n: number): boolean =>
  new RegExp(`\\b${n}\\s*${label}|${label}\\w*\\W{0,3}${n}\\b`, 'i').test(text);

describe('runTestProof refuses every precondition before any suite', () => {
  it('refuses any argument, naming it, before reading the working tree or GitHub', async () => {
    const { exitCode, output, touched, suitesRun, published } = await prove(['unexpected-arg']);
    expect.soft(exitCode).not.toBe(0);
    expect.soft(output).toContain('unexpected-arg');
    expect.soft(touched).toEqual([]);
    expect.soft(suitesRun).toEqual([]);
    expectNothingPublished(published);
  });

  it('reports the argument when it is given alongside a dirty tree and no open PR', async () => {
    const { exitCode, output, touched, suitesRun, published } = await prove(['--grep=smoke'], world({ dirty: ['src/x.ts'], pr: { kind: 'none' } }));
    expect.soft(exitCode).not.toBe(0);
    expect.soft(output).toContain('--grep=smoke');
    expect.soft(touched).toEqual([]);
    expect.soft(suitesRun).toEqual([]);
    expectNothingPublished(published);
  });

  it('refuses a detached HEAD as not on a branch', async () => {
    const { exitCode, output, suitesRun, published } = await prove([], world({ branch: null }));
    expect.soft(exitCode).not.toBe(0);
    expect.soft(output).toMatch(/not on a branch|detached/i);
    expect.soft(suitesRun).toEqual([]);
    expectNothingPublished(published);
  });

  it.each([
    ['an uncommitted change', 'src/changed.ts'],
    ['an untracked file', 'notes/untracked.md'],
  ])('refuses a dirty tree holding %s', async (_kind, path) => {
    const { exitCode, output, suitesRun, published } = await prove([], world({ dirty: [path] }));
    expect.soft(exitCode).not.toBe(0);
    expect.soft(output).toMatch(/dirty|uncommitted|untracked|not clean/i);
    expect.soft(suitesRun).toEqual([]);
    expectNothingPublished(published);
  });

  it('refuses when the branch has no open PR', async () => {
    const { exitCode, output, suitesRun, published } = await prove([], world({ pr: { kind: 'none' } }));
    expect.soft(exitCode).not.toBe(0);
    expect.soft(output).toMatch(/no open (pull request|PR)/i);
    expect.soft(suitesRun).toEqual([]);
    expectNothingPublished(published);
  });

  it('refuses several open PRs, naming each', async () => {
    const { exitCode, output, suitesRun, published } = await prove([], world({ pr: { kind: 'several', numbers: [41, 58] } }));
    expect.soft(exitCode).not.toBe(0);
    expect.soft(output).toMatch(/\b41\b/);
    expect.soft(output).toMatch(/\b58\b/);
    expect.soft(suitesRun).toEqual([]);
    expectNothingPublished(published);
  });

  it('refuses a fork-headed PR, naming it', async () => {
    const { exitCode, output, suitesRun, published } = await prove([], world({ pr: { kind: 'fork', number: 63 } }));
    expect.soft(exitCode).not.toBe(0);
    expect.soft(output).toMatch(/fork/i);
    expect.soft(output).toMatch(/\b63\b/);
    expect.soft(suitesRun).toEqual([]);
    expectNothingPublished(published);
  });

  it.each([['gh is not installed (no gh on PATH)'], ['gh is not logged in (run gh auth login)']])('refuses when GitHub is unavailable, printing the reason: %s', async (reason) => {
    const { exitCode, output, suitesRun, published } = await prove([], world({ pr: { kind: 'github-unavailable', reason } }));
    expect.soft(exitCode).not.toBe(0);
    expect.soft(output).toContain(reason);
    expect.soft(suitesRun).toEqual([]);
    expectNothingPublished(published);
  });

  it('refuses a HEAD that is not the PR head, naming the PR, the local HEAD and the PR head', async () => {
    const { exitCode, output, suitesRun, published } = await prove([], world({ head: HEAD, pr: { kind: 'open', number: 7, headSha: OTHER } }));
    expect.soft(exitCode).not.toBe(0);
    expect.soft(output).toMatch(/not (the )?(PR|pull request)('s)? head|does not match|mismatch|differs/i);
    expect.soft(output).toMatch(/\b7\b/);
    expect.soft(output).toContain(HEAD);
    expect.soft(output).toContain(OTHER);
    expect.soft(suitesRun).toEqual([]);
    expectNothingPublished(published);
  });
});

describe('runTestProof publishes the proof when both suites pass on the PR head', () => {
  it('publishes one success status per literal context on HEAD and one summary for the PR, and exits 0', async () => {
    const { exitCode, published } = await prove([]);
    expect.soft(exitCode).toBe(0);
    expect.soft(published.statuses.map((s) => s.context).sort()).toEqual(['test-proof/e2e', 'test-proof/vitest']);
    expect.soft(published.statuses.every((s) => s.sha === HEAD)).toBe(true);
    expect.soft(published.summaries.map((s) => s.pr)).toEqual([7]);
  });

  it.each([
    ['vitest', VITEST, E2E],
    ['e2e', E2E, VITEST],
  ] as const)('gives the %s status its own passed, skipped and flaky counts in at most 140 characters', async (suite, own, other) => {
    const { published } = await prove([]);
    const description = published.statuses.find((s) => s.context === CONTEXTS[suite])?.description ?? '';
    expect.soft(statesCount(description, 'pass', own.passed), description).toBe(true);
    expect.soft(statesCount(description, 'skip', own.skipped), description).toBe(true);
    expect.soft(statesCount(description, 'flak', own.flaky), description).toBe(true);
    expect.soft(description).not.toMatch(new RegExp(`\\b(${other.passed}|${other.skipped}|${other.flaky})\\b`));
    expect.soft(description.length).toBeLessThanOrEqual(140);
  });

  it('writes the SHA, every count, every skipped and flaky test name and each suite environment into the summary', async () => {
    const { published } = await prove([]);
    const body = published.summaries[0]?.body ?? '';
    expect.soft(body).toContain(HEAD);
    for (const n of [VITEST.passed, VITEST.skipped, VITEST.flaky, E2E.passed, E2E.skipped, E2E.flaky]) {
      expect.soft(body, `count ${n}`).toMatch(new RegExp(`\\b${n}\\b`));
    }
    expect.soft(body).toMatch(/fail/i);
    for (const name of [...VITEST.skippedTests, ...VITEST.flakyTests, ...E2E.skippedTests, ...E2E.flakyTests]) {
      expect.soft(body).toContain(name);
    }
    for (const value of [VITEST.environment.node, VITEST.environment.electron, E2E.environment.node, E2E.environment.electron, E2E.environment.image ?? '']) {
      expect.soft(body).toContain(value);
    }
  });

  it.each([
    ['vitest', 'e2e', VITEST, E2E],
    ['e2e', 'vitest', E2E, VITEST],
  ] as const)('credits the %s counts, environment and test names to that suite in the summary', async (suite, otherSuite, own, other) => {
    const { published } = await prove([]);
    const lines = (published.summaries[0]?.body ?? '').split('\n');
    const namesOwn = (line: string) => new RegExp(`\\b${suite}\\b`).test(line);
    const namesOther = (line: string) => new RegExp(`\\b${otherSuite}\\b`).test(line);
    const row = lines.filter((line) => namesOwn(line) && !namesOther(line) && line.includes(own.environment.node));
    expect(row, lines.join('\n')).toHaveLength(1);
    const ownRow = row[0] ?? '';
    for (const n of [own.passed, own.skipped, own.flaky]) expect.soft(ownRow, `count ${n}`).toMatch(new RegExp(`\\b${n}\\b`));
    expect.soft(ownRow).toContain(own.environment.electron);
    if (own.environment.image !== undefined) expect.soft(ownRow).toContain(own.environment.image);
    for (const n of [other.passed, other.skipped, other.flaky]) expect.soft(ownRow, `other count ${n}`).not.toMatch(new RegExp(`\\b${n}\\b`));
    expect.soft(ownRow).not.toContain(other.environment.node);
    expect.soft(ownRow).not.toContain(other.environment.electron);
    for (const name of [...own.skippedTests, ...own.flakyTests]) {
      const at = lines.findIndex((line) => line.includes(name));
      const label = lines.slice(0, at).reverse().find((line) => namesOwn(line) || namesOther(line)) ?? '';
      expect.soft(at, name).toBeGreaterThan(-1);
      expect.soft(namesOwn(label) && !namesOther(label), `${name} is listed under ${label}`).toBe(true);
    }
  });
});

describe('runTestProof re-checks the tree and both heads after the suites pass', () => {
  it('refuses, publishing nothing, when the tree turns dirty during the run', async () => {
    const w = world({ whileRunning: { e2e: (live) => void (live.dirty = ['src/late-edit.ts']) } });
    const { exitCode, output, published } = await prove([], w);
    expect.soft(exitCode).not.toBe(0);
    expect.soft(output).toMatch(/dirty|uncommitted|untracked|not clean|changed|modified/i);
    expectNothingPublished(published);
  });

  it('refuses, publishing nothing, when HEAD moves during the run', async () => {
    const w = world({ whileRunning: { e2e: (live) => void (live.head = MOVED) } });
    const { exitCode, output, published } = await prove([], w);
    expect.soft(exitCode).not.toBe(0);
    expect.soft(output).toMatch(/not (the )?(PR|pull request)('s)? head|does not match|mismatch|differs|moved/i);
    expect.soft(output).toContain(MOVED);
    expectNothingPublished(published);
  });

  it('refuses, publishing nothing, when the PR head moves during the run', async () => {
    const w = world({ whileRunning: { e2e: (live) => void (live.pr = { kind: 'open', number: 7, headSha: MOVED }) } });
    const { exitCode, output, published } = await prove([], w);
    expect.soft(exitCode).not.toBe(0);
    expect.soft(output).toMatch(/not (the )?(PR|pull request)('s)? head|does not match|mismatch|differs|moved/i);
    expect.soft(output).toContain(MOVED);
    expectNothingPublished(published);
  });
});

describe('runTestProof refuses when HEAD and the PR head both move during the run', () => {
  it('refuses, publishing nothing, when a push mid-run moves HEAD and the PR head to the same new commit', async () => {
    const w = world({
      whileRunning: {
        e2e: (live) => {
          live.head = MOVED;
          live.pr = { kind: 'open', number: 7, headSha: MOVED };
        },
      },
    });
    const { exitCode, output, published } = await prove([], w);
    expect.soft(exitCode).not.toBe(0);
    expect.soft(output).toContain(MOVED);
    expectNothingPublished(published);
  });
});

describe('runTestProof writes each test name into the summary as one intact code span', () => {
  const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** A CommonMark code span holding exactly `content`: a fence longer than every backtick run in it, with optional one-space padding. */
  const codeSpanOf = (content: string, fenceAtLeast: number) =>
    new RegExp(`(?<!\`)(\`{${fenceAtLeast},})( ?)${content}\\2\\1(?!\`)`);

  it('fences a name holding backtick runs with a longer run, so it renders as written', async () => {
    const name = 'epic plan › keeps a ``## `` heading inside a `code` span';
    const w = world({ runs: { vitest: ran({ ...VITEST, skippedTests: [name] }), e2e: ran(E2E) } });
    const { published } = await prove([], w);
    const body = published.summaries[0]?.body ?? '';
    expect(body).toMatch(codeSpanOf(escapeRegExp(name), 3));
  });

  it('keeps a name holding a line break on one line', async () => {
    const w = world({ runs: { vitest: ran(VITEST), e2e: ran({ ...E2E, flakyTests: ['first line\nsecond line'] }) } });
    const { published } = await prove([], w);
    const body = published.summaries[0]?.body ?? '';
    expect(body).toMatch(codeSpanOf('first line[ \\t]+second line', 1));
  });
});

/** A failure wording; a zero count ("0 failed", "failed: 0") is not one. */
const SUITE_FAILURE = /(?<!\b0\s*)\bfail(?!\w*\W{0,3}0\b)|did not pass|unreadable|non-zero|exit(ed)?( with)?( code)? [1-9]|refus/i;

describe('runTestProof refuses, publishing nothing, when a suite does not pass', () => {
  const failures: [string, (own: SuiteResult) => SuiteRun][] = [
    ['reports failed tests and exits non-zero', (own) => ran({ ...own, failed: 2 }, 1)],
    ['reports a failed test yet exits 0', (own) => ran({ ...own, failed: 1 }, 0)],
    ['exits non-zero with an all-pass report', (own) => ran(own, 1)],
    ['leaves no readable report', () => ({ kind: 'unreadable', exitCode: 0, reason: 'report.json is missing from .agent-terminal/test-proof' })],
  ];

  it.each(failures.flatMap(([what, run]) => (['vitest', 'e2e'] as const).map((suite) => [suite, what, run] as const)))(
    'names %s when it %s',
    async (suite, _what, run) => {
      const own = suite === 'vitest' ? VITEST : E2E;
      const w = world({ runs: { vitest: ran(VITEST), e2e: ran(E2E), [suite]: run(own) } });
      const { exitCode, lines, output, published } = await prove([], w);
      expect.soft(exitCode).not.toBe(0);
      const other = suite === 'vitest' ? 'e2e' : 'vitest';
      const names = (s: string) => (line: string) => new RegExp(`\\b${s}\\b`).test(line);
      expect.soft(lines.some((line) => names(suite)(line) && SUITE_FAILURE.test(line)), output).toBe(true);
      expect.soft(lines.some((line) => names(other)(line) && !names(suite)(line) && SUITE_FAILURE.test(line)), output).toBe(false);
      const failed = w.runs[suite];
      if (failed.kind === 'unreadable') expect.soft(output).toContain(failed.reason);
      expectNothingPublished(published);
    },
  );
});

describe('runTestProof stops before e2e when vitest does not pass', () => {
  it.each([
    ['reports failed tests', ran({ ...VITEST, failed: 2 }, 1)],
    ['exits non-zero with an all-pass report', ran(VITEST, 1)],
    ['leaves no readable report', { kind: 'unreadable', exitCode: 0, reason: 'vitest.json is missing' } as SuiteRun],
  ])('never runs e2e when vitest %s', async (_what, vitest) => {
    const { exitCode, suitesRun } = await prove([], world({ runs: { vitest, e2e: ran(E2E) } }));
    expect.soft(exitCode).not.toBe(0);
    expect.soft(suitesRun).toEqual(['vitest']);
  });
});

describe('runTestProof attempts all three publishes and reports each outcome', () => {
  const names = (target: Target) => (line: string) => (target === 'summary' ? /summary|comment/i.test(line) : line.includes(target));
  const PUBLISH_FAILURE = /fail|not published|could not|rejected|error/i;

  it.each(['test-proof/vitest', 'test-proof/e2e', 'summary'] as const)('exits non-zero when %s fails to publish, naming what was and was not published', async (target) => {
    const published = publisher([target]);
    const { exitCode, lines, output } = await prove([], world(), published);
    expect.soft(exitCode).not.toBe(0);
    const others = (['test-proof/vitest', 'test-proof/e2e', 'summary'] as const).filter((t) => t !== target);
    for (const other of others) {
      if (other === 'summary') expect.soft(published.summaries.map((s) => s.pr), 'summary still attempted').toEqual([7]);
      else expect.soft(published.statuses.map((s) => s.context), `${other} still attempted`).toContain(other);
      expect.soft(lines.some((line) => names(other)(line) && !names(target)(line) && !PUBLISH_FAILURE.test(line)), `output reports ${other} as published`).toBe(true);
    }
    expect.soft(lines.some((line) => names(target)(line) && PUBLISH_FAILURE.test(line)), output).toBe(true);
    expect.soft(output).toContain(REJECTION);
  });

  it('completes the proof on a re-run after a partial publish', async () => {
    const published = publisher(['test-proof/e2e']);
    const first = await prove([], world(), published);
    expect.soft(first.exitCode).not.toBe(0);
    published.failing.clear();
    const before = { statuses: published.statuses.length, summaries: published.summaries.length };
    const second = await prove([], world(), published);
    expect.soft(second.exitCode).toBe(0);
    const statuses = published.statuses.slice(before.statuses);
    expect.soft(statuses.map((s) => `${s.context}@${s.sha}`).sort()).toEqual([`test-proof/e2e@${HEAD}`, `test-proof/vitest@${HEAD}`]);
    expect.soft(published.summaries.slice(before.summaries).map((s) => s.pr)).toEqual([7]);
  });
});
