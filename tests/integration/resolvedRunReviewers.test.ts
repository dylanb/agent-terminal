import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { reviewRoster, reviewerAgentFor, rosterLines } from '../../src/main/reviewTurn';
import { installedReviewerProblem } from '../../src/main/reviewerAgents';
import { ensureRunReviewers, runAgentsDir } from '../../src/main/runReviewers';
import { seedResolvedLoop } from '../helpers/resolvedReviewerFixture';
import { seedFakeAgentSteps } from '../e2e/fakeTools';

let root: string;
let run: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'resolved-reviewers-'));
  run = join(root, 'run');
  mkdirSync(run);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const git = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
const read = (file: string): string | null => existsSync(file) ? readFileSync(file, 'utf8') : null;
function resolved(repo: string, operator: string, appBundled: string, flow = 'custom-flow') {
  const result = resolveLoopDefV2('custom-loop', { repoDir: repo, flow, tiers: { operator, appBundled, retired: null } });
  if (!result.ok) throw new Error(result.reason);
  return reviewRoster(result.def);
}
function loaded(runFolder: string) {
  const dir = runAgentsDir(runFolder).dir;
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
    const text = readFileSync(join(dir, f), 'utf8');
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
    if (!match) return { invalid: text };
    const front = yaml.load(match[1]) as { name: string; tools?: string };
    return { name: front.name, charter: match[2], tools: front.tools?.split(',').map((t) => t.trim()) ?? 'all' };
  }) : [];
}

