import { describe, expect, it } from 'vitest';
import {
  deriveLoopActivity,
  loopActivity,
  loopActivityPhrase,
  type LoopActivityKind,
} from '../../src/shared/loopActivity';

// §24.2.2 / §27.10 — the human-readable "what the loop mechanics are doing now" phrase. One shared
// definition so the main-process bootstrap producer and the renderer/tests never drift on the vocabulary
// (CLAUDE.md shared-semantics rule). Asserted purely on the produced phrase.
describe('loopActivityPhrase (§27.10 loop-activity vocabulary)', () => {
  it('names the bootstrap phase with the issue number', () => {
    expect(loopActivityPhrase('pickup', { issue: 40 })).toBe('Bootstrapping #40');
  });

  it('names a wipe re-bootstrap distinctly', () => {
    expect(loopActivityPhrase('pickup', { issue: 40, wipe: true })).toBe('Retrying bootstrap');
  });

  it('falls back to a bare bootstrap phrase with no issue', () => {
    expect(loopActivityPhrase('pickup')).toBe('Bootstrapping');
  });
});

describe('loopActivity (§27.10 descriptor for the strip)', () => {
  it('wraps the phrase (presence alone means the loop is busy — the spinner spins)', () => {
    expect(loopActivity('pickup')).toEqual({ phrase: 'Bootstrapping' });
  });

  it('threads the pickup context into the phrase', () => {
    expect(loopActivity('pickup', { issue: 7 })).toEqual({ phrase: 'Bootstrapping #7' });
  });

  it('covers every kind (no phrase is empty)', () => {
    const kinds: LoopActivityKind[] = ['pickup'];
    for (const k of kinds) expect(loopActivity(k).phrase.length).toBeGreaterThan(0);
  });
});

describe('deriveLoopActivity (§27.10 — live state → descriptor)', () => {
  it('reports the pickup while a bootstrap is in flight', () => {
    expect(deriveLoopActivity({ pickup: { issue: 40, wipe: false } })).toEqual({
      phrase: 'Bootstrapping #40',
    });
  });

  it('is null when nothing is happening (no spinner, no phrase)', () => {
    expect(deriveLoopActivity({ pickup: null })).toBeNull();
  });
});
