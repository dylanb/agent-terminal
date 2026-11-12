// Helpers for the e2e that drive a real gate (§27.9.1), built on the shared fake tools.

import { expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { writeActiveFlow } from '../../src/main/activeFlowPointer';
import { auditFilePath, auditRootDir } from '../../src/main/auditPaths';
import { parseAuditStream, stepWindowEvents, type AuditEvent } from '../../src/shared/audit';
import { exampleConsolidatorOutput } from '../../src/shared/consolidatorOutput';
import { shellQuote } from '../../src/shared/shellQuote';
import { exampleConfigDir, seedFakeAgentV2, seedFakeGhGit, writeCatalogEntry } from './fakeTools';

export type AutoGateLoop = 'groom-loop' | 'plan-approve-loop' | 'red-loop' | 'green-loop' | 'refactor-loop';

export interface AutoGateStep {
  id: string;
  kind: 'loop' | 'manual';
  loop?: AutoGateLoop;
  authority?: 'human' | 'auto';
  /** Gives a step of any kind the `ticket` input a `groom-loop` step always carries. */
  ticketInput?: boolean;
}

/** The review roster a shipped example loop declares, for the fake agent's round reports. */
export function loopRoster(loop: AutoGateLoop): string[] {
  const def = load(readFileSync(join(exampleConfigDir, 'loops-v2', loop, `${loop}.yaml`), 'utf8')) as { reviewers?: { persona?: unknown }[] } | null;
  const personas = (def?.reviewers ?? []).map((r) => r.persona);
  if (personas.length === 0 || !personas.every((p): p is string => typeof p === 'string')) throw new Error(`loopRoster: ${loop} declares no reviewer personas`);
  return personas;
}

/** The one flow builder for the auto-gate e2e. A `groom-loop` step, and a step marked `ticketInput`, carries a
 *  required `github-ticket` input named `ticket` (pre-supplied by `seedAutoGateRepo`'s `ticket` option); an
 *  omitted `authority` writes no `gate_authority` key. */
export function autoGateFlowYaml(steps: AutoGateStep[], name = 'auto-gate'): string {
  const lines = [`name: ${JSON.stringify(name)}`, 'steps:'];
  for (const s of steps) {
    lines.push(`  - id: ${s.id}`, `    kind: ${s.kind}`);
    if (s.kind === 'loop') {
      if (s.loop === undefined) throw new Error(`autoGateFlowYaml: loop step "${s.id}" names no loop`);
      lines.push(`    loop: ${s.loop}`, '    loop_namespace: app');
    }
    if (s.loop === 'groom-loop' || s.ticketInput === true) {
      lines.push('    inputs:', '      - name: ticket', '        type: github-ticket', '        required: true');
    }
    if (s.authority !== undefined) lines.push(`    gate_authority: ${s.authority}`);
  }
  return `${lines.join('\n')}\n`;
}

export const AUTO_GATE_CAPABILITIES = 'test_globs:\n  - tests/**\ntest_command: pnpm test\nbuild_command: pnpm run build\n';

/** A real git repo at its baseline commit, its §27 bootstrap complete and its flow not started at `firstStep`;
 *  `.agent-terminal/` is gitignored so engine state never rides into a phase commit. A `plan` artifact is
 *  present for loops that declare it as an input; `ticket` pre-supplies a groom step's ticket input. */
export function seedAutoGateRepo(prefix: string, firstStep: string, opts: { localFlowYaml?: string; ticket?: string } = {}): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const git = (...args: string[]): void => void execFileSync('git', args, { cwd: dir });
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/plan-loop/issue-176');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 'T');
  writeFileSync(join(dir, '.gitignore'), '.agent-terminal/\n.agent-loop/\n');
  writeFileSync(join(dir, 'seed.txt'), 'seed\n');
  mkdirSync(join(dir, 'tests'));
  writeFileSync(join(dir, 'tests', 'frozen.test.ts'), 'test("baseline", () => {});\n');
  writeFileSync(join(dir, 'loop-capabilities.yaml'), AUTO_GATE_CAPABILITIES);
  const loopDir = join(dir, '.agent-terminal', 'loop');
  mkdirSync(join(loopDir, 'artifacts'), { recursive: true });
  writeFileSync(join(loopDir, 'artifacts', 'plan.md'), '# plan\n');
  writeFileSync(
    join(loopDir, 'bootstrap.yaml'),
    'schema_version: 1\nstatus: complete\npr: 4242\nbranch: plan-loop/issue-176\nissue: 176\ninitial_status: planning\nupdated_at: 2026-07-23T00:00:00.000Z\n',
  );
  const inputs = opts.ticket === undefined ? '' : `inputs:\n  ticket: ${JSON.stringify(opts.ticket)}\n`;
  writeFileSync(join(dir, '.agent-terminal', 'flow-state.yaml'), `step: ${firstStep}\nstatus: not_started\n${inputs}`);
  if (opts.localFlowYaml !== undefined) writeFileSync(join(dir, '.agent-terminal', 'flow.yaml'), opts.localFlowYaml);
  git('add', '-A');
  git('commit', '-qm', 'baseline');
  return dir;
}

/** An operator-catalog flow (the global tier under `home`) made active for `repo`. */
export function seedTrustedFlow(home: string, repo: string, id: string, yaml: string): void {
  writeCatalogEntry(home, id, yaml);
  writeActiveFlow(repo, id);
}

