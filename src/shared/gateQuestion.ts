import { stripDisplayControlChars } from './controlChars';
import { autoHaltReasonText, type AutoHaltReason } from './gateAuthority';

/** A stalled turn whose own done-signal still resumes it (§27.12). */
export interface StalledTurn {
  turnKey: string;
  doneRelPath: string;
}

/** §27.9.1 N9b.10 */
export type GateStop =
  | { kind: 'halted'; step: string; reasons: readonly { reason: AutoHaltReason; detail?: string }[]; resume?: StalledTurn }
  | { kind: 'human-gate'; step: string };

/** §27.9.1 N9b.10 */
export function composeGateQuestion(stop: GateStop): string {
  const step = stripDisplayControlChars(stop.step);
  const why =
    stop.kind === 'halted'
      ? ['The engine stopped this `auto` gate instead of deciding it, for these reasons:', ...stop.reasons.map((r) => `- ${stripDisplayControlChars(autoHaltReasonText(r))}`)]
      : ["This step's gate is the operator's by design: its flow gives the decision to a human."];
  return [
    `Why does this gate need me? The flow is stopped at the \`${step}\` gate, waiting for the operator to decide it.`,
    ...why,
    'At the top of your reply, tell the operator exactly what they must decide at this gate and why the engine stopped, citing the reasons above, with your recommendation.',
    ...(stop.kind === 'halted' && stop.resume !== undefined ? resumeLines(stop.resume) : ['Change no files and write no done-file: this is a question, not a turn.']),
  ].join('\n');
}

function resumeLines(turn: StalledTurn): string[] {
  const key = stripDisplayControlChars(turn.turnKey);
  return [
    'The engine stopped because the screen was quiet for the whole stall window, which also happens while you wait on a command or subagent you started.',
    `If turn ${key} is still under way, answer the operator, then carry on: finish the turn and write ${turn.doneRelPath} with exactly ${key} as its last action. That resumes the loop with no Retry.`,
    'If the turn is not under way, change no files and write no done-file: this is a question, not a turn.',
  ];
}
