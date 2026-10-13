import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { bundledPath } from '../helpers/bundledLoops';

// §28.5.3 — on #180's red-loop, rounds 3–5 changed no test: each wrote more "GREEN must first see this check fail"
// entries into red-result.md for tests that failed before reaching their own check, and each entry was new
// surface for the next round. A RED test whose own check is hidden behind an earlier failure is restructured.

const read = (rel: string): string => readFileSync(bundledPath(rel), 'utf8');
const RESTRUCTURE = /fails before it reaches[\s\S]*restructur/i;
const NO_DEFERRAL = /never[\s\S]*instruction[\s\S]*GREEN/i;

describe('red-loop: a check hidden behind an earlier failure is restructured, not deferred', () => {
  it('the work recipe tells the agent to restructure such a test', () => {
    expect(read('red-loop/prompts/work.md')).toMatch(RESTRUCTURE);
  });

  it('the work recipe forbids leaving GREEN an instruction to see the check fail later', () => {
    expect(read('red-loop/prompts/work.md')).toMatch(NO_DEFERRAL);
  });

  it('the red-authenticity charter grades a hidden check as a test to restructure', () => {
    const charter = read('red-loop/charter/red-authenticity.md');
    expect(charter).toMatch(RESTRUCTURE);
    expect(charter).toMatch(NO_DEFERRAL);
  });

  it("the red-authenticity charter reads the repo's red-check report when there is one", () => {
    expect(read('red-loop/charter/red-authenticity.md')).toMatch(/red[- ]check report/i);
  });
});
