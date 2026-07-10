// §26.3/D47a — the per-turn done-signal contract. One definition so the orchestrator (which emits the
// instruction) and the main-process detector (which watches the file) cannot drift — the shared-semantics
// rule. A turn is "done" when the `.agent-loop/turn-done` FILE is written with the turn key as its content.
//
// §26 D42a — the signal must never be anything the agent can PRINT: a hosted TUI agent reflows the injected
// prompt on echo, so any printable marker named in the prompt is echoed back and read as a completion.

/** The `.agent-loop/`-relative file a turn writes last as a robust, cross-process done-signal. */
export const TURN_DONE_FILENAME = 'turn-done';

/** The text the orchestrator appends to an injected turn prompt, instructing the agent to write the
 *  done-signal FILE as its final action once its own work and any spawned subagents have finished. When
 *  `artifact` names the turn's required output file, the agent MUST re-read it and confirm it is actually
 *  on disk BEFORE writing the done-signal — a done-signal written while the artifact was never produced (a
 *  silently failed / mis-pathed Write) makes the run detect "done" against a missing file → retry → error. */
export function doneSignalInstruction(turnKey: string, artifact?: string): string {
  const verify = artifact
    ? [
        '',
        `FIRST confirm your output artifact actually landed on disk: re-read ${artifact} and verify it exists`,
        'and is non-empty (and, if it is a structured file such as JSON or YAML, that it parses). If it is',
        'missing or empty, this turn is NOT finished — write it correctly and re-read to confirm. Do NOT write',
        'the done-signal file below until you have verified the artifact on disk.',
      ]
    : [];
  return [
    ...verify,
    '',
    `When this turn (turn-done:${turnKey}) is completely finished (after any spawned subagents have`,
    'returned), your very last action MUST be a tool call that writes the file',
    `.agent-loop/${TURN_DONE_FILENAME} with its only contents being exactly: ${turnKey}`,
    'Writing that file is what completes the turn. Do not print anything to signal completion — a',
    'full-screen terminal UI mangles printed output, so any printed marker is ignored.',
  ].join('\n');
}
