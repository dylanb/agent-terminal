// `--check-repeat-list <file> <list>`'s check, called directly: the line it prints and the status it returns for a
// well-formed file, for each way a file can be bad, for a wrong operand count, and for operands taken verbatim.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_LOOP_ARTIFACT_BYTES } from '../../src/main/appLoopPaths';
import { runCheckRepeatList } from '../../src/main/checkRepeatList';
import { createFedPipes } from '../helpers/fedPipe';
import { JSON_LIST_CASES, distinctTitles, jsonListText, type JsonListCase } from '../helpers/jsonListCases';
import { passOutcome, problemOutcome, runText, type RunResult } from '../helpers/validateOutcome';

const PASSED = { status: 0, oneLine: true, okLine: true, output: expect.any(String) };
const PROBLEM = { status: 1, oneLine: true, prefixed: true, problem: expect.any(String), output: expect.any(String) };
const USAGE = { status: 2, stdout: '', stderrWritten: true, output: expect.any(String) };

let root: string;
let pipes: ReturnType<typeof createFedPipes>;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'check-repeat-list-')));
  pipes = createFedPipes();
});
afterEach(async () => {
  await pipes.reap();
  rmSync(root, { recursive: true, force: true });
});

const dir = (name: string): string => {
  const abs = join(root, name);
  mkdirSync(abs, { recursive: true });
  return abs;
};
const fileWith = (name: string, content: string | Buffer, under = root): string => {
  const file = join(under, name);
  writeFileSync(file, content);
  return file;
};

function check(operands: readonly string[], cwd = root): RunResult {
  const { exitCode, stdout, stderr } = runCheckRepeatList(operands, { cwd: () => cwd });
  return { status: exitCode, signal: null, stdout, stderr };
}

/** A pass, and whether its line names `file`. */
const passNaming = (result: RunResult, file: string) => ({ ...passOutcome(result), names: result.stdout.includes(file) });
const PASSED_NAMING = { ...PASSED, names: true };

const usageOutcome = (result: RunResult) => ({ status: result.status, stdout: result.stdout, stderrWritten: result.stderr.trim() !== '', output: runText(result) });

const WELL_FORMED = jsonListText(distinctTitles(3));
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const overBound = (): string => `${WELL_FORMED.slice(0, -1)}, "pad": "${'x'.repeat(MAX_LOOP_ARTIFACT_BYTES)}"}`;
const runningAsRoot = process.getuid?.() === 0;

/** A bad file the read refuses: its name, the read's cause, and how to lay it at `file`. */
interface ReadCase {
  name: string;
  cause: 'absent' | 'over-cap' | 'unreadable';
  lay: (file: string) => void;
}

const READ_CASES: readonly ReadCase[] = [
  { name: 'an absent file', cause: 'absent', lay: () => {} },
  { name: 'a file over the 16 MiB read bound', cause: 'over-cap', lay: (file) => writeFileSync(file, overBound()) },
  { name: 'a directory', cause: 'unreadable', lay: (file) => mkdirSync(file) },
  {
    name: 'a symlink to a well-formed file',
    cause: 'unreadable',
    lay: (file) => symlinkSync(fileWith('link-target.json', WELL_FORMED), file),
  },
  {
    name: 'a file that is not valid UTF-8',
    cause: 'unreadable',
    lay: (file) => writeFileSync(file, Buffer.concat([Buffer.from('{"steps": [{"title": "'), Buffer.from([0xc3, 0x28]), Buffer.from('"}]}')])),
  },
  { name: 'a named pipe fed a well-formed list', cause: 'unreadable', lay: (file) => pipes.at(file, WELL_FORMED) },
  ...(runningAsRoot
    ? []
    : [{
      name: 'a file its reader may not read (mode 000)',
      cause: 'unreadable' as const,
      lay: (file: string) => {
        writeFileSync(file, WELL_FORMED);
        chmodSync(file, 0o000);
      },
    }]),
];

const wellFormedCases = JSON_LIST_CASES.filter((c) => c.expected.wellFormed);
const brokenCases = JSON_LIST_CASES.filter((c) => !c.expected.wellFormed);

/** A broken case's rule and the entry position it is reported with, if any. */
function ruleOf(c: JsonListCase): { rule: string; position?: number } {
  if (c.expected.wellFormed) throw new Error(`ruleOf(): ${c.name} is well-formed`);
  return { rule: c.expected.rule, position: c.expected.position };
}

describe('A well-formed file passes', () => {
  it.each(wellFormedCases.map((c) => [c.name, c] as const))('a file with %s prints one OK line naming its absolute path and exits 0', (_name, c) => {
    const file = fileWith('list.json', c.text);
    expect(passNaming(check([file, c.list]), file)).toEqual(PASSED_NAMING);
  });

  it('a file that starts with a UTF-8 byte-order mark is judged on the rest', () => {
    const file = fileWith('bom.json', Buffer.concat([BOM, Buffer.from(WELL_FORMED)]));
    expect(passNaming(check([file, 'steps']), file)).toEqual(PASSED_NAMING);
  });
});

