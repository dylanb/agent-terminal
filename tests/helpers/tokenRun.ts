// A run whose step windows and agents are written by the real §25 recorder and whose Claude Code and Codex spend is
// written by the fixture writers, read back the way the app reads them: the run's record through auditRun, the logs
// of the agents it names through the sweep, the counts through stepTokens. Every time is a hand-picked instant in
// the past, so the writers accept it.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createAuditRecorder } from '../../src/main/auditRecorder';
import { readAuditRun } from '../../src/main/auditRun';
import { sweepAgentUsage } from '../../src/main/agentUsage/sweep';
import { stepTokens } from '../../src/main/stepTokens';
import type { FlowLike, TransitionKind } from '../../src/shared/audit';
import type { FlowTokensView } from '../../src/shared/ipc';
import type { AgentKind } from '../../src/shared/agentKind';
import { claudeCodeLogs, codexLogs, logsTempDir, type ClaudeCodeLogs, type CodexLogs } from './agentUsageLogs';

export const TOKEN_RUN_FLOW = 'token-flow';

export interface TokenRun {
  worktree: string;
  auditRoot: string;
  claudeConfigRoot: string;
  codexHome: string;
  claude: ClaudeCodeLogs;
  codex: CodexLogs;
  /** Start the run at `step`, as the production Start records it. */
  start(step: string, at: number): void;
  /** Record at `at` that the terminal hosted `agent`, as the app does when it first sees it during the run. */
  host(agent: AgentKind, at: number): void;
  /** Record a later transition at `at`. */
  move(kind: Exclude<TransitionKind, 'start'>, before: FlowLike, after: FlowLike, at: number): void;
  terminate(at: number): void;
  /** The counts of `steps` as the app reads them at `now`, by default the last instant the run recorded. */
  tokens(steps: string[], now?: number): Promise<FlowTokensView>;
}

/** `codexHome` defaults to a folder of the run's own; give one that does not exist for a machine without Codex. */
export function createTokenRun(onCleanup: (cleanup: () => void) => void, startedAt: number, opts: { codexHome?: (dir: string) => string } = {}): TokenRun {
  const { dir } = logsTempDir('token-run-', onCleanup);
  const auditRoot = join(dir, 'audit');
  const claudeConfigRoot = join(dir, 'claude');
  const codexHome = opts.codexHome?.(dir) ?? join(dir, 'codex');
  const worktree = join(dir, 'repo');
  mkdirSync(worktree);
  let clock = startedAt;
  const recorder = createAuditRecorder({ root: auditRoot, now: () => new Date(clock), flowName: () => TOKEN_RUN_FLOW });
  return {
    worktree,
    auditRoot,
    claudeConfigRoot,
    codexHome,
    claude: claudeCodeLogs(claudeConfigRoot, worktree),
    codex: codexLogs(codexHome, worktree),
    start(step, at) {
      if (at !== startedAt) throw new Error('a token run starts at the instant it was created for');
      recorder.recordTransition(worktree, 'start', { status: 'not_started', stepName: step }, { status: 'in_progress', stepName: step }, { startedAt: at, flow: TOKEN_RUN_FLOW });
    },
    host(agent, at) {
      clock = at;
      recorder.recordHostedAgent(worktree, agent);
    },
    move(kind, before, after, at) {
      clock = at;
      recorder.recordTransition(worktree, kind, before, after);
    },
    terminate(at) {
      clock = at;
      recorder.recordTerminate(worktree);
    },
    async tokens(steps, now) {
      const run = readAuditRun(auditRoot, { repoPath: worktree, flow: TOKEN_RUN_FLOW, started: new Date(startedAt) });
      const sweep = await sweepAgentUsage({ claudeConfigRoot, codexHome }, worktree, run.agents, startedAt);
      return stepTokens(run.visits, steps, sweep, now ?? clock);
    },
  };
}
