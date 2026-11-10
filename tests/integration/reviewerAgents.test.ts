import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { applyInstallExamples, exampleInstallDirs, type InstallDestination } from '../../src/main/installExamples';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { reviewRoster, reviewerAgentFor } from '../../src/main/reviewTurn';
import { installedCodexReviewerProblem, installedReviewerProblem, renderCodexReviewerAgent, renderReviewerAgent } from '../../src/main/reviewerAgents';
import { parse as parseToml } from 'smol-toml';
import { useBuiltBundle } from '../helpers/builtBundle';

const builtBundle = useBuiltBundle();

// §27.4 — every reviewer of every bundled loop is installed as a Claude Code sub-agent whose own instructions
// are its charter, so a reviewer is never asked to go and read it. Expected values come from the bundle itself.
const BUNDLE_LOOPS = path.resolve('example', 'loops-v2');

const codexName = (loop: string, persona: string, flow = 'feature-dev-v3'): string => reviewerAgentFor('codex', { ...{ flow }, loop, persona });

interface BundledReviewer {
  flow: string;
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
        out.push({ flow, loop, persona: r.persona, tools: r.tools, charterPath: path.join(root, flow, loop, r.charter) });
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
  dirs = exampleInstallDirs(builtBundle(), { flowGlobalDir: home, configDir: configRoot, codexHome: path.join(home, '.codex') });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(configRoot, { recursive: true, force: true });
});

describe('installing the examples installs each bundled reviewer as a sub-agent carrying its charter', () => {
  it('writes a flow-aware Claude agent file for every reviewer, named so, with front-matter tools matching its definition and its charter as the body', () => {
    const res = applyInstallExamples(dirs, []);
    if (!res.ok) throw new Error(res.error);
    const reviewers = bundledReviewers(BUNDLE_LOOPS);
    expect(reviewers.length).toBeGreaterThan(0);
    for (const r of reviewers) {
      const name = reviewerAgentFor('claude-code', r);
      const file = path.join(configRoot, 'agents', `${name}.md`);
      expect(existsSync(file), file).toBe(true);
      const { front, body } = parseAgent(readFileSync(file, 'utf8'));
      expect(front.name).toBe(name);
      expect(front.tools, `${name} tools`).toBe(r.tools?.join(', '));
      expect(typeof front.description).toBe('string');
      expect(body).toBe(readFileSync(r.charterPath, 'utf8'));
    }
  });

  it('reports each reviewer file created under the agents destination', () => {
    const res = applyInstallExamples(dirs, []);
    if (!res.ok) throw new Error(res.error);
    const created = res.created.find((g) => g.destination === 'agents')?.files ?? [];
    const expected = [...new Set(bundledReviewers(BUNDLE_LOOPS).map((r) => `${reviewerAgentFor('claude-code', r)}.md`))].sort();
    expect([...created].sort()).toEqual(expected);
  });
});

