import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { load } from 'js-yaml';
import { auditGateEntries, autoGateFlowYaml, loopRoster, seedTrustedFlow, type AutoGateLoop } from '../e2e/autoGateHarness';
import { loadUntrustedFlowDefinition } from '../../src/main/flow';
import { resolveCatalogEntry } from '../../src/main/flowCatalog';
import { readActiveFlow } from '../../src/main/activeFlowPointer';
import { bundledLoopDir } from '../helpers/bundledLoops';
import { auditFilePath, auditRootDir } from '../../src/main/auditPaths';
import { auditTimestamp, lifecycleEvents, serializeDoc, type AuditEvent } from '../../src/shared/audit';

const dirs: string[] = [];
const tmp = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('autoGateFlowYaml', () => {
  it('builds a flow the production parser accepts, with the groom ticket input and no authority key when omitted', () => {
    const yaml = autoGateFlowYaml([
      { id: 'groom', kind: 'loop', loop: 'groom-loop' },
      { id: 'red', kind: 'loop', loop: 'red-loop' },
      { id: 'done', kind: 'manual' },
    ]);
    const file = join(tmp('agh-flow-'), 'flow.yaml');
    writeFileSync(file, yaml);
    const parsed = loadUntrustedFlowDefinition(file);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.definition.steps.map((s) => s.id)).toEqual(['groom', 'red', 'done']);
    expect(parsed.definition.steps[0].inputs).toEqual([expect.objectContaining({ name: 'ticket', type: 'github-ticket', required: true })]);
    expect(yaml).not.toContain('gate_authority');
  });

  it('writes the declared authority on each step that names one', () => {
    const doc = load(
      autoGateFlowYaml([
        { id: 'red', kind: 'loop', loop: 'red-loop', authority: 'auto' },
        { id: 'green', kind: 'loop', loop: 'green-loop', authority: 'human' },
        { id: 'done', kind: 'manual' },
      ]),
    ) as { steps: { id: string; gate_authority?: string }[] };
    expect(doc.steps.map((s) => s.gate_authority)).toEqual(['auto', 'human', undefined]);
  });
});

describe('loopRoster', () => {
  it.each<AutoGateLoop>(['groom-loop', 'plan-bundle-loop', 'plan-polish-loop', 'red-loop', 'green-loop', 'refactor-loop'])(
    'matches the reviewer personas the shipped %s declares',
    (loop) => {
      const def = load(readFileSync(join(bundledLoopDir(loop), `${loop}.yaml`), 'utf8')) as { reviewers: { persona: string }[] };
      expect(loopRoster(loop)).toEqual(def.reviewers.map((r) => r.persona));
    },
  );
});

describe('catalog seeds', () => {
  it('seedTrustedFlow lands the entry in the global tier and makes it active', () => {
    const home = tmp('agh-home-');
    const repo = tmp('agh-repo-');
    seedTrustedFlow(home, repo, 'auto-trusted', autoGateFlowYaml([{ id: 'done', kind: 'manual' }]));
    expect(resolveCatalogEntry({ worktreeDir: repo, globalRoot: home }, 'auto-trusted')).toMatchObject({ ok: true, tier: 'global' });
    expect(readActiveFlow(repo)).toEqual({ kind: 'value', id: 'auto-trusted' });
  });

});

