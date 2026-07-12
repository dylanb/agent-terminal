// What the always-visible status bar shows (§22.3). One definition of the title-precedence rule, the
// alert condition, and the activity pass-through, so the renderer and any future producer cannot drift
// (CLAUDE.md shared-semantics rule; the sibling of occurrence.ts / loopStatus.ts / loopActivity.ts).

import type { FlowStateView } from './ipc';
import type { LoopActivity } from './loopActivity';

/** Which name the bar shows, and therefore what the user can do with it: a `pr`/`ticket` title is
 *  resolved from GitHub and opens there; a `user` title is typed in place (empty → the name-me
 *  placeholder); `unavailable` is a flow that failed to load, whose machine is inert and must not
 *  persist, so it offers no edit at all. A union, not a flat record: no mode can carry a field
 *  another mode ignores. */
export type StatusBarTitle =
  | { kind: 'pr'; number: number }
  | { kind: 'ticket'; number: number }
  | { kind: 'user'; text: string }
  | { kind: 'unavailable' };

/** Everything the bar renders. All three coexist; the bar sheds them only under space pressure. */
export interface StatusBarModel {
  title: StatusBarTitle;
  /** The engine's current phrase, or null when it is idle. */
  activity: LoopActivity | null;
  /** The loop is blocked on a human (§24.2.3 T4), or null. */
  alert: { status: string; iteration: number; pr: number | null } | null;
}

/** The bar before any repo is known: it is still there, still inviting a name — it just has nothing to
 *  report. A status bar with no status is the empty state, not a hidden bar. */
export const IDLE_STATUS_BAR: StatusBarModel = { title: { kind: 'user', text: '' }, activity: null, alert: null };

function titleOf(view: FlowStateView): StatusBarTitle {
  if (view.status === 'error') return { kind: 'unavailable' };
  if (view.refs?.pr !== undefined) return { kind: 'pr', number: view.refs.pr };
  if (view.refs?.ticket !== undefined) return { kind: 'ticket', number: view.refs.ticket };
  return { kind: 'user', text: view.userTitle ?? '' };
}

export function deriveStatusBar(view: FlowStateView): StatusBarModel {
  const loop = view.loop;
  return {
    title: titleOf(view),
    activity: view.loopActivity ?? null,
    alert:
      loop && loop.humanNeeded === true
        ? { status: loop.status, iteration: loop.iteration, pr: loop.pr }
        : null,
  };
}