describe('A bad file fails with one line', () => {
  it.each(READ_CASES.map((c) => [c.name, c] as const))('%s prints one line, its absolute path then the problem, and exits 1', (_name, c) => {
    const file = join(root, 'list.json');
    c.lay(file);
    expect(problemOutcome(check([file, 'steps']), file)).toEqual(PROBLEM);
  });

  it.each(brokenCases.map((c) => [c.name, c] as const))('a file with %s prints one line, its absolute path then the problem, and exits 1', (_name, c) => {
    const file = fileWith('list.json', c.text);
    expect(problemOutcome(check([file, c.list]), file)).toEqual(PROBLEM);
  });

  /** The problem each bad file is reported with, beside what it is reported for: the predicate's first broken
   *  rule and its position, or the read's cause. */
  function problems(): { name: string; reportedFor: string; list: string; byRule: boolean; problem: string }[] {
    const fromRead = READ_CASES.map((c, i) => {
      const file = join(dir(`read-${i}`), 'list.json');
      c.lay(file);
      return { name: c.name, reportedFor: c.cause, list: 'steps', byRule: false, problem: problemOutcome(check([file, 'steps']), file).problem };
    });
    const fromRule = brokenCases.map((c, i) => {
      const file = fileWith('list.json', c.text, dir(`rule-${i}`));
      const { rule, position } = ruleOf(c);
      return { name: c.name, reportedFor: `${rule} at ${String(position)}`, list: c.list, byRule: true, problem: problemOutcome(check([file, c.list]), file).problem };
    });
    return [...fromRead, ...fromRule];
  }

  it('the problem names the first rule the file breaks: files that break different rules read differently, and files that break the same rule first, under the same list key, read alike', () => {
    const rows = problems();
    const pairs = rows.flatMap((a, i) => rows.slice(i + 1).map((b) => [a, b] as const));
    const confused = pairs.filter(([a, b]) => a.reportedFor !== b.reportedFor && a.problem === b.problem).map(([a, b]) => `${a.name} | ${b.name}: ${JSON.stringify(a.problem)}`);
    const split = pairs.filter(([a, b]) => a.byRule && a.reportedFor === b.reportedFor && a.list === b.list && a.problem !== b.problem).map(([a, b]) => `${a.name} | ${b.name}`);
    expect({ confused, split }).toEqual({ confused: [], split: [] });
  });

  it("an entry rule's problem names the entry's position, counted from 1", () => {
    const entryCases = brokenCases.filter((c) => ruleOf(c).position !== undefined);
    const named = entryCases.map((c) => {
      const file = fileWith('list.json', c.text);
      const numbers = (problemOutcome(check([file, c.list]), file).problem.match(/\d+/g) ?? []).map(Number);
      return [c.name, numbers.includes(ruleOf(c).position ?? 0)];
    });
    expect(Object.fromEntries(named)).toEqual(Object.fromEntries(entryCases.map((c) => [c.name, true])));
  });
});

describe('Usage errors exit 2', () => {
  it.each([
    ['no operands', []],
    ['one operand', ['list.json']],
    ['three operands', ['list.json', 'steps', 'extra']],
  ] as const)('%s prints usage to standard error and nothing to standard output', (_name, operands) => {
    fileWith('list.json', WELL_FORMED);
    expect(usageOutcome(check(operands))).toEqual(USAGE);
  });
});

describe('Operands are taken verbatim', () => {
  it("a relative file resolves against the caller's working directory", () => {
    const caller = dir('caller');
    fileWith('list.json', WELL_FORMED, caller);
    expect.soft(passNaming(check(['list.json', 'steps'], caller), join(caller, 'list.json'))).toEqual(PASSED_NAMING);
    expect.soft(problemOutcome(check(['absent.json', 'steps'], caller), join(caller, 'absent.json'))).toEqual(PROBLEM);
  });

  it('a file name and a list key holding spaces and shell metacharacters are each one operand, run as nothing', () => {
    const caller = dir('caller');
    const name = `my list; touch evil-marker $(touch pwned) 'q' "d".json`;
    const key = 'the "steps"; `touch ticked`';
    const file = fileWith(name, jsonListText(distinctTitles(2), key), caller);
    expect.soft(passNaming(check([name, key], caller), file)).toEqual(PASSED_NAMING);
    const absent = `${name}.absent`;
    expect.soft(problemOutcome(check([absent, key], caller), join(caller, absent))).toEqual(PROBLEM);
    expect.soft(['evil-marker', 'pwned', 'ticked'].filter((f) => existsSync(join(caller, f)) || existsSync(join(root, f)))).toEqual([]);
  });

  it('--help, - and -- are an ordinary file name and list key', () => {
    const caller = dir('caller');
    const help = fileWith('--help', WELL_FORMED, caller);
    const dash = fileWith('-', jsonListText(distinctTitles(1), '--'), caller);
    expect.soft(passNaming(check(['--help', 'steps'], caller), help)).toEqual(PASSED_NAMING);
    expect.soft(passNaming(check(['-', '--'], caller), dash)).toEqual(PASSED_NAMING);
  });

  it('the printed path is resolved lexically, so a symlinked parent directory stays as the caller named it', () => {
    const real = dir('real');
    const link = join(root, 'linked');
    symlinkSync(real, link);
    expect.soft(problemOutcome(check([join(link, 'absent.json'), 'steps']), join(link, 'absent.json'))).toEqual(PROBLEM);
    expect.soft(problemOutcome(check(['absent.json', 'steps'], link), join(link, 'absent.json'))).toEqual(PROBLEM);
  });

  it('a control character in the path prints as a space, so the problem stays one line', () => {
    const file = join(root, 'line\nbreak.json');
    expect(problemOutcome(check([file, 'steps']), join(root, 'line break.json'))).toEqual(PROBLEM);
  });
});

describe('A working directory that is gone', () => {
  it('a relative file named from a working directory that cannot be read prints one problem line and exits 1', () => {
    const run = runCheckRepeatList(['list.json', 'steps'], { cwd: () => { throw new Error('ENOENT: no such file or directory, uv_cwd'); } });
    const result: RunResult = { status: run.exitCode, signal: null, stdout: run.stdout, stderr: run.stderr };
    expect(problemOutcome(result, 'list.json')).toEqual(PROBLEM);
  });
});
