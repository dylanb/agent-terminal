import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import yaml from 'js-yaml';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { reconcileRunReviewers, flowReviewers } from '../../src/main/runReviewers';
import { seedResolvedLoop } from '../helpers/resolvedReviewerFixture';

it.skipIf(process.getuid?.() === 0).each(['definition', 'charter-parent', 'definition-parent', 'registry', 'override-parent', 'tier-parent'] as const)('repairs %s permissions through flow resolution and installation', (fault) => {
  const root = mkdtempSync(join(tmpdir(), "resolve repair's $value-"));
  const tier = join(root, 'config', 'loops');
  const file = seedResolvedLoop(tier, 'custom', 'Required reviewer.\n');
  let obstruction = file;
  if (fault === 'charter-parent') {
    obstruction = join(dirname(file), 'sources');
    mkdirSync(obstruction);
    writeFileSync(join(obstruction, 'charter.md'), 'Required reviewer.\n');
    const def = yaml.load(readFileSync(file, 'utf8')) as Record<string, unknown>;
    def.reviewers = [{ persona: 'review-result', charter: 'sources/charter.md', tools: ['Read'] }];
    writeFileSync(file, yaml.dump(def));
  } else if (fault === 'tier-parent') obstruction = dirname(tier);
  else if (fault === 'override-parent') {
    writeFileSync(join(root, '.agent-loop.yaml'), yaml.dump({ loops: { custom: 'config/loops/custom/custom.yaml' } }));
    obstruction = dirname(file);
  } else if (fault === 'definition-parent') obstruction = dirname(file);
  else if (fault === 'registry') {
    obstruction = join(root, '.agent-loop.yaml');
    writeFileSync(obstruction, yaml.dump({ loops: { custom: 'config/loops/custom/custom.yaml' } }));
  }
  chmodSync(obstruction, fault === 'definition' || fault === 'registry' ? 0o200 : 0o600);
  const install = () => reconcileRunReviewers(root, flowReviewers([{ kind: 'loop', loop: 'custom' }], (name) => resolveLoopDefV2(name, {
    repoDir: root, tiers: { operator: tier, appBundled: join(root, 'absent'), retired: null },
  })));
  try {
    let notice = '';
    try { notice = install().problems.join('\n'); } catch (error) { notice = error instanceof Error ? error.message : String(error); }
    expect.soft(notice).toContain('custom');
    expect.soft(notice).toContain(obstruction);
    expect.soft(notice).not.toContain('escapes');
    const command = /```sh\n([\s\S]*?)```/.exec(notice)?.[1];
    expect(command).toBeDefined();
    execFileSync('/bin/sh', ['-c', command!], { cwd: tmpdir(), stdio: 'pipe' });
    const retried = install();
    expect(retried.problems).toEqual([]);
    expect(retried.wrote).toHaveLength(1);
    expect(readFileSync(retried.wrote[0], 'utf8')).toContain('Required reviewer.');
  } finally {
    chmodSync(obstruction, fault === 'definition' || fault === 'registry' ? 0o600 : 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.getuid?.() === 0)('an unused inaccessible lower tier does not block a readable repository override', () => {
  const root = mkdtempSync(join(tmpdir(), 'resolve-precedence-'));
  const file = seedResolvedLoop(root, 'custom', 'Repository reviewer.\n');
  const obstruction = join(root, 'config');
  mkdirSync(join(obstruction, 'loops'), { recursive: true });
  writeFileSync(join(root, '.agent-loop.yaml'), yaml.dump({ loops: { custom: 'custom/custom.yaml' } }));
  chmodSync(obstruction, 0o600);
  try {
    const result = resolveLoopDefV2('custom', { repoDir: root, tiers: { operator: join(obstruction, 'loops'), appBundled: join(root, 'absent'), retired: null } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.defDir).toBe(realpathSync(dirname(file)));
  } finally {
    chmodSync(obstruction, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.getuid?.() === 0)('reports every inaccessible reviewer source with its persona and repair', () => {
  const root = mkdtempSync(join(tmpdir(), 'resolve-all-reviewers-'));
  const file = seedResolvedLoop(root, 'custom', 'unused');
  const personas = ['review-first', 'review-second'];
  const dirs = personas.map((_persona, i) => join(dirname(file), `source-${i}`));
  for (const dir of dirs) {
    mkdirSync(dir);
    writeFileSync(join(dir, 'charter.md'), 'Required instructions.\n');
    chmodSync(dir, 0o600);
  }
  const def = yaml.load(readFileSync(file, 'utf8')) as Record<string, unknown>;
  def.reviewers = personas.map((persona, i) => ({ persona, charter: `source-${i}/charter.md` }));
  writeFileSync(file, yaml.dump(def));
  try {
    const result = resolveLoopDefV2('custom', { repoDir: root, tiers: { operator: root, appBundled: join(root, 'absent'), retired: null } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const [i, persona] of personas.entries()) {
      expect.soft(result.reason).toContain(persona);
      expect.soft(result.reason).toContain(dirs[i]);
    }
    const commands = [...result.reason.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1]);
    expect(commands).toHaveLength(2);
    for (const command of commands) execFileSync('/bin/sh', ['-c', command], { cwd: tmpdir(), stdio: 'pipe' });
    const roster = flowReviewers([{ kind: 'loop', loop: 'custom' }], (name) => resolveLoopDefV2(name, { repoDir: root, tiers: { operator: root, appBundled: join(root, 'absent'), retired: null } }));
    expect(reconcileRunReviewers(root, roster).problems).toEqual([]);
    expect(roster.reviewers.map((reviewer) => reviewer.persona)).toEqual(personas);
  } finally {
    for (const dir of dirs) chmodSync(dir, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.getuid?.() === 0).each(['relative', 'symlink'] as const)('offers no permission command outside the tier through a %s reference', (kind) => {
  const root = mkdtempSync(join(tmpdir(), 'resolve-confined-repair-'));
  const tier = join(root, 'repo');
  const file = seedResolvedLoop(tier, 'custom', 'Required reviewer.\n');
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'charter.md'), 'Outside instructions.\n');
  let ref = '../../outside/charter.md';
  if (kind === 'symlink') {
    symlinkSync(outside, join(dirname(file), 'linked'));
    ref = 'linked/charter.md';
  }
  const def = yaml.load(readFileSync(file, 'utf8')) as Record<string, unknown>;
  def.reviewers = [{ persona: 'review-result', charter: ref }];
  writeFileSync(file, yaml.dump(def));
  chmodSync(outside, 0o600);
  try {
    const resolve = () => resolveLoopDefV2('custom', { repoDir: tier, tiers: { operator: tier, appBundled: join(tier, 'absent'), retired: null } });
    const refused = resolve();
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect.soft(refused.reason).not.toContain('chmod');
    expect.soft(refused.reason).toMatch(/reference|link/i);
    def.reviewers = [{ persona: 'review-result', charter: 'charter.md' }];
    writeFileSync(file, yaml.dump(def));
    expect(resolve().ok).toBe(true);
  } finally {
    chmodSync(outside, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

it('reports resolution and source validation failures together before writing reviewers', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixed-reviewer-errors-'));
  const tier = join(root, 'loops');
  const empty = seedResolvedLoop(tier, 'empty-source', '');
  seedResolvedLoop(tier, 'valid-source', 'Valid instructions.\n');
  const steps = ['absent-loop', 'empty-source', 'valid-source'].map((loop) => ({ kind: 'loop' as const, loop }));
  const resolve = (name: string) => resolveLoopDefV2(name, { repoDir: root, tiers: { operator: tier, appBundled: join(root, 'absent'), retired: null } });
  const install = () => reconcileRunReviewers(root, flowReviewers(steps, resolve));
  try {
    let notice = '';
    try { notice = install().problems.join('\n'); } catch (error) { notice = error instanceof Error ? error.message : String(error); }
    expect.soft(notice).toContain('absent-loop');
    expect.soft(notice).toContain('empty-source');
    expect.soft(notice).toContain(join(dirname(empty), 'charter.md'));
    expect.soft(notice).toMatch(/empty/i);
    expect(existsSync(join(root, '.claude'))).toBe(false);
    seedResolvedLoop(tier, 'absent-loop', 'Restored instructions.\n');
    writeFileSync(join(dirname(empty), 'charter.md'), 'Repaired instructions.\n');
    const repaired = install();
    expect(repaired.problems).toEqual([]);
    expect(repaired.wrote).toHaveLength(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['dangling', 'cycle'] as const)('refuses a %s operator tier instead of substituting bundled reviewers', (fault) => {
  const root = mkdtempSync(join(tmpdir(), 'broken-reviewer-tier-'));
  const operator = join(root, 'operator');
  const bundled = join(root, 'bundle');
  seedResolvedLoop(bundled, 'custom', 'Bundled instructions.\n');
  symlinkSync(fault === 'cycle' ? operator : join(root, 'absent-target'), operator);
  const install = () => reconcileRunReviewers(root, flowReviewers([{ kind: 'loop', loop: 'custom' }], (name) => resolveLoopDefV2(name, {
    repoDir: root, tiers: { operator, appBundled: bundled, retired: null },
  })));
  try {
    const failed = install();
    expect.soft(failed.wrote).toEqual([]);
    expect.soft(failed.problems.join('\n')).toContain(operator);
    expect.soft(failed.problems.join('\n')).toMatch(/retry/i);
    rmSync(operator);
    seedResolvedLoop(operator, 'custom', 'Operator instructions.\n');
    const repaired = install();
    expect(repaired.problems).toEqual([]);
    expect(repaired.wrote).toHaveLength(1);
    expect(readFileSync(repaired.wrote[0], 'utf8')).toContain('Operator instructions.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


it('reports mixed failures within one loop before any writes and retries every repaired reviewer', () => {
  const root = mkdtempSync(join(tmpdir(), 'same-loop-reviewer-errors-'));
  const tier = join(root, 'loops');
  const file = seedResolvedLoop(tier, 'custom', 'Valid instructions.\n');
  const dir = dirname(file);
  const empty = join(dir, 'empty.md');
  writeFileSync(empty, '');
  const def = yaml.load(readFileSync(file, 'utf8')) as Record<string, unknown>;
  def.reviewers = [
    { persona: 'bad-reference', charter: '../../outside.md', tools: ['Read'] },
    { persona: 'empty-charter', charter: 'empty.md', tools: ['Read'] },
    { persona: 'empty-tools', charter: 'charter.md', tools: [] },
    { persona: 'valid-reviewer', charter: 'charter.md', tools: ['Read'] },
  ];
  writeFileSync(file, yaml.dump(def));
  const install = () => reconcileRunReviewers(root, flowReviewers([{ kind: 'loop', loop: 'custom' }], (name) => resolveLoopDefV2(name, {
    repoDir: root, tiers: { operator: tier, appBundled: join(root, 'absent'), retired: null },
  })));
  try {
    const failed = install();
    const notice = failed.problems.join('\n');
    for (const persona of ['bad-reference', 'empty-charter', 'empty-tools']) expect.soft(notice).toContain(persona);
    expect.soft(notice).toContain('../../outside.md');
    expect.soft(notice).toContain(empty);
    expect.soft(notice).toContain(file);
    expect.soft(notice).toMatch(/escapes/i);
    expect.soft(notice).toMatch(/charter is empty/i);
    expect.soft(notice).toMatch(/declares no tools/i);
    expect.soft(notice).toMatch(/retry/i);
    expect(failed.wrote).toEqual([]);
    expect(existsSync(join(root, '.claude'))).toBe(false);
    def.reviewers = [
      { persona: 'bad-reference', charter: 'charter.md', tools: ['Read'] },
      { persona: 'empty-charter', charter: 'empty.md', tools: ['Read'] },
      { persona: 'empty-tools', charter: 'charter.md', tools: ['Read'] },
      { persona: 'valid-reviewer', charter: 'charter.md', tools: ['Read'] },
    ];
    writeFileSync(file, yaml.dump(def));
    writeFileSync(empty, 'Repaired instructions.\n');
    const repaired = install();
    expect(repaired.problems).toEqual([]);
    expect(repaired.wrote).toHaveLength(4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