// §18.1 — the same reviewers, installed as Codex custom agents where Codex is.
describe('installing the examples installs each bundled reviewer as a Codex custom agent', () => {
  const codexHome = (): string => path.join(home, '.codex');
  const install = (): void => {
    mkdirSync(codexHome());
    const res = applyInstallExamples(dirs, []);
    if (!res.ok) throw new Error(res.error);
  };

  it('writes a flow-aware Codex agent file for every reviewer: valid TOML, named so, ending with its charter', () => {
    install();
    const reviewers = bundledReviewers(BUNDLE_LOOPS);
    for (const r of reviewers) {
      const name = codexName(r.loop, r.persona, r.flow);
      expect(name).toMatch(/^[a-z0-9_]+$/);
      const file = path.join(codexHome(), 'agents', `${name}.toml`);
      expect(existsSync(file), file).toBe(true);
      const agent = parseToml(readFileSync(file, 'utf8')) as Record<string, unknown>;
      expect(agent.name).toBe(name);
      expect(typeof agent.description).toBe('string');
      expect(String(agent.developer_instructions).endsWith(readFileSync(r.charterPath, 'utf8'))).toBe(true);
    }
  });

  it('installs one Codex agent for exactly each Claude Code sub-agent', () => {
    install();
    const claude = readdirSync(path.join(configRoot, 'agents'));
    const codex = readdirSync(path.join(codexHome(), 'agents'));
    expect(codex).toHaveLength(claude.length);
  });

  it('installs no Codex agent when the Codex home does not exist', () => {
    const res = applyInstallExamples(dirs, []);
    if (!res.ok) throw new Error(res.error);
    expect(existsSync(codexHome())).toBe(false);
    expect(res.notInstalled).toContainEqual({ destination: 'codexAgents', root: codexHome() });
  });

  it('installs a reviewer that has every tool (§27.4)', () => {
    const agent = parseToml(renderCodexReviewerAgent({ ...{ flow: 'feature-dev-v3' }, loop: 'green-loop', persona: 'impl-review-tests', tools: 'all', charter: 'c' })) as Record<string, unknown>;
    expect(agent.name).toBe(codexName('green-loop', 'impl-review-tests'));
  });

  it('refuses a reviewer whose explicit tool list grants more than reading, since a Codex agent cannot be narrowed to it', () => {
    expect(() => renderCodexReviewerAgent({ ...{ flow: 'feature-dev-v3' }, loop: 'green-loop', persona: 'impl-review-tests', tools: ['Read', 'Edit'], charter: 'c' })).toThrow(/Edit/);
  });

  it('installs a reviewer limited to reading and running commands', () => {
    const agent = parseToml(renderCodexReviewerAgent({ ...{ flow: 'feature-dev-v3' }, loop: 'green-loop', persona: 'impl-review-tests', tools: ['Read', 'Grep', 'Glob', 'Bash'], charter: 'c' })) as Record<string, unknown>;
    expect(agent.name).toBe(codexName('green-loop', 'impl-review-tests'));
  });

  it.each(['impl_review', 'impl--review', 'a"b'])('refuses a persona %j two reviewers could share a Codex name with, or TOML cannot carry', (persona) => {
    expect(() => renderCodexReviewerAgent({ ...{ flow: 'feature-dev-v3' }, loop: 'green-loop', persona, tools: 'all', charter: 'c' })).toThrow(/cannot name a reviewer sub-agent/);
  });

  it('refuses a reviewer that declares no tools', () => {
    expect(() => renderCodexReviewerAgent({ ...{ flow: 'feature-dev-v3' }, loop: 'green-loop', persona: 'impl-review-tests', tools: [], charter: 'c' })).toThrow(/declares no tools/);
  });

  it("refuses a charter a TOML literal string cannot carry (one holding ''')", () => {
    expect(() => renderCodexReviewerAgent({ ...{ flow: 'feature-dev-v3' }, loop: 'green-loop', persona: 'impl-review-tests', tools: ['Read'], charter: "x ''' y" })).toThrow(/'''/);
  });
});

describe('a reviewer runs only as the installed sub-agent carrying the charter this run resolved', () => {
  const agentsDir = (): string => path.join(configRoot, 'agents');
  const greenRoster = () => {
    const r = resolveLoopDefV2('green-loop', { tiers: { operator: null, appBundled: BUNDLE_LOOPS, retired: null }, repoDir: home, flow: 'feature-dev-v3' });
    if (!r.ok) throw new Error(r.reason);
    return reviewRoster(r.def).map((reviewer) => ({ ...reviewer, flow: 'feature-dev-v3' }));
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
    expect(installedReviewerProblem(agentsDir(), reviewer)).toContain(reviewerAgentFor('claude-code', reviewer));
  });

  it('names the charter when the run resolved a different one than the sub-agent carries', () => {
    install();
    const [reviewer] = greenRoster();
    const edited = path.join(home, 'edited-principal.md');
    writeFileSync(edited, `${readFileSync(reviewer.charter, 'utf8')}\nAn operator edit.\n`);
    const problem = installedReviewerProblem(agentsDir(), { ...reviewer, charter: edited });
    expect(problem).toContain(reviewerAgentFor('claude-code', reviewer));
    expect(problem).toContain(edited);
  });

  it('names the tools when the run limits a reviewer the installed sub-agent gives every tool', () => {
    install();
    const [reviewer] = greenRoster();
    const problem = installedReviewerProblem(agentsDir(), { ...reviewer, tools: ['Read'] });
    expect(problem).toContain(reviewerAgentFor('claude-code', reviewer));
    expect(problem).toMatch(/tools/i);
  });

  it('names the tools when the installed sub-agent limits a reviewer the run gives every tool', () => {
    install();
    const [reviewer] = greenRoster();
    const limited = renderReviewerAgent({ ...{ flow: 'feature-dev-v3' }, loop: 'green-loop', persona: reviewer.persona, tools: ['Read'], charter: readFileSync(reviewer.charter, 'utf8') });
    writeFileSync(path.join(agentsDir(), `${reviewerAgentFor('claude-code', reviewer)}.md`), limited);
    const problem = installedReviewerProblem(agentsDir(), reviewer);
    expect(problem).toContain(reviewerAgentFor('claude-code', reviewer));
    expect(problem).toMatch(/tools/i);
  });

  it('reports a problem, never a pass, when there is no agents directory to look in', () => {
    const [reviewer] = greenRoster();
    expect(installedReviewerProblem(null, reviewer)).toMatch(/CLAUDE_CONFIG_DIR/);
  });
});

describe('under Codex a reviewer runs only as the installed Codex agent carrying the charter this run resolved', () => {
  const codexAgents = (): string => path.join(home, '.codex', 'agents');
  const greenRoster = () => {
    const r = resolveLoopDefV2('green-loop', { tiers: { operator: null, appBundled: BUNDLE_LOOPS, retired: null }, repoDir: home, flow: 'feature-dev-v3' });
    if (!r.ok) throw new Error(r.reason);
    return reviewRoster(r.def).map((reviewer) => ({ ...reviewer, flow: 'feature-dev-v3' }));
  };
  const install = (): void => {
    mkdirSync(path.join(home, '.codex'), { recursive: true });
    const res = applyInstallExamples(dirs, []);
    if (!res.ok) throw new Error(res.error);
  };

  it('finds no problem with any reviewer of a bundled loop once the examples are installed', () => {
    install();
    for (const reviewer of greenRoster()) expect(installedCodexReviewerProblem(codexAgents(), reviewer)).toBeNull();
  });

  it('names the missing Codex agent when it was never installed', () => {
    const [reviewer] = greenRoster();
    expect(installedCodexReviewerProblem(codexAgents(), reviewer)).toContain(`no Codex agent ${codexName(reviewer.loop, reviewer.persona)} is installed`);
  });

  it('names the charter when the run resolved a different one than the Codex agent carries', () => {
    install();
    const [reviewer] = greenRoster();
    const edited = path.join(home, 'edited-principal.md');
    writeFileSync(edited, `${readFileSync(reviewer.charter, 'utf8')}\nAn operator edit.\n`);
    const problem = installedCodexReviewerProblem(codexAgents(), { ...reviewer, charter: edited });
    expect(problem).toContain(codexName(reviewer.loop, reviewer.persona));
    expect(problem).toContain(edited);
  });

  it('reports a problem, never a pass, when there is no Codex home to look in', () => {
    const [reviewer] = greenRoster();
    expect(installedCodexReviewerProblem(null, reviewer)).toMatch(/CODEX_HOME/);
  });
});
