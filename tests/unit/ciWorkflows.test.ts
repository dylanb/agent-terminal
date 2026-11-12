import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

type Step = { run?: string };
type Job = { if?: string; needs?: string | string[]; steps?: Step[] };
type Workflow = { file: string; on?: unknown; jobs?: Record<string, Job> };

const dir = path.join(__dirname, '../../.github/workflows');

function workflows(): Workflow[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => ({ ...(load(readFileSync(path.join(dir, f), 'utf8')) as Omit<Workflow, 'file'>), file: f }));
}
/** Every shell command CI runs, across all jobs of a workflow. */
function commands(wf: Workflow): string[] {
  return Object.values(wf.jobs ?? {}).flatMap((j) => (j.steps ?? []).map((s) => s.run ?? ''));
}
const triggers = (wf: Workflow): string[] => {
  const on = wf.on as string | string[] | Record<string, unknown> | undefined;
  if (!on) return [];
  if (typeof on === 'string') return [on];
  return Array.isArray(on) ? on : Object.keys(on);
};

const filterList = (v: unknown): unknown => (typeof v === 'string' ? [v] : Array.isArray(v) ? [...v].sort() : v);

function triggerContract(wf: Workflow) {
  const on = wf.on && typeof wf.on === 'object' && !Array.isArray(wf.on) ? (wf.on as Record<string, Record<string, unknown> | null>) : {};
  const push = on.push ?? {};
  const pr = on.pull_request ?? {};
  return {
    file: wf.file,
    events: triggers(wf).sort(),
    pushBranches: filterList(push.branches),
    pushFilters: Object.keys(push).filter((k) => k !== 'branches').sort(),
    prBranches: filterList(pr.branches),
    prTypes: filterList(pr.types),
    prFilters: Object.keys(pr).filter((k) => k !== 'branches' && k !== 'types').sort(),
  };
}
const mainPushPrOrDispatch = (wf: Workflow) => ({
  file: wf.file,
  events: ['pull_request', 'push', 'workflow_dispatch'],
  pushBranches: ['main'],
  pushFilters: [],
  prBranches: ['main'],
  prTypes: ['opened', 'ready_for_review', 'reopened', 'synchronize'],
  prFilters: [],
});

const skipsDraftPrs = (job: Job): boolean =>
  /github\.event_name\s*!=\s*'pull_request'\s*\|\|\s*!github\.event\.pull_request\.draft/.test(job.if ?? '');

function jobsRunnableOnDraftPr(wf: Workflow): string[] {
  const jobs = wf.jobs ?? {};
  const guarded = (name: string, seen: Set<string> = new Set()): boolean => {
    const job = jobs[name];
    if (!job || seen.has(name)) return false;
    if (skipsDraftPrs(job)) return true;
    const needs = typeof job.needs === 'string' ? [job.needs] : (job.needs ?? []);
    seen.add(name);
    return needs.length > 0 && needs.every((n) => guarded(n, seen)) && /needs\.\S+\.result\s*!=\s*'skipped'/.test(job.if ?? '');
  };
  return Object.keys(jobs).filter((name) => !guarded(name));
}

describe('CI runs the test suites on non-draft PRs into main, on merges into main, and on manual dispatch', () => {
  const runsVitest = (wf: Workflow): boolean =>
    commands(wf).some((c) => /(^|\s)pnpm\s+(run\s+)?test(\s|$)/.test(c) || /\bvitest\b/.test(c));
  const runsE2e = (wf: Workflow): boolean =>
    commands(wf).some((c) => /playwright\s+test/.test(c) || /\btest:e2e\b/.test(c) || /e2e-podman\.sh/.test(c));

  it('a workflow runs the vitest suite', () => {
    expect(workflows().filter(runsVitest).map((wf) => wf.file)).not.toEqual([]);
  });

  it('every workflow that runs the vitest suite triggers on pushes to main, PRs into main and manual dispatch, and on nothing else', () => {
    const running = workflows().filter(runsVitest);
    expect(running.map(triggerContract)).toEqual(running.map(mainPushPrOrDispatch));
  });

  it('a workflow runs the playwright e2e suite', () => {
    expect(workflows().filter(runsE2e).map((wf) => wf.file)).not.toEqual([]);
  });

  it('every workflow that runs the playwright e2e suite triggers on pushes to main, PRs into main and manual dispatch, and on nothing else', () => {
    const running = workflows().filter(runsE2e);
    expect(running.map(triggerContract)).toEqual(running.map(mainPushPrOrDispatch));
  });

  it('every job of a workflow that runs a test suite or lint skips draft PRs', () => {
    const gated = workflows().filter((wf) => runsVitest(wf) || runsE2e(wf) || commands(wf).some((c) => /(^|\s)pnpm\s+(run\s+)?lint(\s|$)/.test(c)));
    expect(gated.map((wf) => ({ file: wf.file, unguarded: jobsRunnableOnDraftPr(wf) }))).toEqual(
      gated.map((wf) => ({ file: wf.file, unguarded: [] })),
    );
  });

  // The `browser` project launches real Chromium; without the binary the whole `pnpm test` run aborts.
  it('the workflow that runs vitest installs the Chromium the browser project needs', () => {
    for (const wf of workflows().filter(runsVitest)) {
      expect(commands(wf).some((c) => /playwright\s+install(\s+--\S+)*\s+chromium/.test(c))).toBe(true);
    }
  });

  // vitest strips types without checking them, so only tsc catches a type error in test code.
  it('a pull-request workflow type-checks the source and the tests', () => {
    const gating = workflows().filter(
      (wf) => commands(wf).some((c) => /(^|\s)pnpm\s+(run\s+)?typecheck(\s|$)/.test(c)) && triggers(wf).includes('pull_request'),
    );
    expect(gating.length).toBeGreaterThanOrEqual(1);
  });
});
