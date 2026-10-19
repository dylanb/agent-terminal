// #207 — the retired §27.6 materiality floor: its gate (a finding is fixed only when acting on it changes an
// observable outcome) and its three examples sent to `dismissed — invalid`.

import { INVALID_DISPOSITION } from '../../src/shared/roundReport';
import { sentencesOf } from './statesText';

const FLOOR_GATE = /\bfix\b[^.]*?\bonly when\b[^.]*?\bchanges an observable outcome/i;
export const FLOOR_EXAMPLES: [string, RegExp][] = [
  ['equal-quality rewording', /equal-quality reword/i],
  ['already-correct citation', /already[- ]correct/i],
  ['defensible authoring choice', /defensible authoring choice/i],
];

/** Whether `text` makes changing an observable outcome the condition for fixing a finding. */
export const statesFloorGate = (text: string): boolean => sentencesOf(text).some((sentence) => FLOOR_GATE.test(sentence));

export const sendsToInvalid = (text: string, example: RegExp): boolean =>
  sentencesOf(text).some((sentence) => example.test(sentence) && sentence.includes(`\`${INVALID_DISPOSITION}\``));
