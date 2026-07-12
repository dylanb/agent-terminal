import { describe, expect, it } from 'vitest';
import { deriveStatusBar } from '../../src/shared/statusBar';
import { loopActivity } from '../../src/shared/loopActivity';
import type { FlowLoopView, FlowStateView } from '../../src/shared/ipc';

// The one definition of what the always-visible status bar shows (§22.3): the title-precedence rule
// (PR → ticket → user), the alert condition, and the activity pass-through. Shared so the renderer and
// any future producer cannot drift on it (CLAUDE.md shared-semantics; sibling of loopStatus/occurrence).

const view = (over: Partial<FlowStateView> = {}): FlowStateView => ({
  stepName: 'implement',
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

describe('status bar model (§22.3)', () => {
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

    it('is unavailable — never editable — on a flow that failed to load', () => {
      // The machine is inert in the error state and must not persist (a bad flow.yaml cannot clobber a
      // good on-disk progression), so offering an edit here would silently no-op.
      expect(deriveStatusBar(view({ status: 'error', error: 'bad yaml', userTitle: 'x' })).title).toEqual({
        kind: 'unavailable',
      });
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
      expect(deriveStatusBar(view({ loopActivity: loopActivity('reviewers') })).activity).toEqual({
        phrase: 'Running reviewers',
      });
    });

    it('reports no activity when the engine is idle', () => {
      expect(deriveStatusBar(view()).activity).toBeNull();
    });

    it('reports the activity alongside an alert — neither suppresses the other', () => {
      const m = deriveStatusBar(
        view({
          refs: { pr: 57 },
          loopActivity: loopActivity('consolidate'),
          loop: loop({ status: 'awaiting-human-pr-approval', humanNeeded: true }),
        }),
      );
      expect(m.title).toEqual({ kind: 'pr', number: 57 });
      expect(m.activity).toEqual({ phrase: 'Consolidating reviews' });
      expect(m.alert).not.toBeNull();
    });
  });
});
