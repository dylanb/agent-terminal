import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleReportOnDisk, sectionFile } from '../../src/main/reportSections';

const ORDER = ['infra', 'red', 'green'];
let root: string;
let report: { path: string; sectionsDir: { path: string; rel: string } };

const write = (step: string, slice: number, body: string): void => {
  const f = sectionFile(report.sectionsDir, step, slice)!;
  mkdirSync(report.sectionsDir.path, { recursive: true });
  writeFileSync(f.path, body);
};
const doc = (): string => readFileSync(report.path, 'utf8');

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'report-assembly-')));
  report = { path: join(root, 'impl-report.md'), sectionsDir: { path: join(root, 'impl-report'), rel: 'impl-report' } };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('assembleReportOnDisk', () => {
  it('writes the report from every section file on disk, in flow order', () => {
    write('green', 1, '## green — slice 1\ngreen work\n');
    write('infra', 1, '## infra\ninfra work\n');
    expect(assembleReportOnDisk(report, ORDER)).toBe('assembled');
    expect(doc().indexOf('## infra')).toBeLessThan(doc().indexOf('## green — slice 1'));
    expect(doc()).toContain('infra work');
    expect(doc()).toContain('green work');
  });

  it('replaces only the rewritten section when a step rewrites its file', () => {
    write('infra', 1, '## infra\ninfra work\n');
    write('red', 1, '## red — slice 1\nfirst try\n');
    write('green', 1, '## green — slice 1\ngreen work\n');
    assembleReportOnDisk(report, ORDER);
    write('red', 1, '## red — slice 1\nsecond try\n');
    assembleReportOnDisk(report, ORDER);
    expect(doc()).toContain('second try');
    expect(doc()).not.toContain('first try');
    expect(doc().match(/## red — slice 1/g)).toHaveLength(1);
    expect(doc()).toContain('## infra\ninfra work\n');
    expect(doc()).toContain('## green — slice 1\ngreen work\n');
  });

  it('writes nothing when no step has written a section yet', () => {
    expect(assembleReportOnDisk(report, ORDER)).toBe('nothing-to-assemble');
    expect(existsSync(report.path)).toBe(false);
  });

  it('leaves a hand-written report untouched while no section exists', () => {
    writeFileSync(report.path, '## infra\nhand-written\n');
    assembleReportOnDisk(report, ORDER);
    expect(doc()).toBe('## infra\nhand-written\n');
  });

  it('keeps a hand-written report ahead of the sections, through every later assembly', () => {
    writeFileSync(report.path, '## infra\nhand-written\n');
    write('red', 1, '## red — slice 1\nred work\n');
    assembleReportOnDisk(report, ORDER);
    assembleReportOnDisk(report, ORDER);
    expect(doc()).toContain('## infra\nhand-written\n');
    expect(doc().match(/hand-written/g)).toHaveLength(1);
    expect(doc().indexOf('hand-written')).toBeLessThan(doc().indexOf('red work'));
  });

  it('ignores a file in the sections folder that no step writes', () => {
    write('red', 1, '## red — slice 1\nred work\n');
    writeFileSync(join(report.sectionsDir.path, 'notes.txt'), 'scratch\n');
    assembleReportOnDisk(report, ORDER);
    expect(doc()).not.toContain('scratch');
  });

  it('refuses a section file that leads outside its folder, and writes no report missing it', () => {
    const outside = join(root, 'elsewhere.md');
    writeFileSync(outside, '## red — slice 1\nsecret\n');
    mkdirSync(report.sectionsDir.path, { recursive: true });
    symlinkSync(outside, sectionFile(report.sectionsDir, 'red', 1)!.path);
    expect(() => assembleReportOnDisk(report, ORDER)).toThrow(/red\.md/);
    expect(existsSync(report.path)).toBe(false);
  });
});