describe('auditGateEntries', () => {
  const started = new Date('2026-10-05T10:00:00.000Z');
  const gate = (cmd: string): AuditEvent => ({ ts: auditTimestamp(started), type: 'command', source: 'gate', cmd, exit: 0 });
  const seedRun = (home: string, repo: string, flow: string, events: AuditEvent[]): void => {
    const file = auditFilePath(auditRootDir(home), repo, flow, started);
    mkdirSync(dirname(file), { recursive: true });
    const header = { flow, repo: 'r', repoPath: repo, started: auditTimestamp(started) };
    writeFileSync(file, [header, ...events].map(serializeDoc).join(''));
  };
  const ts = auditTimestamp(started);
  const twoStepRun = (): AuditEvent[] => [
    ...lifecycleEvents('start', { status: 'not_started', stepName: '' }, { status: 'in_progress', stepName: 'red' }, ts),
    gate('§27 gate approve'),
    { ts, type: 'command', source: 'loop', cmd: 'not a gate', exit: 0 },
    ...lifecycleEvents('advance', { status: 'in_progress', stepName: 'red' }, { status: 'in_progress', stepName: 'green' }, ts),
    gate('§27 gate request-changes'),
  ];

  it('reads the run named by flow-state.yaml, keeping only gate commands, scoped to a step when asked', () => {
    const home = tmp('agh-home-');
    const repo = tmp('agh-repo-');
    mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
    writeFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), `flow: auto-gate\nstep: green\nstatus: in_progress\nstarted_at: ${started.getTime()}\n`);
    seedRun(home, repo, 'auto-gate', twoStepRun());
    expect(auditGateEntries(home, repo).map((e) => e.cmd)).toEqual(['§27 gate approve', '§27 gate request-changes']);
    expect(auditGateEntries(home, repo, { step: 'red' })).toEqual([{ cmd: '§27 gate approve', exit: 0 }]);
    expect(auditGateEntries(home, repo, { step: 'green' })).toEqual([{ cmd: '§27 gate request-changes', exit: 0 }]);
  });

  it('reads an explicit run identity when the flow state is gone', () => {
    const home = tmp('agh-home-');
    const repo = tmp('agh-repo-');
    seedRun(home, repo, 'auto-gate', twoStepRun());
    expect(auditGateEntries(home, repo, { run: { flow: 'auto-gate', startedAt: started.getTime() }, step: 'green' })).toHaveLength(1);
  });

  it('throws rather than reading empty when the identity, the file or the step is missing', () => {
    const home = tmp('agh-home-');
    const repo = tmp('agh-repo-');
    expect(() => auditGateEntries(home, repo)).toThrow(/flow-state\.yaml/);
    mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
    writeFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), `step: red\nstatus: in_progress\nstarted_at: ${started.getTime()}\n`);
    expect(() => auditGateEntries(home, repo)).toThrow(/no flow/);
    const run = { flow: 'auto-gate', startedAt: started.getTime() };
    expect(() => auditGateEntries(home, repo, { run })).toThrow(/no audit file/);
    seedRun(home, repo, 'auto-gate', twoStepRun());
    expect(() => auditGateEntries(home, repo, { run, step: 'refactor' })).toThrow(/refactor/);
  });

  it('throws on an unscoped read of a second-granular audit file two Starts share, while a step-scoped read keeps only the later run', () => {
    const home = tmp('agh-home-');
    const repo = tmp('agh-repo-');
    const restart = lifecycleEvents('start', { status: 'not_started', stepName: '' }, { status: 'in_progress', stepName: 'red' }, ts);
    seedRun(home, repo, 'auto-gate', [...twoStepRun(), ...restart, gate('§27 gate request-changes')]);
    const run = { flow: 'auto-gate', startedAt: started.getTime() };
    expect(() => auditGateEntries(home, repo, { run })).toThrow(/more than one run/);
    expect(auditGateEntries(home, repo, { run, step: 'red' })).toEqual([{ cmd: '§27 gate request-changes', exit: 0 }]);
  });

  it('throws rather than reading a prefix when a document in the run file does not parse', () => {
    const home = tmp('agh-home-');
    const repo = tmp('agh-repo-');
    seedRun(home, repo, 'auto-gate', twoStepRun());
    const run = { flow: 'auto-gate', startedAt: started.getTime() };
    const file = auditFilePath(auditRootDir(home), repo, 'auto-gate', started);
    const text = readFileSync(file, 'utf8');
    const lastGate = text.lastIndexOf('---\n');
    writeFileSync(file, `${text.slice(0, lastGate)}---\nnot: an event\n${text.slice(lastGate)}`);
    expect(() => auditGateEntries(home, repo, { run })).toThrow(/parse/);
    expect(() => auditGateEntries(home, repo, { run, step: 'red' })).toThrow(/parse/);
  });

  it('throws on a step-scoped read of a step only the earlier of two runs sharing the file entered', () => {
    const home = tmp('agh-home-');
    const repo = tmp('agh-repo-');
    const restart = lifecycleEvents('start', { status: 'not_started', stepName: '' }, { status: 'in_progress', stepName: 'red' }, ts);
    seedRun(home, repo, 'auto-gate', [...twoStepRun(), { ts, type: 'flow.terminated' }, ...restart, gate('§27 gate approve')]);
    const run = { flow: 'auto-gate', startedAt: started.getTime() };
    expect(() => auditGateEntries(home, repo, { run, step: 'green' })).toThrow(/green/);
  });
});
