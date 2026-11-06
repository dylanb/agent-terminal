import type { TicketRef } from './appBootstrap';

// §19.1 — the running flow's current ticket has ONE source of truth: the `ticket` value under `inputs:` in the
// worktree's `.agent-terminal/flow-state.yaml`, which the engine resolves to a number (flow refs → `workRefs`,
// the SAME identity the gate side-effects act on) and states in the prompt. Every turn — work, consolidate,
// review — binds to that resolved issue through these shared lines, so the agent operates on THIS ticket and
// never re-derives it from the branch, open PR, or working directory (CLAUDE.md: the receiver never re-derives
// its target from ambient state), and no per-composer copy can drift.
export function ticketPromptLines(ticket: number): string[] {
  return [
    '',
    `TICKET — this loop is working GitHub issue #${ticket}. Operate on that issue and no other.`,
    'Do not infer the issue from the current git branch, open PR, or working directory.',
  ];
}

/** What an adopting run presents in place of a ticket run's ticket: the reviewed pull request, every ticket it
 *  closes as intent, and its change as the range from the recorded merge-base to the fix branch. */
export interface AdoptedRunRefs {
  pr: number;
  /** origin's GitHub host, which every `gh` instruction names. */
  host: string;
  tickets: TicketRef[];
  baseOid: string;
  fixBranch: string;
}
