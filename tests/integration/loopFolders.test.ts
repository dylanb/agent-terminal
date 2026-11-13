import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listLoopFolders, type LoopFolder } from '../../src/main/loopFolders';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { CLAUDE_REVIEWER_AGENT, planReviewerAgents, reviewerAgentName } from '../../src/main/reviewerAgents';
import { bundledLoopDir } from '../helpers/bundledLoops';

const LOOP = 'simple-dev-loop-v1';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'loop-folders-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeLoop(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.yaml`), 'x: 1\n');
}

const byName = (a: LoopFolder, b: LoopFolder): number => a.name.localeCompare(b.name);

const at = (...parts: string[]): string => path.join(root, ...parts);

describe('listLoopFolders', () => {
  it.each<[string, () => void, () => LoopFolder[]]>([
    [
      "a shared loop and a flow's loops",
      () => {
        writeLoop(at('shared-a'), 'shared-a');
        writeLoop(at('flow-x', 'loop-b'), 'loop-b');
        writeFileSync(at('stray.txt'), 'ignored');
      },
      () => [
        { name: 'shared-a', flow: null, dir: at('shared-a') },
        { name: 'loop-b', flow: 'flow-x', dir: at('flow-x', 'loop-b') },
      ],
    ],
    [
      'a stray subfolder beside a flow\'s loop',
      () => {
        writeLoop(at('flow-x', 'loop-b'), 'loop-b');
        mkdirSync(at('flow-x', 'notes', 'drafts'), { recursive: true });
        writeFileSync(at('flow-x', 'notes', 'todo.md'), 'mine\n');
      },
      () => [{ name: 'loop-b', flow: 'flow-x', dir: at('flow-x', 'loop-b') }],
    ],
    [
      'a flow folder that also holds a definition named after it',
      () => {
        writeLoop(at('flow-x'), 'flow-x');
        writeLoop(at('flow-x', 'loop-b'), 'loop-b');
      },
      () => [
        { name: 'flow-x', flow: null, dir: at('flow-x') },
        { name: 'loop-b', flow: 'flow-x', dir: at('flow-x', 'loop-b') },
      ],
    ],
    [
      'names the resolver refuses',
      () => {
        writeLoop(at('Shared_A'), 'Shared_A');
        writeLoop(at('flow-x', 'Loop_B'), 'Loop_B');
        writeLoop(at('Flow_Y', 'loop-c'), 'loop-c');
      },
      () => [],
    ],
  ])('lists %s the way the resolver finds them', (_case, plantTree, expected) => {
    plantTree();
    expect(listLoopFolders(root).sort(byName)).toEqual(expected().sort(byName));
  });

  it('returns nothing for an absent root', () => {
    expect(listLoopFolders(path.join(root, 'missing'))).toEqual([]);
  });
});

describe('planReviewerAgents with a shared loop', () => {
  function sharedLoop(): void {
    cpSync(bundledLoopDir(LOOP), path.join(root, LOOP), { recursive: true });
  }

  it('installs the reviewers of a shared loop', () => {
    sharedLoop();
    const r = resolveLoopDefV2(LOOP, { tiers: { operator: null, appBundled: root, retired: null }, repoDir: root });
    if (!r.ok) throw new Error(r.reason);
    expect(r.def.reviewers.length).toBeGreaterThan(0);
    const rels = planReviewerAgents(root, CLAUDE_REVIEWER_AGENT).map((a) => a.rel);
    for (const p of r.def.reviewers) expect(rels).toContain(`${reviewerAgentName(LOOP, p.persona)}.md`);
  });

  it('refuses a shared loop and a flow copy that disagree', () => {
    sharedLoop();
    const copy = path.join(root, 'flow-x', LOOP);
    cpSync(bundledLoopDir(LOOP), copy, { recursive: true });
    const charterDir = path.join(copy, 'charter');
    const file = readdirSync(charterDir).find((f) => f.endsWith('.md'));
    if (file === undefined) throw new Error('no charter file');
    appendFileSync(path.join(charterDir, file), '\nA changed line.\n');
    expect(() => planReviewerAgents(root, CLAUDE_REVIEWER_AGENT)).toThrow(/disagree on the reviewer/);
  });
});

describe('planReviewerAgents over a flow folder holding more than loops', () => {
  it("installs the flow's reviewers when a stray folder sits beside its loop", () => {
    cpSync(bundledLoopDir(LOOP), path.join(root, 'flow-x', LOOP), { recursive: true });
    mkdirSync(path.join(root, 'flow-x', 'notes'), { recursive: true });
    writeFileSync(path.join(root, 'flow-x', 'notes', 'todo.md'), 'mine\n');
    const r = resolveLoopDefV2(LOOP, { tiers: { operator: null, appBundled: root, retired: null }, repoDir: root, flow: 'flow-x' });
    if (!r.ok) throw new Error(r.reason);

    const rels = planReviewerAgents(root, CLAUDE_REVIEWER_AGENT).map((a) => a.rel);

    expect(r.def.reviewers.length).toBeGreaterThan(0);
    for (const p of r.def.reviewers) expect(rels).toContain(`${reviewerAgentName(LOOP, p.persona)}.md`);
  });
});
