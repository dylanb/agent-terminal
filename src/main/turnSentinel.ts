// §26.3/D47a — scans the live PTY byte stream for a turn's done-signal LINE. The PTY delivers the line
// split across chunks and wrapped in ANSI control sequences (§8.2), so the scanner accumulates a bounded
// raw tail, strips ANSI before searching, and fires once per armed sentinel. The done-signal FILE is the
// other half of the contract (watched in main); this is the line half.

// CSI (`ESC[…`), OSC (`ESC]…BEL`/`ESC]…ST`), and lone two-char ESC sequences. An incomplete trailing
// sequence is left in the raw buffer (it does not match) and completes when the next chunk arrives.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

// Bound the retained tail: large enough to span any sentinel + adjacent escape noise across a chunk
// boundary, small enough that a long-running stream never grows unbounded.
const MAX_TAIL = 8192;

export interface SentinelWatcher {
  /** Begin matching `sentinel`; resets any prior buffered output so a stale tail cannot pre-fire. */
  arm(sentinel: string): void;
  /** Stop matching; `feed` becomes a no-op until the next `arm`. */
  disarm(): void;
  /** Feed a raw PTY output chunk. While armed and not yet matched, fires `onMatch(sentinel)` once. */
  feed(data: string): void;
}

export function createSentinelWatcher(onMatch: (sentinel: string) => void): SentinelWatcher {
  let target: string | null = null;
  let raw = '';
  return {
    arm(sentinel) {
      target = sentinel;
      raw = '';
    },
    disarm() {
      target = null;
      raw = '';
    },
    feed(data) {
      if (target === null) return;
      raw = (raw + data).slice(-MAX_TAIL);
      // Match only a COMPLETE line (terminated by a newline) whose trimmed content IS the sentinel —
      // never a mid-line occurrence. This is what makes detection echo-safe: the orchestrator's own
      // injected prompt carries the sentinel inside its "print this line: <sentinel>" instruction, and
      // the PTY echoes that injection; matching it as a substring would falsely fire on the echo. The
      // agent emits the sentinel ALONE on its own line, so the line-equality test distinguishes them.
      const lines = raw.replace(ANSI, '').split(/\r\n|\r|\n/);
      for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i].trim() === target) {
          const matched = target;
          target = null;
          raw = '';
          onMatch(matched);
          return;
        }
      }
    },
  };
}
