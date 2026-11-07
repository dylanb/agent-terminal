import { afterEach, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { readProcessTable } from '../../src/main/waitingLookup';
import { shellQuote } from '../../src/shared/shellQuote';
import { writeHangingExecutable, type HangingExecutable } from '../helpers/hangingExecutable';
import { PS_ARGS } from '../helpers/processTable';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

it('runs ps with the argv the process-table captures were taken with, and returns what it prints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'waiting-ps-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const argvFile = join(dir, 'argv');
  const table = '  4100  4099  4100  4123    02:00:00 zsh\n';
  const ps = join(dir, 'ps');
  writeFileSync(ps, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > ${shellQuote(argvFile)}\nprintf '%s' ${shellQuote(table)}\n`);
  chmodSync(ps, 0o755);
  const output = await readProcessTable({ signal: new AbortController().signal, ps }).catch(() => null);
  const argv = (() => { try { return readFileSync(argvFile, 'utf8').split('\n').filter(Boolean); } catch { return null; } })();
  expect({ output, argv }).toEqual({ output: table, argv: PS_ARGS });
});

it('never blocks the main process on a ps that never answers, settles once abandoned, and leaves no child process', async () => {
  const hanging: HangingExecutable = writeHangingExecutable('ps');
  cleanups.push(() => hanging.dispose());
  const abandon = new AbortController();
  let settled = false;
  const lookup = readProcessTable({ signal: abandon.signal, ps: hanging.path }).then(() => undefined, () => undefined).finally(() => { settled = true; });
  const ran = await Promise.race([hanging.started().then(() => true), lookup.then(() => false)]);
  let callbackRan = false;
  await nextTurn().then(() => { callbackRan = true; });
  const settledBeforeAbandon = settled;
  abandon.abort();
  await lookup;
  const childGone = ran ? await hanging.exited().then(() => true, () => false) : false;
  expect({ ran, callbackRan, settledBeforeAbandon, settled, childGone })
    .toEqual({ ran: true, callbackRan: true, settledBeforeAbandon: false, settled: true, childGone: true });
});
