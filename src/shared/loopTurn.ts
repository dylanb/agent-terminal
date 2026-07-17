// §26.3/D47a — the per-turn done-signal contract. One definition so the orchestrator (which emits the
// instruction) and the main-process detector (which watches the file) cannot drift — the shared-semantics
// rule. A turn is "done" when the `.agent-loop/turn-done` FILE is written with the turn key as its content.
//
// §26 D42a — the signal must never be anything the agent can PRINT: a hosted TUI agent reflows the injected
// prompt on echo, so any printable marker named in the prompt is echoed back and read as a completion.

/** The file a turn writes last as a robust, cross-process done-signal. */
export const TURN_DONE_FILENAME = 'turn-done';

/** The §26 engine's repo-relative done-file path (its `.agent-loop/` area) — the default the instruction
 *  names, so §26 is byte-for-byte unchanged. §26 is an active, coexisting engine (§27.15), not deprecated.
 *  The §27 engine passes its own area (.agent-terminal/loop/turn-done): one vocabulary,
 *  directory-parameterized (the ticket's authorized leaf-primitive lift), never a copy. */
export const AGENT_LOOP_DONE_REL_PATH = `.agent-loop/${TURN_DONE_FILENAME}`;

/** The text the orchestrator appends to an injected turn prompt, instructing the agent to write the
 *  done-signal FILE as its final action once its own work and any spawned subagents have finished. When
 *  `artifact` is given — a reference to the turn's required output(s), either a single path (e.g.
 *  `.agent-loop/plan.md`) or a descriptive reference to a set (e.g. every persona's review JSON) — the agent
 *  MUST re-read it and confirm each output is present and non-empty on disk BEFORE writing the done-signal:
 *  a done-signal written while an output was never produced (a silently failed / mis-pathed Write) makes the
 *  run detect "done" against a missing file → retry → error. */
export function doneSignalInstruction(turnKey: string, artifact?: string, doneRelPath: string = AGENT_LOOP_DONE_REL_PATH): string {
  const verify = artifact
    ? [
        '',
        `FIRST confirm your output actually landed on disk: re-read ${artifact} and confirm each is present`,
        'and non-empty (and, if a structured file such as JSON or YAML, that it parses). If any is missing or',
        'empty, this turn is NOT finished — write it correctly and re-read to confirm. Do NOT write the',
        'done-signal file below until you have verified your output on disk.',
      ]
    : [];
  return [
    ...verify,
    '',
    `When this turn (turn-done:${turnKey}) is completely finished (after any spawned subagents have`,
    'returned), your very last action MUST be a tool call that writes the file',
    `${doneRelPath} with its only contents being exactly: ${turnKey}`,
    'Writing that file is what completes the turn. Do not print anything to signal completion — a',
    'full-screen terminal UI mangles printed output, so any printed marker is ignored.',
  ].join('\n');
}
