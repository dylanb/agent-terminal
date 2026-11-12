// Which agents ran in a run: the terminal hosted them while one of the run's step windows was open. The run's §25
// record holds the set, so it survives a relaunch.

import { AGENT_KINDS, type AgentKind } from '../shared/agentKind';
import type { RunTimeline } from '../shared/audit';

export interface AgentHostingDeps {
  /** The worktree the terminal is in. */
  terminalRepo(): string | null;
  currentRun(repoKey: string): Pick<RunTimeline, 'visits' | 'agents'>;
  /** The agent the terminal hosts now, when it is recognisably one. */
  hostedAgent(): AgentKind | null;
  record(repoKey: string, agent: AgentKind): void;
  log?(message: string, error: unknown): void;
}

export interface AgentHosting {
  /** Records the agent the terminal hosts, if a step window is open and the run has not recorded it yet. */
  sample(): void;
}

export function createAgentHosting(deps: AgentHostingDeps): AgentHosting {
  const log = deps.log ?? ((message, error): void => console.error(message, error));
  return {
    sample() {
      try {
        const repo = deps.terminalRepo();
        if (repo === null) return;
        const run = deps.currentRun(repo);
        if (run.visits.at(-1)?.exited !== null) return;
        if (AGENT_KINDS.every((kind) => run.agents.includes(kind))) return;
        const agent = deps.hostedAgent();
        if (agent === null || run.agents.includes(agent)) return;
        deps.record(repo, agent);
      } catch (e: unknown) {
        log('agent hosting sample failed', e);
      }
    },
  };
}
