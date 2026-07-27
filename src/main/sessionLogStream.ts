// §27.11

import { promises as fsp } from 'node:fs';
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
  /** Every complete line `file` gained since this stream last read it. A log smaller than the position
   *  left behind was rewritten and is read from the top; a trailing fragment is a write in progress and is
   *  withheld until its newline arrives. The position advances only past a line already handed on, so a
   *  read that fails part way hands the rest to the next pass rather than stranding it. */
  lines(file: LogFile): AsyncGenerator<string>;
  /** Forget where every log was read to. */
  forget(): void;
}

/** Hold one read position per session log, so the run's own logs — the ones no window filter can exclude,
 *  because they are written during the run by definition — are consumed once rather than re-read whole on
 *  every sample (§27.11 / AC 7). Relinquishes the event loop between chunks, so no single read of a log is
 *  an uninterruptible block on the main thread. */
export function createLogStream(chunkBytes: number): LogStream {
  const positions = new Map<string, number>();
  // Two reads of one stream can be live at once (two cost samples for one repo overlap), and each holds an
  // incomplete line across chunk boundaries — so a read never shares its scratch space with another.
  let spare: Buffer | null = null;
  const take = (): Buffer => {
    const buffer = spare ?? Buffer.allocUnsafe(chunkBytes);
    spare = null;
    return buffer;
  };

  return {
    async *lines(file: LogFile): AsyncGenerator<string> {
      const remembered = positions.get(file.path) ?? 0;
      const from = file.size !== null && file.size < remembered ? 0 : remembered;
      if (file.size !== null && file.size === from) return;
      const read = take();

      let handle: fsp.FileHandle;
      try {
        handle = await fsp.open(file.path, 'r');
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
          // A chunk boundary is a BYTE boundary, so the decoder holds an incomplete trailing character
          // across it and `carry` an incomplete trailing line; a held-back character is never a newline,
          // so each split element past the carry has exactly one newline offset in this chunk.
          const newlines = newlineOffsets(chunk);
          const parts = (carry + decoder.write(chunk)).split('\n');
          carry = parts.pop() ?? '';
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
        positions.set(file.path, consumed);
        spare = read;
        await handle.close().catch(() => {});
      }
    },

    forget(): void {
      positions.clear();
    },
  };
}
