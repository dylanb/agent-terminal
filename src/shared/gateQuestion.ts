import { stripDisplayControlChars } from './controlChars';
import { autoHaltReasonText, type AutoHaltReason } from './gateAuthority';

/** §27.9.1 N9b.10 */
export type GateStop =
  | { kind: 'halted'; step: string; reasons: readonly { reason: AutoHaltReason; detail?: string }[] }
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
    'Change no files and write no done-file: this is a question, not a turn.',
  ].join('\n');
}
