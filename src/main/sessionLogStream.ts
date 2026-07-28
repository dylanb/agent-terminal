// §27.11

import { constants as fsConstants, promises as fsp } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { LogFile } from './sessionLogFiles';

/** Longest line the stream will hold or hand on. `chunkBytes` bounds the read, not the string a
 *  newline-free log would otherwise accumulate. Well above the longest line the format produces. */
const MAX_LINE_CHARS = 1_000_000;

const NEWLINE = 0x0a;

function newlineOffsets(chunk: Buffer): number[] {
  const out: number[] = [];
  for (let i = chunk.indexOf(NEWLINE); i >= 0; i = chunk.indexOf(NEWLINE, i + 1)) out.push(i);
  return out;
}

export interface LogStream {
  /** Every complete line `file` gained since this stream last read it that is no longer than
   *  `MAX_LINE_CHARS`. A log smaller than the position left behind was rewritten and is read from the top;
   *  a trailing fragment is a write in progress and is withheld until its newline arrives. A read that
   *  fails part way hands what it had not reached to the next pass rather than stranding it. */
  lines(file: LogFile): AsyncGenerator<string>;
  /** Forget where every log was read to. */
  forget(): void;
}

/** Hold one read position per session log, so the run's own logs — the ones no window filter can exclude,
 *  because they are written during the run by definition — are consumed once rather than re-read whole on
 *  every sample (§27.11 / AC 7). Relinquishes the event loop between chunks, so no single read of a log is
 *  an uninterruptible block on the main thread. `lines()` is re-entrant: two of its generators may be
 *  interleaved without one splicing into the other. */
export function createLogStream(chunkBytes: number): LogStream {
  const positions = new Map<string, number>();
  let epoch = 0;
  let spare: Buffer | null = null;
  const take = (): Buffer => {
    const buffer = spare ?? Buffer.allocUnsafe(chunkBytes);
    spare = null;
    return buffer;
  };

  return {
    async *lines(file: LogFile): AsyncGenerator<string> {
      const mine = epoch;
      const remembered = positions.get(file.path) ?? 0;
      const from = file.size !== null && file.size < remembered ? 0 : remembered;
      if (file.size !== null && file.size === from) return;
      const read = take();

      let handle: fsp.FileHandle;
      try {
        handle = await fsp.open(file.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      } catch {
        spare = read;
        return;
      }
      const decoder = new StringDecoder('utf8');
      let carry = '';
      let dropping = false;
      let cursor = from;
      let consumed = from;
      try {
        for (;;) {
          const { bytesRead } = await handle.read(read, 0, read.length, cursor);
          if (bytesRead === 0) break;
          const chunk = read.subarray(0, bytesRead);
          const newlines = newlineOffsets(chunk);
          const parts = (carry + decoder.write(chunk)).split('\n');
          carry = parts.pop() ?? '';
          if (parts.length !== newlines.length) throw new Error('log stream: newline scan and decode disagree');
          for (let i = 0; i < parts.length; i += 1) {
            consumed = cursor + newlines[i] + 1;
            if (dropping) dropping = false;
            else if (parts[i].length <= MAX_LINE_CHARS) yield parts[i];
          }
          cursor += bytesRead;
          if (carry.length > MAX_LINE_CHARS) {
            carry = '';
            dropping = true;
          }
        }
      } catch {
        return;
      } finally {
        if (epoch === mine) positions.set(file.path, consumed);
        spare = read;
        await handle.close().catch(() => {});
      }
    },

    forget(): void {
      epoch += 1;
      positions.clear();
    },
  };
}
