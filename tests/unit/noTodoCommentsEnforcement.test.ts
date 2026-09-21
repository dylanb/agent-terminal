import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';

// The local/no-todo-comments rule bans code deferral comments only if something actually RUNS it — a rule no
// hook and no CI job invokes is a gate nobody enforces (the ciWorkflows.test.ts precedent). This pins both
// legs: the husky pre-commit hook that blocks the commit locally, and the CI job that catches a --no-verify
// bypass so a deferral marker cannot reach the default branch.
const root = path.join(__dirname, '../..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};

type Step = { run?: string };
type Job = { steps?: Step[] };
type Workflow = { on?: unknown; jobs?: Record<string, Job> };

const wfDir = path.join(root, '.github/workflows');
const workflows = (): Workflow[] =>
  readdirSync(wfDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => load(readFileSync(path.join(wfDir, f), 'utf8')) as Workflow);
const commands = (wf: Workflow): string[] =>
  Object.values(wf.jobs ?? {}).flatMap((j) => (j.steps ?? []).map((s) => s.run ?? ''));
const triggers = (wf: Workflow): string[] => {
  const on = wf.on as string | string[] | Record<string, unknown> | undefined;
  if (!on) return [];
  if (typeof on === 'string') return [on];
  return Array.isArray(on) ? on : Object.keys(on);
};
const runsLint = (wf: Workflow): boolean =>
  commands(wf).some((c) => /(^|\s)pnpm\s+(run\s+)?lint(\s|$)/.test(c));

describe('the no-todo-comments gate is actually enforced', () => {
  it('the lint script runs eslint over the tree', () => {
    expect(pkg.scripts?.lint).toMatch(/\beslint\b/);
  });

  it('the husky pre-commit hook runs the lint so a commit with a deferral marker is blocked', () => {
    const hook = readFileSync(path.join(root, '.husky/pre-commit'), 'utf8');
    expect(hook).toMatch(/(^|\s)pnpm\s+(run\s+)?lint(\s|$)/);
  });

  it('a pull-request CI workflow runs the lint so a --no-verify bypass is caught', () => {
    const gating = workflows().filter((wf) => runsLint(wf) && triggers(wf).includes('pull_request'));
    expect(gating.length).toBeGreaterThanOrEqual(1);
  });
});
