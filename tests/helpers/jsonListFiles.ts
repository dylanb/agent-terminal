import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MAX_LOOP_ARTIFACT_BYTES } from '../../src/main/appLoopPaths';
import type { createFedPipes } from './fedPipe';
import { distinctTitles, jsonListText } from './jsonListCases';

export const WELL_FORMED_LIST = jsonListText(distinctTitles(3));
export const WELL_FORMED_ENTRIES = 3;

type FedPipes = ReturnType<typeof createFedPipes>;

/** A list file whose verdict comes from how it is laid on disk rather than from its text: it reads as
 *  `WELL_FORMED_LIST`, or the read refuses it for `reads`. */
export interface ListFileCase {
  name: string;
  reads: 'well-formed' | 'absent' | 'over-cap' | 'unreadable';
  lay(file: string, pipes: FedPipes): void;
}

const runningAsRoot = process.getuid?.() === 0;

export const LIST_FILE_CASES: readonly ListFileCase[] = [
  {
    name: 'a well-formed file after a UTF-8 byte-order mark',
    reads: 'well-formed',
    lay: (file) => writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(WELL_FORMED_LIST)])),
  },
  {
    name: 'a symlink to a well-formed file',
    reads: 'well-formed',
    lay: (file) => {
      const target = join(dirname(file), 'link-target.json');
      writeFileSync(target, WELL_FORMED_LIST);
      symlinkSync(target, file);
    },
  },
  { name: 'an absent file', reads: 'absent', lay: () => {} },
  {
    name: 'a file over the 16 MiB read bound',
    reads: 'over-cap',
    lay: (file) => writeFileSync(file, `${WELL_FORMED_LIST.slice(0, -1)}, "pad": "${'x'.repeat(MAX_LOOP_ARTIFACT_BYTES)}"}`),
  },
  { name: 'a directory', reads: 'unreadable', lay: (file) => mkdirSync(file) },
  {
    name: 'a file that is not valid UTF-8',
    reads: 'unreadable',
    lay: (file) => writeFileSync(file, Buffer.concat([Buffer.from('{"steps": [{"title": "'), Buffer.from([0xc3, 0x28]), Buffer.from('"}]}')])),
  },
  { name: 'a named pipe fed a well-formed list', reads: 'unreadable', lay: (file, pipes) => pipes.at(file, WELL_FORMED_LIST) },
  ...(runningAsRoot
    ? []
    : [{
      name: 'a file its reader may not read (mode 000)',
      reads: 'unreadable' as const,
      lay: (file: string) => {
        writeFileSync(file, WELL_FORMED_LIST);
        chmodSync(file, 0o000);
      },
    }]),
];
