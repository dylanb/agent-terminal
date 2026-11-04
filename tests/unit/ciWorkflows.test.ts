import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

// A merge is gated by the local test proof (docs/test-proof.md), so CI runs the suites only on the push
// to main that a merge creates. That run is still the honesty check on the proofs: a `browser` project
// no CI job can launch is a pin nobody enforces, which is how a contrast test stayed green for six
// iterations over a control that had lost its focus ring.

type Step = { run?: string };
type Job = { steps?: Step[] };
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

function triggerContract(wf: Workflow): { file: string; events: string[]; pushBranches: unknown; pushFilters: string[] } {
  const on = wf.on as Record<string, unknown> | undefined;
  const push = on && typeof on === 'object' && !Array.isArray(on) ? (on.push as Record<string, unknown> | null | undefined) : undefined;
  const branches = push?.branches;
  return {
    file: wf.file,
    events: triggers(wf).sort(),
    pushBranches: typeof branches === 'string' ? [branches] : branches,
    pushFilters: Object.keys(push ?? {}).filter((k) => k !== 'branches').sort(),
  };
}
const pushToMainOnly = (wf: Workflow) => ({ file: wf.file, events: ['push'], pushBranches: ['main'], pushFilters: [] });

describe('CI runs the test suites only after a merge into main', () => {
  const runsVitest = (wf: Workflow): boolean =>
    commands(wf).some((c) => /(^|\s)pnpm\s+(run\s+)?test(\s|$)/.test(c) || /\bvitest\b/.test(c));
  const runsE2e = (wf: Workflow): boolean =>
    commands(wf).some((c) => /playwright\s+test/.test(c) || /\btest:e2e\b/.test(c) || /e2e-podman\.sh/.test(c));

  it('a workflow runs the vitest suite', () => {
    expect(workflows().filter(runsVitest).map((wf) => wf.file)).not.toEqual([]);
  });

  it('every workflow that runs the vitest suite triggers on pushes to main and on nothing else', () => {
    const running = workflows().filter(runsVitest);
    expect(running.map(triggerContract)).toEqual(running.map(pushToMainOnly));
  });

  it('a workflow runs the playwright e2e suite', () => {
    expect(workflows().filter(runsE2e).map((wf) => wf.file)).not.toEqual([]);
  });

  it('every workflow that runs the playwright e2e suite triggers on pushes to main and on nothing else', () => {
    const running = workflows().filter(runsE2e);
    expect(running.map(triggerContract)).toEqual(running.map(pushToMainOnly));
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