describe('resolved run-local reviewers', () => {
  it.each([0, 1, 2, 3, 4])('installs the winning definition at precedence tier %i with all lower tiers competing', (winner) => {
    const operator = join(root, 'operator');
    const bundle = join(root, 'bundle');
    const locations = [join(run, 'defs'), join(operator, 'custom-flow'), join(bundle, 'custom-flow'), operator, bundle];
    for (let i = winner; i < locations.length; i++) seedResolvedLoop(locations[i], 'custom-loop', `Tier ${i}: keep this exact charter.\n`, i === 3 ? 'all' : ['Read', 'Grep']);
    if (winner === 0) writeFileSync(join(run, '.agent-loop.yaml'), 'loops:\n  custom-loop: defs/custom-loop/custom-loop.yaml\n');
    const reviewers = resolved(run, operator, bundle);
    const result = ensureRunReviewers(run, reviewers, bundle);
    expect.soft(result.problems).toEqual([]);
    expect.soft(loaded(run)).toEqual([{ name: reviewerAgentFor('claude-code', reviewers[0]), charter: `Tier ${winner}: keep this exact charter.\n`, tools: winner === 3 ? 'all' : ['Read', 'Grep'] }]);
    expect(installedReviewerProblem(runAgentsDir(run), reviewers[0])).toBeNull();
  });

  it('installs changed tools for an otherwise unedited shipped charter', () => {
    const bundle = resolve('example/loops-v2');
    const result = resolveLoopDefV2('green-loop', { repoDir: run, flow: 'feature-dev-v3', tiers: { operator: null, appBundled: bundle, retired: null } });
    if (!result.ok) throw new Error(result.reason);
    const reviewer = { ...reviewRoster(result.def)[0], tools: ['Read'] };
    ensureRunReviewers(run, [reviewer], bundle);
    expect(installedReviewerProblem(runAgentsDir(run), reviewer)).toBeNull();
  });

  it('keeps long independently named reviewers usable without filesystem-length failures', () => {
    const charter = join(root, 'charter.md');
    writeFileSync(charter, 'Check the result.\n');
    const reviewers = ['a', 'b'].map((suffix) => ({ loop: 'loop-' + 'x'.repeat(150), persona: 'review-' + 'y'.repeat(150) + suffix, charter, tools: 'all' as const }));
    ensureRunReviewers(run, reviewers, resolve('example/loops-v2'));
    expect.soft(new Set(reviewers.map((r) => reviewerAgentFor('claude-code', r))).size).toBe(2);
    for (const reviewer of reviewers) expect.soft(installedReviewerProblem(runAgentsDir(run), reviewer)).toBeNull();
    expect(loaded(run)).toHaveLength(2);
  });

  it('keeps distinct resolved reviewers with the same loop and persona independently executable', () => {
    const operator = join(root, 'operator');
    const bundle = join(root, 'bundle');
    seedResolvedLoop(join(operator, 'first'), 'custom-loop', 'First charter.\n', ['Read']);
    seedResolvedLoop(join(operator, 'second'), 'custom-loop', 'Second charter.\n', 'all');
    const reviewers = [...resolved(run, operator, bundle, 'first'), ...resolved(run, operator, bundle, 'second')];
    ensureRunReviewers(run, reviewers, bundle);
    const expected = reviewers.map((r, i) => ({ name: reviewerAgentFor('claude-code', r), persona: r.persona, charter: i === 0 ? 'First charter.\n' : 'Second charter.\n', tools: i === 0 ? ['Read'] : 'all' as const }));
    const evidence = join(root, 'executed.jsonl');
    seedFakeAgentSteps(root, { check: { artifactRel: '.agent-terminal/loop/artifacts/result.md', work: 'complete', roster: ['review-result'] } }, { reviewers: { expected, evidence } });
    try { execFileSync('bash', [join(root, 'fake-agent')], { cwd: run, input: [...rosterLines(reviewers, 'claude-code'), 'turn-done:review-check', ''].join('\n'), stdio: ['pipe', 'pipe', 'pipe'] }); } catch {}
    expect.soft(new Set(expected.map((e) => e.name)).size).toBe(2);
    expect(read(evidence)?.trim().split('\n').map((line) => JSON.parse(line)) ?? []).toEqual(expected.map(({ persona: _persona, ...entry }) => entry));
  });

  it.each([false, true])('isolates real worktrees and preserves git/global/unrelated files (gitignore present: %s)', (hasIgnore) => {
    git(run, 'init', '-q');
    git(run, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'root');
    const other = join(root, 'other');
    git(run, 'worktree', 'add', '-qb', 'other', other);
    const global = join(root, 'global', 'agents');
    mkdirSync(global, { recursive: true });
    writeFileSync(join(global, 'mine.md'), 'Global agent.\n');
    const exclude = join(run, '.git/info/exclude');
    writeFileSync(exclude, 'operator-owned/\n');
    const snapshots: unknown[] = [];
    const execute: (() => unknown)[] = [];
    for (const [index, dir] of [run, other].entries()) {
      if (hasIgnore) writeFileSync(join(dir, '.gitignore'), 'build/\n');
      const operator = join(root, `operator-${index}`);
      seedResolvedLoop(operator, 'custom-loop', `Worktree ${index}.\n`, index === 0 ? ['Read'] : 'all');
      const reviewers = resolved(dir, operator, join(root, 'bundle'));
      const result = ensureRunReviewers(dir, reviewers, join(root, 'bundle'));
      expect.soft(result.problems).toEqual([]);
      expect.soft(loaded(dir)).toEqual([{ name: reviewerAgentFor('claude-code', reviewers[0]), charter: `Worktree ${index}.\n`, tools: index === 0 ? ['Read'] : 'all' }]);
      snapshots.push(loaded(dir));
      const bin = join(root, `bin-${index}`);
      mkdirSync(bin);
      const evidence = join(bin, 'executed.jsonl');
      seedFakeAgentSteps(bin, { check: { artifactRel: '.agent-terminal/loop/artifacts/result.md', work: 'complete', roster: ['review-result'] } }, { reviewers: { expected: [{ name: reviewerAgentFor('claude-code', reviewers[0]), persona: 'review-result', charter: `Worktree ${index}.\n`, tools: index === 0 ? ['Read'] : 'all' }], evidence } });
      execute.push(() => {
        rmSync(evidence, { force: true });
        try { execFileSync('bash', [join(bin, 'fake-agent')], { cwd: dir, input: [...rosterLines(reviewers, 'claude-code'), ''].join('\n'), stdio: ['pipe', 'pipe', 'pipe'] }); } catch {}
        return read(evidence)?.trim().split('\n').map((line) => JSON.parse(line)) ?? [];
      });
      expect.soft(execute[index]()).toEqual([{ name: reviewerAgentFor('claude-code', reviewers[0]), charter: `Worktree ${index}.\n`, tools: index === 0 ? ['Read'] : 'all' }]);
      expect.soft(git(dir, 'status', '--porcelain', '--untracked-files=all')).toBe(hasIgnore ? '?? .gitignore\n' : '');
      expect.soft(read(join(dir, '.gitignore'))).toBe(hasIgnore ? 'build/\n' : null);
    }
    expect.soft(loaded(run)).toEqual(snapshots[0]);
    expect.soft(execute[0]()).toEqual(snapshots[0]);
    expect.soft(readFileSync(exclude, 'utf8')).toContain('operator-owned/\n');
    expect(readdirSync(global).map((file) => readFileSync(join(global, file), 'utf8'))).toEqual(['Global agent.\n']);
  });
});
