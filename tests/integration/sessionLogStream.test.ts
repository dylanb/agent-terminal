import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { constants as bufferConstants } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogStream, type LogStream } from '../../src/main/sessionLogStream';
import type { LogFile } from '../../src/main/sessionLogFiles';

const CHUNK = 64 * 1024;

function seen(path: string): LogFile {
  return { path, size: statSync(path).size };
}

async function read(stream: LogStream, file: LogFile): Promise<string[]> {
  const out: string[] = [];
  for await (const line of stream.lines(file)) out.push(line);
  return out;
}

/** Event-loop iterations elapsed, counted by a self-rescheduling check-phase callback — ordering only,
 *  with no wall clock. */
function eventLoopTicker(): { ticks: () => number; stop: () => void } {
  let ticks = 0;
  let running = true;
  const pump = (): void => {
    if (!running) return;
    ticks += 1;
    setImmediate(pump);
  };
  setImmediate(pump);
  return { ticks: () => ticks, stop: () => void (running = false) };
}

describe('reading only what a session log gained', () => {
  let dir: string;
  let log: string;
  let stream: LogStream;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'log-stream-'));
    log = join(dir, 'session.jsonl');
    stream = createLogStream(CHUNK);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads every complete line of a log it has not seen before', async () => {
    writeFileSync(log, 'one\ntwo\n');
    expect(await read(stream, seen(log))).toEqual(['one', 'two']);
  });

  // The run's own logs are written during the run by definition, so a reader with no memory re-reads them
  // whole every couple of seconds for the life of the run, on the process that also drains the PTY.
  it('reads nothing the second time when the log did not change', async () => {
    writeFileSync(log, 'one\ntwo\n');
    expect(await read(stream, seen(log))).toEqual(['one', 'two']);
    expect(await read(stream, seen(log))).toEqual([]);
  });

  it('reads only the lines a log gained since it was last read', async () => {
    writeFileSync(log, 'one\n');
    expect(await read(stream, seen(log))).toEqual(['one']);
    appendFileSync(log, 'two\nthree\n');
    expect(await read(stream, seen(log))).toEqual(['two', 'three']);
  });

  // A JSONL writer appends a whole line at a time, so a trailing fragment is a write in progress. Handing
  // it on would price a truncated record and then price its completed form again.
  it('withholds a trailing line until its newline arrives, then reads it once', async () => {
    writeFileSync(log, 'one\npart');
    expect(await read(stream, seen(log))).toEqual(['one']);
    appendFileSync(log, 'ial\n');
    expect(await read(stream, seen(log))).toEqual(['partial']);
    expect(await read(stream, seen(log))).toEqual([]);
  });

  // A log truncated or replaced under the reader is not an append: the size goes backwards, so the memory
  // of it is worthless and the file is read from the top again.
  it('reads a log that was rewritten smaller from the top', async () => {
    writeFileSync(log, 'one\ntwo\n');
    expect(await read(stream, seen(log))).toEqual(['one', 'two']);
    writeFileSync(log, 'fresh\n');
    expect(await read(stream, seen(log))).toEqual(['fresh']);
  });

  // Read positions are the run's, not the process's: a flow that terminates and a different one that
  // starts must not inherit them, or the second run reports only what the first had not yet reached.
  it('reads every log from the top again once its positions are released', async () => {
    writeFileSync(log, 'one\ntwo\n');
    expect(await read(stream, seen(log))).toEqual(['one', 'two']);
    stream.forget();
    expect(await read(stream, seen(log))).toEqual(['one', 'two']);
  });

  it('reads a line split across a chunk boundary exactly once', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line-${i}`);
    writeFileSync(log, `${lines.join('\n')}\n`);
    expect(await read(createLogStream(7), seen(log))).toEqual(lines);
  });

  // A chunk boundary is a BYTE boundary, so it can fall inside a multi-byte character. Decoding each chunk
  // as a self-contained document replaces both halves with U+FFFD before the carry can rejoin the line.
  it('reads a line carrying a multi-byte character across the chunk boundary', async () => {
    const line = 'a-§-b';
    writeFileSync(log, `${line}\n`);
    const boundary = Buffer.from('a-', 'utf8').length + 1;
    expect(await read(createLogStream(boundary), seen(log))).toEqual([line]);
  });

  // A log line has no length limit in the format, and the reader holds an incomplete line across chunk
  // boundaries — so the chunk size bounds the READ but not the allocation, and one newline-free log is
  // materialised whole on the process that also drains the PTY.
  it.each([64 * 1024, 4_000_000])('drops a line longer than the cap and keeps reading past it (chunk %d)', async (chunkBytes) => {
    writeFileSync(log, `${'x'.repeat(2_000_000)}\nafter\n`);
    expect(await read(createLogStream(chunkBytes), seen(log))).toEqual(['after']);
  });

  it('reads nothing and completes when a log holds one over-long line and nothing else', async () => {
    writeFileSync(log, `${'x'.repeat(2_000_000)}\n`);
    expect(await read(stream, seen(log))).toEqual([]);
  });

  // A transient EACCES/EMFILE that was remembered as a read would strand that log for the rest of the run —
  // and the logs this strands are exactly the ones AC 1 is about: a reviewer subagent's log is closed the
  // moment it exits.
  it.skipIf(process.getuid?.() === 0)('reads a log it could not open on the next pass instead of skipping it', async () => {
    writeFileSync(log, 'one\n');
    const file = seen(log);
    chmodSync(log, 0o000);
    try {
      expect(await read(stream, file)).toEqual([]);
    } finally {
      chmodSync(log, 0o644);
    }
    expect(await read(stream, seen(log))).toEqual(['one']);
  });

  // The other arm: the open succeeds and the READ fails. A symlink to a directory opens and then fails at
  // the first read — the same shape as an EIO, or an fd the OS pulls out from under a mid-flight read.
  it('leaves a log whose read failed outright for the next pass', async () => {
    const target = join(dir, 'a-directory');
    const link = join(dir, 'unreadable.jsonl');
    mkdirSync(target);
    symlinkSync(target, link);
    expect(await read(stream, { path: link, size: null })).toEqual([]);

    rmSync(link);
    writeFileSync(link, 'recovered\n');
    expect(await read(stream, seen(link))).toEqual(['recovered']);
  });

  // A read that failed PART WAY is the subtler half: the lines already handed on must not be handed on
  // again, and the remainder must not be stranded.
  it('resumes a partly-read log after its newline, handing on neither less nor more', async () => {
    writeFileSync(log, 'one\ntwo\n');
    const iter = stream.lines(seen(log))[Symbol.asyncIterator]();
    expect((await iter.next()).value).toBe('one');
    await iter.return?.(undefined);

    appendFileSync(log, 'three\n');
    expect(await read(stream, seen(log))).toEqual(['two', 'three']);
  });

  // AC 7 — "delays" is bound by ordering. The current session's own log is written during the run by
  // definition and is the largest single file, so no window filter can exclude it: a reader that yields
  // between logs but still reads each one whole freezes the counter across a single log's turns.
  it('relinquishes the event loop WITHIN one log, more the smaller the chunk', async () => {
    writeFileSync(log, `${Array.from({ length: 400 }, (_, i) => `line-${i}`).join('\n')}\n`);
    const ticksFor = async (chunkBytes: number): Promise<number> => {
      const ticker = eventLoopTicker();
      const baseline = ticker.ticks();
      await read(createLogStream(chunkBytes), seen(log));
      const elapsed = ticker.ticks() - baseline;
      ticker.stop();
      return elapsed;
    };
    const chunked = await ticksFor(64);
    const whole = await ticksFor(4_000_000);
    expect(chunked).toBeGreaterThan(whole);
    expect(chunked).toBeGreaterThan(20);
  });

  // The caller breaks out of a read on every retirement or floor change mid-drain, so the log being read
  // is abandoned at a `yield`. Without an explicit return the generator stays suspended and its FileHandle
  // survives until GC (CWE-772).
  it('closes the log it was reading when the caller abandons the read', async () => {
    writeFileSync(log, `${Array.from({ length: 8 }, (_, i) => `line-${i}`).join('\n')}\n`);
    const openFds = (): number => readdirSync('/dev/fd').length;
    const abandon = async (): Promise<void> => {
      const s = createLogStream(8);
      const iter = s.lines(seen(log))[Symbol.asyncIterator]();
      await iter.next();
      await iter.return?.(undefined);
    };
    await abandon();
    const baseline = openFds();
    for (let i = 0; i < 40; i += 1) await abandon();
    expect(openFds()).toBeLessThanOrEqual(baseline);
  });

  // A chunk size the process cannot allocate is none of the drifts this module degrades on. Swallowed
  // alongside them it reads every log as empty, and the run's §25 record gains a confident $0.00.
  it('surfaces a chunk size it cannot allocate rather than reading every log as empty', async () => {
    writeFileSync(log, 'one\n');
    await expect(read(createLogStream(bufferConstants.MAX_LENGTH + 1), seen(log))).rejects.toThrow();
  });
});
