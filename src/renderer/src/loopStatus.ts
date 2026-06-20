// Shared loop-status presentation (§24.2.3 T2). A per-LoopDef `status` is unbounded, so the UI maps
// it onto one of three generic tones rather than an enumerated set (§24.2.3 T0): `await` = needs a
// human (the `awaiting-human-*` family / impasse), `settle` = a terminal/approved end, `work` =
// anything else (in motion). The rail read-out and the docked panel both derive from this one map.

export type SpillTone = 'await' | 'work' | 'settle';

// `awaiting-team-review` is the impl-loop's kind:terminal gate (the loop is done, handed to the team)
// — settled, not human-needed; keep it ahead of the awaiting-* prefix below.
const SETTLE = /^(awaiting-team-review|merged|approved|done|complete|completed|shipped|closed|terminated)$/;

export function spillTone(status: string): SpillTone {
  if (SETTLE.test(status)) return 'settle';
  if (status.startsWith('awaiting-human') || status === 'impasse') return 'await';
  return 'work';
}

/** The compact one-word label for the rail read-out (the panel shows the exact `status`). */
const TONE_LABEL: Record<SpillTone, string> = { await: 'awaiting', work: 'working', settle: 'settled' };
export function toneLabel(status: string): string {
  return TONE_LABEL[spillTone(status)];
}
