// §26.3/D47a — the per-turn done-signal contract. One definition so the orchestrator (which emits the
// instruction), the main-process detectors (which match the line / the file), and the e2e fake-agent
// (which reproduces both) cannot drift — the shared-semantics rule. A turn is "done" when EITHER the
// sentinel LINE appears in the instance's output OR the sentinel FILE is written under .agent-loop/.

/** The `.agent-loop/`-relative file a turn writes last as a robust, cross-process done-signal. */
export const TURN_DONE_FILENAME = 'turn-done';

/** The exact line a turn prints on completion, scoped by `turnKey` (e.g. `work-plan`). ASCII-only and
 *  delimiter-wrapped so it survives a PTY (§8.2) and is unlikely to occur in ordinary output. */
export function turnDoneSentinel(turnKey: string): string {
  return `<<<agent-loop:turn-done:${turnKey}>>>`;
}

/** The text the orchestrator appends to an injected turn prompt, instructing the agent to emit BOTH
 *  done-signals as its final action once its own work and any spawned subagents have finished. */
export function doneSignalInstruction(turnKey: string): string {
  return [
    '',
    'When this turn is completely finished (after any spawned subagents have returned), do BOTH of the',
    'following as your very last action:',
    `  1. Write the file .agent-loop/${TURN_DONE_FILENAME} whose only contents are exactly: ${turnKey}`,
    `  2. Print this exact line, alone on its own line: ${turnDoneSentinel(turnKey)}`,
  ].join('\n');
}
