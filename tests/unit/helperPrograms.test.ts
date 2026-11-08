import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createHelperPrograms } from '../../src/main/helperPrograms';

// The operator decision: the file is re-read at most every 15 s.
const REFRESH_MS = 15_000;

let appHome: string;
let file: string;
let clock: number;
let errors: MockInstance<typeof console.error>;

beforeEach(() => {
  appHome = realpathSync(mkdtempSync(join(tmpdir(), 'helper-programs-')));
  file = join(appHome, '.agent-terminal', 'helper-programs.yaml');
  clock = 0;
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  errors.mockRestore();
  rmSync(appHome, { recursive: true, force: true });
});

function write(text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const reader = () => createHelperPrograms({ appHome, now: () => clock });

/** Whether each line written to the main-process log names the helper file. */
const warningsNamingFile = (): boolean[] => errors.mock.calls.map((args) => args.map(String).join(' ').includes(file));

describe('the operator\'s helper file', () => {
  it('lists the program names the file holds', () => {
    write('- my-lsp\n- other-helper\n');
    expect(reader().names()).toEqual(['my-lsp', 'other-helper']);
  });

  it('reads a missing file as no names, warning nothing and creating nothing, then picks up an edit, or the file created later, once the refresh interval has passed, and never re-reads sooner', () => {
    write('- my-lsp\n');
    const edited = reader();
    const createdLater = createHelperPrograms({ appHome: join(appHome, 'later'), now: () => clock });
    const first = { edited: edited.names(), createdLater: createdLater.names(), warnings: errors.mock.calls.length, laterCreated: existsSync(join(appHome, 'later')) };
    write('- other-lsp\n');
    mkdirSync(join(appHome, 'later', '.agent-terminal'), { recursive: true });
    writeFileSync(join(appHome, 'later', '.agent-terminal', 'helper-programs.yaml'), '- late-lsp\n');
    clock = REFRESH_MS - 1;
    const sooner = { edited: edited.names(), createdLater: createdLater.names() };
    clock = REFRESH_MS + 1;
    const after = { edited: edited.names(), createdLater: createdLater.names() };
    expect({ first, sooner, after }).toEqual({
      first: { edited: ['my-lsp'], createdLater: [], warnings: 0, laterCreated: false },
      sooner: { edited: ['my-lsp'], createdLater: [] },
      after: { edited: ['other-lsp'], createdLater: ['late-lsp'] },
    });
  });

  it('drops the names of a file that breaks or is deleted once the refresh interval has passed, warning once for the broken one', () => {
    write('- my-lsp\n');
    const programs = reader();
    const valid = programs.names();
    write('[my-lsp, 3]\n');
    clock = REFRESH_MS + 1;
    const broken = programs.names();
    rmSync(file);
    clock = 2 * (REFRESH_MS + 1);
    const deleted = programs.names();
    expect({ valid, broken, deleted, warnings: warningsNamingFile() }).toEqual({ valid: ['my-lsp'], broken: [], deleted: [], warnings: [true] });
  });

  it.each([
    ['a list with a non-string entry', () => write('[my-lsp, 3]\n')],
    ['a mapping, not a list', () => write('my-lsp: true\n')],
    ['text that is not YAML', () => write('[my-lsp\n')],
    ['a path that cannot be read as a file', () => mkdirSync(file, { recursive: true })],
  ])('reads no names from %s, and warns once naming the file while it stays unchanged', (_, make) => {
    make();
    const programs = reader();
    const names = [programs.names()];
    clock = REFRESH_MS + 1;
    names.push(programs.names());
    expect({ names, warnings: warningsNamingFile() }).toEqual({ names: [[], []], warnings: [true] });
  });

  it('warns once per change of what the file reads, so broken content A, then B, then A again warns three times', () => {
    const programs = reader();
    const names: (readonly string[])[] = [];
    const readAt = (step: number, text: string) => {
      write(text);
      clock = step * (REFRESH_MS + 1);
      names.push(programs.names());
    };
    readAt(0, '[my-lsp, 3]\n');
    readAt(1, '[my-lsp, 3]\n');
    readAt(2, 'my-lsp: true\n');
    readAt(3, '[my-lsp, 3]\n');
    expect({ names, warnings: warningsNamingFile() }).toEqual({ names: [[], [], [], []], warnings: [true, true, true] });
  });
});
