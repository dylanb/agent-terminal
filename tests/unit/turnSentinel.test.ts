import { describe, expect, it, vi } from 'vitest';
import { createSentinelWatcher } from '../../src/main/turnSentinel';
import { turnDoneSentinel } from '../../src/shared/loopTurn';

// §26.3/D47a — the orchestrator detects a turn's done-signal by watching the live PTY byte stream for
// the sentinel LINE. The scanner must survive the realities of a PTY: the line arrives split across
// chunks and surrounded by ANSI control sequences (§8.2). Behavior asserted from the outside: when
// (and only when) the armed sentinel has been seen, onMatch fires exactly once.
describe('turn done-signal line scanner (§26.3/D47a)', () => {
  const S = turnDoneSentinel('work-plan');

  it('fires once when the armed sentinel arrives in a single chunk', () => {
    const onMatch = vi.fn();
    const w = createSentinelWatcher(onMatch);
    w.arm(S);
    w.feed(`some agent output\r\n${S}\r\n`);
    expect(onMatch).toHaveBeenCalledTimes(1);
  });

  it('does not fire until the full sentinel line has been seen across chunks', () => {
    const onMatch = vi.fn();
    const w = createSentinelWatcher(onMatch);
    w.arm(S);
    w.feed(S.slice(0, 10));
    expect(onMatch).not.toHaveBeenCalled();
    w.feed(`${S.slice(10)}\r\n`); // completes the line across the chunk boundary
    expect(onMatch).toHaveBeenCalledTimes(1);
  });

  it('does NOT match the sentinel when it appears mid-line (echo-safety, §26.3/D47a)', () => {
    // The orchestrator's injected prompt contains "print this line: <sentinel>" and the PTY echoes it;
    // a substring match would falsely fire on that echo. Only the sentinel ALONE on a line is a signal.
    const onMatch = vi.fn();
    const w = createSentinelWatcher(onMatch);
    w.arm(S);
    w.feed(`Print this exact line on its own: ${S}\r\n`);
    expect(onMatch).not.toHaveBeenCalled();
    w.feed(`${S}\r\n`); // the agent's real emission: alone on its own line
    expect(onMatch).toHaveBeenCalledTimes(1);
  });

  it('does not fire on an unterminated sentinel line (a partial final line is not a signal)', () => {
    const onMatch = vi.fn();
    const w = createSentinelWatcher(onMatch);
    w.arm(S);
    w.feed(S); // no trailing newline yet — could still be growing
    expect(onMatch).not.toHaveBeenCalled();
  });

  it('matches through interleaved ANSI control sequences around the line', () => {
    const onMatch = vi.fn();
    const w = createSentinelWatcher(onMatch);
    w.arm(S);
    // color codes + cursor moves adjacent to the sentinel, split mid-escape across the boundary
    w.feed(`\x1b[32m\x1b[2K${S.slice(0, 6)}`);
    w.feed(`${S.slice(6)}\x1b[0m\r\n`);
    expect(onMatch).toHaveBeenCalledTimes(1);
  });

  it('fires only once even if the sentinel recurs', () => {
    const onMatch = vi.fn();
    const w = createSentinelWatcher(onMatch);
    w.arm(S);
    w.feed(`${S}\r\n${S}\r\n`);
    expect(onMatch).toHaveBeenCalledTimes(1);
  });

  it('ignores output while disarmed, and re-arms cleanly for the next turn', () => {
    const onMatch = vi.fn();
    const w = createSentinelWatcher(onMatch);
    w.feed(`${S}\r\n`); // never armed
    expect(onMatch).not.toHaveBeenCalled();
    w.arm(S);
    w.feed(`${S}\r\n`);
    expect(onMatch).toHaveBeenCalledTimes(1);
    // a second turn arms a different key; prior buffer must not re-fire the new target
    const S2 = turnDoneSentinel('work-impl');
    w.arm(S2);
    w.feed('nothing here\r\n');
    expect(onMatch).toHaveBeenCalledTimes(1);
    w.feed(`${S2}\r\n`);
    expect(onMatch).toHaveBeenCalledTimes(2);
  });

  it('does not match the armed sentinel after disarm', () => {
    const onMatch = vi.fn();
    const w = createSentinelWatcher(onMatch);
    w.arm(S);
    w.disarm();
    w.feed(`${S}\r\n`);
    expect(onMatch).not.toHaveBeenCalled();
  });
});
