import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

// The vitest suites gate a merge only if some workflow actually runs them. A `browser` project that
// no CI job can launch is a pin nobody enforces, which is how a contrast test stayed green for six
// iterations over a control that had lost its focus ring.

type Step = { run?: string };
type Job = { steps?: Step[] };
type Workflow = { on?: unknown; jobs?: Record<string, Job> };

const dir = path.join(__dirname, '../../.github/workflows');

function workflows(): Workflow[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => load(readFileSync(path.join(dir, f), 'utf8')) as Workflow);
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

describe('CI runs the test suites that gate a merge', () => {
  const runsVitest = (wf: Workflow): boolean =>
    commands(wf).some((c) => /(^|\s)pnpm\s+(run\s+)?test(\s|$)/.test(c) || /vitest\s+run/.test(c));

  it('a pull-request workflow runs the vitest suite', () => {
    const gating = workflows().filter((wf) => runsVitest(wf) && triggers(wf).includes('pull_request'));
    expect(gating.length).toBeGreaterThanOrEqual(1);
  });

  // The `browser` project launches real Chromium; without the binary the whole `pnpm test` run aborts.
  it('the workflow that runs vitest installs the Chromium the browser project needs', () => {
    for (const wf of workflows().filter(runsVitest)) {
      expect(commands(wf).some((c) => /playwright\s+install(\s+--\S+)*\s+chromium/.test(c))).toBe(true);
    }
  });

  it('a pull-request workflow runs the playwright e2e suite', () => {
    const gating = workflows().filter(
      (wf) => commands(wf).some((c) => /playwright\s+test/.test(c)) && triggers(wf).includes('pull_request'),
    );
    expect(gating.length).toBeGreaterThanOrEqual(1);
  });
});
