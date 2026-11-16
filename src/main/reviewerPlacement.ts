// §27.4.

import type { AgentKind } from '../shared/agentKind';
import { DEFAULT_AGENT_KIND } from './agentKind';

export type ReviewerHome = 'run-folder' | 'codex-home';

/** Where the agent loads its reviewers from: the run folder, installed per run, or its own home. */
export function reviewerHome(kind: AgentKind): ReviewerHome {
  switch (kind) {
    case 'claude-code':
      return 'run-folder';
    case 'codex':
      return 'codex-home';
  }
}

/** Nothing identified at the prompt yet installs for the default agent, whichever starts next. */
export function installsPerRun(kind: AgentKind | null): boolean {
  return reviewerHome(kind ?? DEFAULT_AGENT_KIND) === 'run-folder';
}

export function reviewerFix(kind: AgentKind): string {
  switch (reviewerHome(kind)) {
    case 'run-folder':
      return 'Reviewers run as Claude Code sub-agents the app installs in the run folder, each carrying its charter: fix what is named, restart your agent session in the run folder so it loads them, then Retry';
    case 'codex-home':
      return 'Reviewers run as the Codex agents installed with the example loops, each carrying its charter: install the example loops again, restart your agent session so it loads them, then Retry';
  }
}
