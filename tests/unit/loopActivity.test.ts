import { describe, expect, it } from 'vitest';
import {
  deriveLoopActivity,
  loopActivity,
  loopActivityPhrase,
  type LoopActivityKind,
} from '../../src/shared/loopActivity';

// §24.2.2 / §26 — the human-readable "what the loop mechanics are doing now" phrase. One shared
// definition so the main-process producer and the renderer/tests never drift on the vocabulary
// (CLAUDE.md shared-semantics rule). Asserted purely on the produced phrase + busy flag.
describe('loopActivityPhrase (§26 loop-activity vocabulary)', () => {
  it('names the bootstrap phase with the issue number', () => {
    expect(loopActivityPhrase('pickup', { issue: 40 })).toBe('Bootstrapping #40');
  });

  it('names a wipe re-bootstrap distinctly', () => {
    expect(loopActivityPhrase('pickup', { issue: 40, wipe: true })).toBe('Retrying bootstrap');
  });

  it('falls back to a bare bootstrap phrase with no issue', () => {
    expect(loopActivityPhrase('pickup')).toBe('Bootstrapping');
  });

  it('names the deferred-injection wait', () => {
    expect(loopActivityPhrase('waiting')).toBe('Waiting for the agent');
  });

  it('names each turn phase', () => {
    expect(loopActivityPhrase('work')).toBe('Working');
    expect(loopActivityPhrase('reviewers')).toBe('Running reviewers');
    expect(loopActivityPhrase('consolidate')).toBe('Consolidating reviews');
  });
});

describe('loopActivity (§26 descriptor for the strip)', () => {
  it('wraps the phrase and marks it busy (the spinner spins)', () => {
    expect(loopActivity('work')).toEqual({ phrase: 'Working', busy: true });
  });

  it('threads the pickup context into the phrase', () => {
    expect(loopActivity('pickup', { issue: 7 })).toEqual({ phrase: 'Bootstrapping #7', busy: true });
  });

  it('covers every kind (no phrase is empty)', () => {
    const kinds: LoopActivityKind[] = ['pickup', 'waiting', 'work', 'reviewers', 'consolidate'];
    for (const k of kinds) expect(loopActivity(k).phrase.length).toBeGreaterThan(0);
  });
});

describe('deriveLoopActivity (§26 — live state → descriptor)', () => {
  it('reports the pickup while a bootstrap is in flight', () => {
    expect(deriveLoopActivity({ pickup: { issue: 40, wipe: false }, turn: null })).toEqual({
      phrase: 'Bootstrapping #40',
      busy: true,
    });
  });

  it('prefers the pickup over a turn when both are set (bootstrap precedes any turn)', () => {
    const a = deriveLoopActivity({ pickup: { issue: 1, wipe: false }, turn: { kind: 'work', injected: true } });
    expect(a?.phrase).toBe('Bootstrapping #1');
  });

  it('reports the turn phase once its prompt has been injected', () => {
    expect(deriveLoopActivity({ pickup: null, turn: { kind: 'consolidate', injected: true } })).toEqual({
      phrase: 'Consolidating reviews',
      busy: true,
    });
  });

  it('reports "waiting for the agent" while a turn is deferred (prompt not yet injected)', () => {
    expect(deriveLoopActivity({ pickup: null, turn: { kind: 'reviewers', injected: false } })).toEqual({
      phrase: 'Waiting for the agent',
      busy: true,
    });
  });

  it('is null when nothing is happening (no spinner, no phrase)', () => {
    expect(deriveLoopActivity({ pickup: null, turn: null })).toBeNull();
  });
});
