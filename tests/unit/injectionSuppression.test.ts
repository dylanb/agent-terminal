import { describe, expect, it } from 'vitest';
import { createInjectionSuppressor, SELF_INJECT_WINDOW_MS } from '../../src/main/injectionSuppression';
import type { ShadowMarker } from '../../src/main/shadow';

// A stand-in for a real @xterm marker (§15.2): mutable `line`, goes -1 on trim.
// NOT an emulator mock — the suppressor's contract is purely (row, time) bookkeeping.
interface FakeMarker {
  line: number;
  disposed: boolean;
  dispose(): void;
}
function fakeMarker(line: number): FakeMarker {
  return {
    line,
    disposed: false,
    dispose() {
      this.disposed = true;
    },
  };
}

describe('createInjectionSuppressor (§16.5 — watermark + time window)', () => {
  function setup(opts?: { cursorRow?: number; now?: () => number; windowMs?: number }) {
    let row = opts?.cursorRow ?? 0;
    const markers: FakeMarker[] = [];
    const suppressor = createInjectionSuppressor({
      cursorRow: () => row,
      addMarker: (absRow) => {
        const m = fakeMarker(absRow);
        markers.push(m);
        return m as unknown as ShadowMarker;
      },
      now: opts?.now,
      windowMs: opts?.windowMs,
    });
    return { suppressor, markers, setRow: (r: number) => (row = r) };
  }

  it('suppresses a region that contains a live watermark within the window', () => {
    const { suppressor } = setup({ cursorRow: 5, now: () => 1000 });
    suppressor.noteInjection();
    expect(suppressor.isSuppressed({ startRow: 5, endRow: 5 })).toBe(true);
    // A multi-row region that straddles the watermark is the echoed input too.
    expect(suppressor.isSuppressed({ startRow: 3, endRow: 7 })).toBe(true);
  });

  it('does not suppress a region below the watermark (the agent reply)', () => {
    const { suppressor } = setup({ cursorRow: 5, now: () => 1000 });
    suppressor.noteInjection();
    expect(suppressor.isSuppressed({ startRow: 6, endRow: 9 })).toBe(false);
  });

  it('suppresses nothing when no injection has been noted', () => {
    const { suppressor } = setup({ cursorRow: 5 });
    expect(suppressor.isSuppressed({ startRow: 5, endRow: 5 })).toBe(false);
  });

  it('stops suppressing once the time window has elapsed', () => {
    let t = 1000;
    const { suppressor } = setup({ cursorRow: 5, now: () => t, windowMs: 4000 });
    suppressor.noteInjection();
    t = 1000 + 4001;
    expect(suppressor.isSuppressed({ startRow: 5, endRow: 5 })).toBe(false);
  });

  it('retires (disposes) a watermark whose row has trimmed out of scrollback', () => {
    const { suppressor, markers } = setup({ cursorRow: 5, now: () => 1000 });
    suppressor.noteInjection();
    markers[0].line = -1; // scrollback trimmed past the watermark
    expect(suppressor.isSuppressed({ startRow: 0, endRow: 100 })).toBe(false);
    expect(markers[0].disposed).toBe(true);
  });

  it('disposes all outstanding watermarks on dispose()', () => {
    const { suppressor, markers, setRow } = setup({ cursorRow: 5 });
    suppressor.noteInjection();
    setRow(8);
    suppressor.noteInjection();
    suppressor.dispose();
    expect(markers.map((m) => m.disposed)).toEqual([true, true]);
  });

  it('exposes a default window constant', () => {
    expect(SELF_INJECT_WINDOW_MS).toBeGreaterThan(0);
  });
});
