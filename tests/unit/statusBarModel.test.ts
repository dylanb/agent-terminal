import { describe, expect, it } from 'vitest';
import { deriveStatusBar, normalizeTitle, sameTitle, TITLE_MAX } from '../../src/shared/statusBar';
import { loopActivity } from '../../src/shared/loopActivity';
import type { FlowLoopView, FlowStateView } from '../../src/shared/ipc';

// The one definition of what the always-visible status bar shows (§22.3.1): the title-precedence rule
// (PR → ticket → user), the alert condition, and the activity pass-through. Shared so the renderer and
// any future producer cannot drift on it (CLAUDE.md shared-semantics; sibling of loopStatus/occurrence).

const view = (over: Partial<FlowStateView> = {}): FlowStateView => ({
  stepName: 'implement', runStarted: 'never-started' as const,
  steps: ['implement'],
  position: 1,
  total: 1,
  status: 'in_progress',
  ...over,
});

const loop = (over: Partial<FlowLoopView> = {}): FlowLoopView => ({
  status: 'impl-draft',
  iteration: 3,
  pr: 57,
  branch: 'b',
  ready: false,
  humanNeeded: false,
  ...over,
});

describe('status bar model (§22.3.1)', () => {
  describe('title precedence — PR, then ticket, then the user title', () => {
    it('prefers the PR when the flow is working both a ticket and a PR', () => {
      expect(deriveStatusBar(view({ refs: { ticket: 42, pr: 57 } })).title).toEqual({ kind: 'pr', number: 57 });
    });

    it('falls back to the ticket when there is no PR yet', () => {
      expect(deriveStatusBar(view({ refs: { ticket: 42 } })).title).toEqual({ kind: 'ticket', number: 42 });
    });

    it('falls back to the user title when the flow works neither a ticket nor a PR', () => {
      expect(deriveStatusBar(view({ userTitle: 'Refactor the shadow parser' })).title).toEqual({
        kind: 'user',
        text: 'Refactor the shadow parser',
      });
    });

    it('offers an empty user title — the name-me placeholder — when nothing at all is known', () => {
      expect(deriveStatusBar(view()).title).toEqual({ kind: 'user', text: '' });
    });

    it('hides but does not discard a user title once a ref supplies one', () => {
      // The user's name stays on disk (flow-state.yaml); it is merely outranked. Nothing in the model
      // may report it as absent, or a later ref-less view would come back empty.
      const named = view({ userTitle: 'Refactor the shadow parser', refs: { pr: 57 } });
      expect(deriveStatusBar(named).title).toEqual({ kind: 'pr', number: 57 });
      // The same persisted title, once the refs are gone (flow terminated), is shown again.
      expect(deriveStatusBar(view({ userTitle: 'Refactor the shadow parser' })).title).toEqual({
        kind: 'user',
        text: 'Refactor the shadow parser',
      });
    });

    it('names the work of a directory whose flow never loaded — the case where nothing else can', () => {
      // A directory with no flow.yaml has no PR and no ticket either, so the user title is the ONLY thing
      // that can ever name it. The name belongs to the worktree, not to a flow that happened to load.
      expect(deriveStatusBar(view({ status: 'error', error: 'no flow.yaml', userTitle: 'Spike the parser' })).title).toEqual({
        kind: 'user',
        text: 'Spike the parser',
      });
    });

    it('invites a name on a directory whose flow never loaded and has never been named', () => {
      expect(deriveStatusBar(view({ status: 'error', error: 'no flow.yaml' })).title).toEqual({ kind: 'user', text: '' });
    });
  });

  // One predicate for what a persisted name IS, imported by the machine, the on-disk store and the
  // renderer's optimistic paint alike — a writer and a reader of one file are two sides of one contract
  // exactly as two processes are (CLAUDE.md shared-semantics).
  describe('normalizeTitle — the one rule for what counts as a name', () => {
    it('takes the name the user typed', () => {
      expect(normalizeTitle('Refactor the shadow parser')).toBe('Refactor the shadow parser');
    });

    it('trims, so the optimistic paint cannot disagree with what lands on disk', () => {
      expect(normalizeTitle('  Refactor  ')).toBe('Refactor');
    });

    it('treats a blank as no name at all, so it never persists as an empty string', () => {
      expect(normalizeTitle('')).toBeNull();
      expect(normalizeTitle('   ')).toBeNull();
    });

    it('rejects anything that is not a string — a hand-edited or repo-supplied YAML value', () => {
      expect(normalizeTitle(undefined)).toBeNull();
      expect(normalizeTitle(null)).toBeNull();
      expect(normalizeTitle(42)).toBeNull();
      expect(normalizeTitle({ toString: () => 'evil' })).toBeNull();
    });

    it('bounds the name, so a pasted megabyte cannot land in a file re-parsed on every state query', () => {
      const long = normalizeTitle('x'.repeat(10_000));
      expect(long).not.toBeNull();
      expect(long!.length).toBe(TITLE_MAX);
    });

    it('strips control, bidi, and line-separator characters from a repo-supplied name but keeps ZWJ/ZWNJ (CWE-117, CWE-1007, CWE-116)', () => {
      const cp = (...codes: number[]): string => String.fromCharCode(...codes);
      const dangerous = [0x00, 0x1f, 0x7f, 0x9f, 0x061c, 0x200b, 0x200e, 0x200f, 0x2028, 0x2029, 0x202e, 0x2066, 0xfeff];
      const cleaned = normalizeTitle(`safe${cp(...dangerous)}text` + cp(0x200d, 0x200c));
      expect(cleaned).not.toBeNull();
      for (const c of dangerous) expect(cleaned!.includes(cp(c))).toBe(false);
      expect(cleaned!).toContain('safe');
      expect(cleaned!).toContain('text');
      expect(cleaned!.includes(cp(0x200d))).toBe(true); // ZWJ preserved
      expect(cleaned!.includes(cp(0x200c))).toBe(true); // ZWNJ preserved
    });
  });

  describe('sameTitle — identity over the union, so a new kind cannot silently dedup away', () => {
    it('separates the kinds that share a number, and matches a kind against itself', () => {
      expect(sameTitle({ kind: 'pr', number: 7 }, { kind: 'ticket', number: 7 })).toBe(false);
      expect(sameTitle({ kind: 'pr', number: 7 }, { kind: 'pr', number: 7 })).toBe(true);
    });

    it('separates two names, and matches one against itself', () => {
      expect(sameTitle({ kind: 'user', text: 'a' }, { kind: 'user', text: 'b' })).toBe(false);
      expect(sameTitle({ kind: 'user', text: 'a' }, { kind: 'user', text: 'a' })).toBe(true);
    });

    it('never matches against nothing', () => {
      expect(sameTitle(null, { kind: 'user', text: 'a' })).toBe(false);
      expect(sameTitle({ kind: 'user', text: 'a' }, null)).toBe(false);
    });
  });

  describe('the alert — the loop is blocked on a human', () => {
    it('raises an alert naming the status, iteration and PR when the loop needs a human', () => {
      const m = deriveStatusBar(view({ loop: loop({ status: 'awaiting-human-pr-approval', humanNeeded: true }) }));
      expect(m.alert).toEqual({ status: 'awaiting-human-pr-approval', iteration: 3, pr: 57 });
    });

    it('raises no alert while the loop is working', () => {
      expect(deriveStatusBar(view({ loop: loop({ humanNeeded: false }) })).alert).toBeNull();
    });

    it('raises no alert when there is no loop at all', () => {
      expect(deriveStatusBar(view()).alert).toBeNull();
    });
  });

  describe('the engine activity', () => {
    it('carries the phrase the engine reports', () => {
      expect(deriveStatusBar(view({ loopActivity: loopActivity('pickup', { issue: 40 }) })).activity).toEqual({
        phrase: 'Bootstrapping #40',
      });
    });

    it('reports no activity when the engine is idle', () => {
      expect(deriveStatusBar(view()).activity).toBeNull();
    });

    it('reports the activity alongside an alert — neither suppresses the other', () => {
      const m = deriveStatusBar(
        view({
          refs: { pr: 57 },
          loopActivity: loopActivity('pickup', { issue: 12 }),
          loop: loop({ status: 'awaiting-human-pr-approval', humanNeeded: true }),
        }),
      );
      expect(m.title).toEqual({ kind: 'pr', number: 57 });
      expect(m.activity).toEqual({ phrase: 'Bootstrapping #12' });
      expect(m.alert).not.toBeNull();
    });
  });
});
