// #207 — the retired §27.6 materiality floor, as the composer tests and the drift tests detect it: its gate (a
// finding is fixed only when acting on it changes an observable outcome) and its three examples sent to
// `dismissed — invalid`. The self-checks live in `tests/unit/reviewTurn.test.ts`.

import { normaliseText } from './statesText';

export const FLOOR_GATE = /\bfix\b[^.]*?\bonly when\b[^.]*?\bchanges an observable outcome/i;
export const FLOOR_EXAMPLES: [string, RegExp][] = [
  ['equal-quality rewording', /equal-quality reword/i],
  ['already-correct citation', /already[- ]correct/i],
  ['defensible authoring choice', /defensible authoring choice/i],
];

export const sendsToInvalid = (text: string, example: RegExp): boolean =>
  normaliseText(text)
    .split(/(?<=[.!?])\s+/)
    .some((sentence) => example.test(sentence) && sentence.includes('`dismissed — invalid`'));
