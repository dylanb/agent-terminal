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
 *  done-signals as its final action once its own work and any spawned subagents have finished. When
 *  `artifact` names the turn's required output file, the agent MUST re-read it and confirm it is actually
 *  on disk BEFORE signalling — a done-signal emitted while the artifact was never written (a silently
 *  failed / mis-pathed Write) makes the run detect "done" against a missing file → retry → error. */
export function doneSignalInstruction(turnKey: string, artifact?: string): string {
  const verify = artifact
    ? [
        '',
        `FIRST confirm your output artifact actually landed on disk: re-read ${artifact} and verify it exists`,
        'and parses. If it is missing, empty, or malformed, this turn is NOT finished — write it correctly and',
        're-read to confirm. Do NOT emit either done-signal below until you have verified the artifact on disk.',
      ]
    : [];
  return [
    ...verify,
    '',
    'When this turn is completely finished (after any spawned subagents have returned), do this as your',
    'very last action:',
    `  1. REQUIRED — write the file .agent-loop/${TURN_DONE_FILENAME} with a tool call, its only contents`,
    `     exactly: ${turnKey}. Writing this file is what completes the turn; do NOT rely on printing.`,
    `  2. Optional (best-effort) — also print this line, alone on its own line: ${turnDoneSentinel(turnKey)}`,
    '     A full-screen terminal UI may mangle a printed line, so it is NOT what completes the turn — the',
    '     file in step 1 is. Never skip step 1.',
  ].join('\n');
}
