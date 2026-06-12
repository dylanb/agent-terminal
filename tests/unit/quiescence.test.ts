import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQuiescenceDetector } from '../../src/main/quiescence';
import type { AgentState } from '../../src/shared/ipc';

describe('quiescence detector (§8.3)', () => {
  let transitions: Array<{ state: AgentState; quietSince: number | null }>;
  let detector: ReturnType<typeof createQuiescenceDetector>;
  let nowMs: number;

  beforeEach(() => {
    vi.useFakeTimers();
    nowMs = 100_000;
    transitions = [];
    detector = createQuiescenceDetector({
      quietMs: 1000,
      now: () => nowMs,
      onTransition: (state, quietSince) => transitions.push({ state, quietSince }),
    });
  });

  afterEach(() => {
    detector.dispose();
    vi.useRealTimers();
  });

  it('starts quiet', () => {
    expect(detector.state).toBe('quiet');
    expect(detector.quietSince).toBeNull();
  });

  it('flips to active immediately on output, with quietSince cleared', () => {
    detector.noteOutputActivity();
    expect(detector.state).toBe('active');
    expect(detector.quietSince).toBeNull();
    expect(transitions).toEqual([{ state: 'active', quietSince: null }]);
  });

  it('does not re-announce active while output keeps flowing', () => {
    detector.noteOutputActivity();
    vi.advanceTimersByTime(500);
    detector.noteOutputActivity();
    vi.advanceTimersByTime(500);
    detector.noteOutputActivity();
    expect(transitions).toHaveLength(1);
    expect(detector.state).toBe('active');
  });

  it('flips to quiet after quietMs without output, stamping quietSince', () => {
    detector.noteOutputActivity();
    nowMs = 105_000;
    vi.advanceTimersByTime(1000);
    expect(detector.state).toBe('quiet');
    expect(detector.quietSince).toBe(105_000);
    expect(transitions).toEqual([
      { state: 'active', quietSince: null },
      { state: 'quiet', quietSince: 105_000 },
    ]);
  });

  it('continued output postpones the quiet transition', () => {
    detector.noteOutputActivity();
    vi.advanceTimersByTime(900);
    detector.noteOutputActivity();
    vi.advanceTimersByTime(900);
    expect(detector.state).toBe('active');
    vi.advanceTimersByTime(100);
    expect(detector.state).toBe('quiet');
  });

  it('cycles active → quiet → active across bursts', () => {
    detector.noteOutputActivity();
    vi.advanceTimersByTime(1000);
    detector.noteOutputActivity();
    expect(transitions.map((t) => t.state)).toEqual(['active', 'quiet', 'active']);
    expect(detector.quietSince).toBeNull();
  });

  it('dispose cancels the pending quiet timer', () => {
    detector.noteOutputActivity();
    detector.dispose();
    vi.advanceTimersByTime(5000);
    expect(transitions.map((t) => t.state)).toEqual(['active']);
  });
});