export interface HeldHumanGate {
  repo: string;
  /** Starts the agent and its flow in `terminal`, resolving once the agent holds its verdict. */
  start(terminal: Page): Promise<void>;
  /** Lets the held verdict through, resolving once the run is stopped at its human gate. */
  release(): Promise<void>;
  dispose(): void;
}

/** A real human gate (a red-loop step whose review says "stop for a human") that the agent reaches only when the
 *  test calls `release`, so a test can put the controller in any state first. Adds the fake tools to `env`. */
export function heldHumanGate(fixture: { home: string; env: Record<string, string> }, prefix: string): HeldHumanGate {
  const repo = seedAutoGateRepo(`${prefix}-`, 'red');
  let binDir: string | undefined;
  const dispose = (): void => {
    rmSync(repo, { recursive: true, force: true });
    if (binDir) rmSync(binDir, { recursive: true, force: true });
  };
  try {
    const tools = seedFakeGhGit(`${prefix}-tools-`, { realCommitOps: true });
    binDir = tools.binDir;
    seedTrustedFlow(fixture.home, repo, 'held-gate', autoGateFlowYaml([
      { id: 'red', kind: 'loop', loop: 'red-loop', authority: 'auto' }, { id: 'verify', kind: 'manual' },
    ], 'held-gate'));
    writeFileSync(join(binDir, 'verdict-hold'), 'hold');
    seedFakeAgentV2(binDir, {
      holdConsolidate: { sentinel: join(binDir, 'verdict-hold') },
      stepId: 'red', artifactRel: '.agent-terminal/loop/artifacts/red-result.json', work: 'red',
      roster: loopRoster('red-loop'), verdicts: [exampleConsolidatorOutput('stop for a human', loopRoster('red-loop'))],
    });
    Object.assign(fixture.env, {
      PATH: `${binDir}:${fixture.env.PATH ?? process.env.PATH}`, FAKE_GHGIT_LOG: tools.logFile,
      CLAUDE_CONFIG_DIR: exampleConfigDir, APP_SUBMIT_DELAY_MS: '100',
    });
  } catch (error) {
    dispose();
    throw error;
  }
  const verdictHold = join(binDir, 'verdict-hold');
  const stateFile = join(repo, '.agent-terminal', 'loop', 'run-state.yaml');
  return {
    repo,
    async start(terminal) {
      await terminal.locator('.xterm-screen').click();
      await terminal.keyboard.type(`cd ${shellQuote(repo)}; fake-agent`);
      await terminal.keyboard.press('Enter');
      const control = terminal.locator('#flow-strip .flow-control');
      await expect(control).toHaveText('Start');
      await control.click();
      await expect.poll(() => existsSync(`${verdictHold}.pids`), { timeout: 60_000 }).toBe(true);
    },
    async release() {
      rmSync(verdictHold);
      await expect.poll(() => { try { return readFileSync(stateFile, 'utf8'); } catch { return ''; } }, { timeout: 60_000 })
        .toContain('verdict: stop for a human');
    },
    dispose,
  };
}

export interface AuditRunIdentity {
  flow: string;
  startedAt: number;
}

export interface GateEntry {
  cmd: string;
  exit: number | null;
}

export function runIdentity(repo: string): AuditRunIdentity {
  const file = `${repo}/.agent-terminal/flow-state.yaml`;
  if (!existsSync(file)) throw new Error(`auditGateEntries: ${file} is missing`);
  const doc = load(readFileSync(file, 'utf8')) as { flow?: unknown; started_at?: unknown } | null;
  if (typeof doc?.started_at !== 'number') throw new Error('auditGateEntries: flow-state.yaml has no started_at');
  if (typeof doc.flow !== 'string') throw new Error('auditGateEntries: flow-state.yaml has no flow');
  return { flow: doc.flow, startedAt: doc.started_at };
}

/** The §25 gate command entries of one run, resolved with the writer's own `auditFilePath` from the run's
 *  identity (`flow-state.yaml`, or `opts.run` for a run whose state a Terminate cleared), optionally scoped to
 *  `step`'s last entry window. A missing file, identity or step throws, so an empty read never satisfies a
 *  "none" assertion. */
export function auditGateEntries(home: string, repo: string, opts: { run?: AuditRunIdentity; step?: string } = {}): GateEntry[] {
  const run = opts.run ?? runIdentity(repo);
  const file = auditFilePath(auditRootDir(home), repo, run.flow, new Date(run.startedAt));
  if (!existsSync(file)) throw new Error(`auditGateEntries: no audit file at ${file}`);
  const text = readFileSync(file, 'utf8');
  const { header, events } = parseAuditStream(text);
  const documents = text.split('\n').filter((line) => line === '---').length;
  if (header === null || events.length !== documents - 1) {
    throw new Error(`auditGateEntries: ${file} has ${documents} documents but only ${events.length} events parse after its header`);
  }
  if (opts.step !== undefined) {
    const lastStart = events.map((e) => e.type).lastIndexOf('flow.started');
    return gateEntries(stepWindowEvents(events.slice(Math.max(lastStart, 0)), opts.step));
  }
  if (events.filter((e) => e.type === 'flow.started').length > 1) throw new Error(`auditGateEntries: ${file} holds more than one run (two Starts in one second)`);
  return gateEntries(events);
}

function gateEntries(events: AuditEvent[]): GateEntry[] {
  return events.flatMap((e) => (e.type === 'command' && e.source === 'gate' ? [{ cmd: e.cmd, exit: e.exit }] : []));
}
