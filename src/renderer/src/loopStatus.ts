// Shared loop-status presentation (§24.2.3 T2). A per-LoopDef `status` is unbounded, so the UI maps
// it onto three generic tones rather than an enumerated set (§24.2.3 T0): `await` = needs a human,
// `settle` = a terminal/approved end, `work` = anything else.

import { isHumanNeededStatus } from '../../shared/loopStatus';
import type { FlowLoopView } from '../../shared/ipc';

/** §27.9.1 N9b.5(e) */
export type ToneSource = string | Pick<FlowLoopView, 'status' | 'humanNeeded' | 'autoGate'>;

export type SpillTone = 'await' | 'work' | 'settle';

// `awaiting-team-review` is the impl-loop's kind:terminal gate (the loop is done, handed to the team)
// — settled, not human-needed; keep it ahead of the awaiting-* prefix below.
const SETTLE = /^(awaiting-team-review|merged|approved|done|complete|completed|shipped|closed|terminated)$/;

export function spillTone(source: ToneSource): SpillTone {
  if (typeof source !== 'string' && source.autoGate !== undefined) {
    if (source.humanNeeded === true) return 'await';
    return SETTLE.test(source.status) ? 'settle' : 'work';
  }
  const status = typeof source === 'string' ? source : source.status;
  if (SETTLE.test(status)) return 'settle';
  if (isHumanNeededStatus(status)) return 'await';
  return 'work';
}

/** The compact one-word label for the rail read-out (the panel shows the exact `status`). */
const TONE_LABEL: Record<SpillTone, string> = { await: 'awaiting', work: 'working', settle: 'settled' };
export function toneLabel(source: ToneSource): string {
  return TONE_LABEL[spillTone(source)];
}
