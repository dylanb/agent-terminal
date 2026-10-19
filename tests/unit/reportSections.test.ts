import { describe, expect, it } from 'vitest';
import { assembleReport, isAssembledReport, sectionFile, sectionOf } from '../../src/main/reportSections';

const DIR = { path: '/repo/.agent-terminal/loop/artifacts/impl-report', rel: '.agent-terminal/loop/artifacts/impl-report' };
const ORDER = ['infra', 'red', 'green', 'refactor', 'integration-slice'];

describe('sectionFile — where a step writes its section', () => {
  it("names slice 1's file after the step, and a later slice's with the .slice-N suffix the phase results use", () => {
    expect(sectionFile(DIR, 'red', 1)?.rel).toBe(`${DIR.rel}/red.md`);
    expect(sectionFile(DIR, 'red', 2)?.rel).toBe(`${DIR.rel}/red.slice-2.md`);
    expect(sectionFile(DIR, 'red', 2)?.path).toBe(`${DIR.path}/red.slice-2.md`);
  });

  it('names no file for a step id that is not one safe path segment', () => {
    for (const step of ['../red', 'a/b', '', 'Red', '.hidden']) expect(sectionFile(DIR, step, 1), step).toBeNull();
  });

  it('is read back by sectionOf as the step and slice it was written for', () => {
    for (const step of ORDER) {
      for (const slice of [1, 2, 7]) {
        const name = sectionFile(DIR, step, slice)!.rel.split('/').pop()!;
        expect(sectionOf(name), name).toEqual({ step, slice });
      }
    }
  });

  it('reads no step from a name no step writes', () => {
    for (const name of ['red.slice-1.md', 'red.slice-0.md', 'notes.txt', 'red.MD', '_earlier.md', 'Red.md', 'red.slice-x.md']) {
      expect(sectionOf(name), name).toBeNull();
    }
  });
});

describe('assembleReport — one document from every step section', () => {
  const s = (step: string, slice: number) => ({ step, slice, body: `## ${step} — slice ${slice}\nbody of ${step} ${slice}\n` });
  const headings = (doc: string) => doc.split('\n').filter((l) => l.startsWith('## '));

  it('orders the sections by slice, then by the flow step order, whatever order they are given in', () => {
    const doc = assembleReport([s('green', 2), s('red', 1), s('integration-slice', 2), s('refactor', 1), s('red', 2), s('infra', 1), s('green', 1)], ORDER, null);
    expect(headings(doc)).toEqual([
      '## infra — slice 1',
      '## red — slice 1',
      '## green — slice 1',
      '## refactor — slice 1',
      '## red — slice 2',
      '## green — slice 2',
      '## integration-slice — slice 2',
    ]);
  });

  it('keeps every section body whole', () => {
    const doc = assembleReport([s('red', 1), s('green', 1)], ORDER, null);
    expect(doc).toContain('## red — slice 1\nbody of red 1\n');
    expect(doc).toContain('## green — slice 1\nbody of green 1\n');
  });

  it('places a step the flow does not name after the steps it does, within its slice', () => {
    const doc = assembleReport([s('extra', 1), s('red', 1), s('red', 2)], ORDER, null);
    expect(headings(doc)).toEqual(['## red — slice 1', '## extra — slice 1', '## red — slice 2']);
  });

  it('leads with a report written before sections existed, so none of it is lost', () => {
    const doc = assembleReport([s('red', 1)], ORDER, '## infra\nhand-written\n');
    expect(doc.indexOf('## infra\nhand-written')).toBeGreaterThan(-1);
    expect(doc.indexOf('## infra\nhand-written')).toBeLessThan(doc.indexOf('## red — slice 1'));
  });

  it('is recognisable as assembled, and a hand-written report is not', () => {
    expect(isAssembledReport(assembleReport([s('red', 1)], ORDER, null))).toBe(true);
    expect(isAssembledReport('## red — slice 1\n')).toBe(false);
  });
});
