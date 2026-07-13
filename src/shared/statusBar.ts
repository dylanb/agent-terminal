import type { FlowStateView } from './ipc';
import type { LoopActivity } from './loopActivity';

/** The name the bar shows, and therefore what may be done with it: a `pr`/`ticket` opens GitHub; a
 *  `user` name is typed in place. */
export type StatusBarTitle =
  | { kind: 'pr'; number: number }
  | { kind: 'ticket'; number: number }
  | { kind: 'user'; text: string };

export interface StatusBarModel {
  title: StatusBarTitle;
  activity: LoopActivity | null;
  /** The loop is blocked on a human (§24.2.3 T4). */
  alert: { status: string; iteration: number; pr: number | null } | null;
}

export const IDLE_STATUS_BAR: StatusBarModel = { title: { kind: 'user', text: '' }, activity: null, alert: null };

/** A name is re-read and re-parsed on every state query, and can arrive from a repo-supplied
 *  flow-state.yaml as easily as from the editor (CWE-400 / CWE-1284). */
export const TITLE_MAX = 200;

export function normalizeTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // CWE-117 / CWE-1007: this is the one boundary every read (decode) and write (IPC validate) crosses,
  // so a repo-supplied name is neutralized here rather than at each human-facing sink.
  const text = raw
    .replace(/[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, ' ')
    .trim()
    .slice(0, TITLE_MAX);
  return text.length > 0 ? text : null;
}

function titleKey(t: StatusBarTitle): string {
  switch (t.kind) {
    case 'pr':
      return `pr:${t.number}`;
    case 'ticket':
      return `ticket:${t.number}`;
    case 'user':
      return `user:${t.text}`;
    default: {
      const never: never = t;
      return never;
    }
  }
}

export function sameTitle(a: StatusBarTitle | null, b: StatusBarTitle | null): boolean {
  return a !== null && b !== null && titleKey(a) === titleKey(b);
}

function titleOf(view: FlowStateView): StatusBarTitle {
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
