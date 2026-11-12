// A real flow of manual steps driven through the flow manager, its windows and hosted agents written by the real §25
// recorder, and a token meter decorating the views it returns with counts read from the fixture logs. The meter's
// refresh runs only when a test steps it, and its clock is the one the recorder writes with.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFlowManager, flowCatalogDir, FLOW_DEF_FILE } from '../../src/main/flow';
import { createRunResolver } from '../../src/main/runResolver';
import { writeActiveFlow } from '../../src/main/activeFlowPointer';
import { createAuditRecorder } from '../../src/main/auditRecorder';
import { createTokenMeter, type RefreshSchedule, type TokenMeter } from '../../src/main/tokenMeter';
import type { AgentKind } from '../../src/shared/agentKind';
import type { FlowStateView } from '../../src/shared/ipc';
import { claudeCodeLogs, codexLogs, logsTempDir, type BilledTokens, type ClaudeCodeLogs, type CodexLogs, type LogsTempDir } from './agentUsageLogs';

export const METER_FLOW = 'Token Meter Flow';

export interface MeterRig {
  worktree: string;
  auditRoot: string;
  claudeConfigRoot: string;
  codexHome: string;
  logs: LogsTempDir;
  claude: ClaudeCodeLogs;
  codex: CodexLogs;
  meterOn(showing: boolean): TokenMeter;
  /** Logs one Claude Code call in the main session. */
  bill(at: number, tokens: BilledTokens): void;
  /** Starts the run at `at`, the terminal hosting `agents` (Claude Code unless told otherwise). */
  start(opts?: { at?: number; agents?: AgentKind[] }): FlowStateView;
  advance(at: number): FlowStateView;
  undo(at: number): FlowStateView;
  terminate(at: number): FlowStateView;
  state(): FlowStateView;
  /** Sets the clock a count is read at, without recording anything. */
  setNow(at: number): void;
  /** Run one scheduled refresh, as the timer would. */
  tick(): Promise<void>;
  scheduled(): boolean;
  pushes(): number;
}

const CLAUDE_CODE_ONLY: AgentKind[] = ['claude-code'];

const manualStep = (id: string): string => `  - id: ${id}\n    kind: manual\n`;

/** `steps` are the flow's manual steps; `startedAt` is the default start instant. */
export function meterRig(onCleanup: (cleanup: () => void) => void, opts: { steps?: string[]; startedAt: number }): MeterRig {
  const logs = logsTempDir('token-meter-', onCleanup);
  const { dir } = logs;
  const worktree = join(dir, 'repo');
  const globalDir = join(dir, 'global');
  const auditRoot = join(dir, 'audit');
  const claudeConfigRoot = join(dir, 'claude');
  const codexHome = join(dir, 'codex');
  mkdirSync(join(worktree, '.agent-terminal'), { recursive: true });
  mkdirSync(globalDir);
  const entry = join(flowCatalogDir(worktree), 'token-meter');
  mkdirSync(entry, { recursive: true });
  writeFileSync(join(entry, FLOW_DEF_FILE), `name: ${METER_FLOW}\nsteps:\n${(opts.steps ?? ['plan', 'build']).map(manualStep).join('')}`);
  writeActiveFlow(worktree, 'token-meter');
  const resolve = createRunResolver(globalDir);
  const flow = createFlowManager({ globalDir, loadDefinition: (repoKey) => resolve(repoKey) });
  let clock = opts.startedAt;
  const recorder = createAuditRecorder({ root: auditRoot, now: () => new Date(clock), flowName: () => METER_FLOW });
  const claude = claudeCodeLogs(claudeConfigRoot, worktree);
  let refresh: (() => Promise<void>) | null = null;
  const schedule: RefreshSchedule = {
    start(r) {
      refresh = r;
      return () => {
        refresh = null;
      };
    },
  };
  let pushed = 0;
  const transition = (kind: 'advance' | 'undo', at: number, mutate: () => FlowStateView): FlowStateView => {
    clock = at;
    const before = flow.state(worktree);
    const after = mutate();
    recorder.recordTransition(worktree, kind, before, after);
    return after;
  };
  return {
    worktree,
    auditRoot,
    claudeConfigRoot,
    codexHome,
    logs,
    claude,
    codex: codexLogs(codexHome, worktree),
    meterOn: (showing) =>
      createTokenMeter({ auditRoot, logRoots: { claudeConfigRoot, codexHome }, schedule, showing, now: () => clock, changed: () => void pushed++ }),
    bill: (at, tokens) => void claude.bill({ at, tokens }),
    start({ at = opts.startedAt, agents = CLAUDE_CODE_ONLY } = {}) {
      clock = at;
      const view = flow.start(worktree, { startedAt: at });
      recorder.recordTransition(worktree, 'start', { status: 'not_started', stepName: '' }, view, { startedAt: at, flow: METER_FLOW });
      for (const agent of agents) recorder.recordHostedAgent(worktree, agent);
      return view;
    },
    advance: (at) => transition('advance', at, () => flow.advance(worktree)),
    undo: (at) => transition('undo', at, () => flow.undo(worktree)),
    terminate(at) {
      clock = at;
      const result = flow.terminate(worktree);
      recorder.recordTerminate(worktree);
      return result.outcome === 'reset' ? result.view : flow.state(worktree);
    },
    state: () => flow.state(worktree),
    setNow(at) {
      clock = at;
    },
    tick: () => (refresh === null ? Promise.resolve() : refresh()),
    scheduled: () => refresh !== null,
    pushes: () => pushed,
  };
}
