import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { applyInstallExamples, exampleInstallDirs, type InstallDestination } from '../../src/main/installExamples';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { reviewRoster } from '../../src/main/reviewTurn';
import { installedReviewerProblem, renderReviewerAgent } from '../../src/main/reviewerAgents';

// §27.4 — every reviewer of every bundled loop is installed as a Claude Code sub-agent whose own instructions
// are its charter, so a reviewer is never asked to go and read it. Expected values come from the bundle itself.
const BUNDLE_LOOPS = path.resolve('example', 'loops-v2');

interface BundledReviewer {
  loop: string;
  persona: string;
  tools: string[] | undefined;
  charterPath: string;
}

function bundledReviewers(root: string): BundledReviewer[] {
  const out: BundledReviewer[] = [];
  for (const flow of readdirSync(root)) {
    for (const loop of readdirSync(path.join(root, flow))) {
      const defPath = path.join(root, flow, loop, `${loop}.yaml`);
      if (!existsSync(defPath)) continue;
      const def = parseYaml(readFileSync(defPath, 'utf8')) as { reviewers: { persona: string; charter: string; tools?: string[] }[] };
      for (const r of def.reviewers) {
        out.push({ loop, persona: r.persona, tools: r.tools, charterPath: path.join(root, flow, loop, r.charter) });
      }
    }
  }
  return out;
}

function parseAgent(text: string): { front: Record<string, unknown>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`not a front-mattered agent file:\n${text.slice(0, 200)}`);
  return { front: parseYaml(m[1]) as Record<string, unknown>, body: m[2] };
}

let home: string;
let configRoot: string;
let dirs: InstallDestination[];

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'reviewer-agents-home-'));
  configRoot = mkdtempSync(path.join(tmpdir(), 'reviewer-agents-cfg-'));
  dirs = exampleInstallDirs({ packaged: false, appPath: process.cwd() }, home, configRoot);
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(configRoot, { recursive: true, force: true });
});

describe('installing the examples installs each bundled reviewer as a sub-agent carrying its charter', () => {
  it('writes <config>/agents/<loop>--<persona>.md for every reviewer, named so, with every tool and its charter as the body', () => {
    const res = applyInstallExamples(dirs, []);
    if (!res.ok) throw new Error(res.error);
    const reviewers = bundledReviewers(BUNDLE_LOOPS);
    expect(reviewers.length).toBeGreaterThan(0);
    for (const r of reviewers) {
      const name = `${r.loop}--${r.persona}`;
      const file = path.join(configRoot, 'agents', `${name}.md`);
      expect(existsSync(file), file).toBe(true);
      const { front, body } = parseAgent(readFileSync(file, 'utf8'));
      expect(front.name).toBe(name);
      expect(r.tools, `${name} declares a tools list`).toBeUndefined();
      expect(front.tools, `${name} restricts its tools`).toBeUndefined();
      expect(typeof front.description).toBe('string');
      expect(body).toBe(readFileSync(r.charterPath, 'utf8'));
    }
  });

  it('reports each reviewer file created under the agents destination', () => {
    const res = applyInstallExamples(dirs, []);
    if (!res.ok) throw new Error(res.error);
    const created = res.created.find((g) => g.destination === 'agents')?.files ?? [];
    const expected = [...new Set(bundledReviewers(BUNDLE_LOOPS).map((r) => `${r.loop}--${r.persona}.md`))].sort();
    expect([...created].sort()).toEqual(expected);
  });

  it('refuses, writing nothing, when two bundled flows ship different charters for one loop and persona', () => {
    const bundle = mkdtempSync(path.join(tmpdir(), 'reviewer-agents-bundle-'));
    try {
      cpSync(BUNDLE_LOOPS, bundle, { recursive: true });
      const shared = bundledReviewers(bundle).filter((r, _i, all) => all.some((o) => o !== r && o.loop === r.loop && o.persona === r.persona));
      expect(shared.length).toBeGreaterThan(0);
      writeFileSync(shared[0].charterPath, `${readFileSync(shared[0].charterPath, 'utf8')}\nA divergent line.\n`);
      const res = applyInstallExamples(dirs.map((d) => (d.id === 'agents' ? { ...d, bundleDir: bundle } : d)), []);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toContain(`${shared[0].loop}--${shared[0].persona}`);
      expect(existsSync(path.join(configRoot, 'agents'))).toBe(false);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
    }
  });
});

describe('a reviewer runs only as the installed sub-agent carrying the charter this run resolved', () => {
  const agentsDir = (): string => path.join(configRoot, 'agents');
  const greenRoster = () => {
    const r = resolveLoopDefV2('green-loop', { tiers: { operator: null, appBundled: BUNDLE_LOOPS, retired: null }, repoDir: home, flow: 'feature-dev-v2' });
    if (!r.ok) throw new Error(r.reason);
    return reviewRoster(r.def);
  };
  const install = (): void => {
    const res = applyInstallExamples(dirs, []);
    if (!res.ok) throw new Error(res.error);
  };

  it('finds no problem with any reviewer of a bundled loop once the examples are installed', () => {
    install();
    for (const reviewer of greenRoster()) expect(installedReviewerProblem(agentsDir(), reviewer)).toBeNull();
  });

  it('names the missing sub-agent when it was never installed', () => {
    const [reviewer] = greenRoster();
    expect(installedReviewerProblem(agentsDir(), reviewer)).toContain(reviewer.agent);
  });

  it('names the charter when the run resolved a different one than the sub-agent carries', () => {
    install();
    const [reviewer] = greenRoster();
    const edited = path.join(home, 'edited-principal.md');
    writeFileSync(edited, `${readFileSync(reviewer.charter, 'utf8')}\nAn operator edit.\n`);
    const problem = installedReviewerProblem(agentsDir(), { ...reviewer, charter: edited });
    expect(problem).toContain(reviewer.agent);
    expect(problem).toContain(edited);
  });

  it('names the tools when the run limits a reviewer the installed sub-agent gives every tool', () => {
    install();
    const [reviewer] = greenRoster();
    const problem = installedReviewerProblem(agentsDir(), { ...reviewer, tools: ['Read'] });
    expect(problem).toContain(reviewer.agent);
    expect(problem).toMatch(/tools/i);
  });

  it('names the tools when the installed sub-agent limits a reviewer the run gives every tool', () => {
    install();
    const [reviewer] = greenRoster();
    const limited = renderReviewerAgent({ loop: 'green-loop', persona: reviewer.persona, tools: ['Read'], charter: readFileSync(reviewer.charter, 'utf8') });
    writeFileSync(path.join(agentsDir(), `${reviewer.agent}.md`), limited);
    const problem = installedReviewerProblem(agentsDir(), reviewer);
    expect(problem).toContain(reviewer.agent);
    expect(problem).toMatch(/tools/i);
  });

  it('reports a problem, never a pass, when there is no agents directory to look in', () => {
    const [reviewer] = greenRoster();
    expect(installedReviewerProblem(null, reviewer)).toMatch(/CLAUDE_CONFIG_DIR/);
  });
});
