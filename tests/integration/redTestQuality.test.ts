import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundledPath, REPO_DIR } from '../helpers/bundledLoops';

// RED tests are written to UI-STANDARDS.md §3.4 and self-checked before review; a RED test a correct
// implementation could fail is left to GREEN, which corrects it under `### RED test changes`.
const read = (rel: string): string => readFileSync(bundledPath(rel), 'utf8').replace(/\s+/g, ' ').replace(/\*\*/g, '');
const UI_STANDARDS = readFileSync(join(REPO_DIR, 'UI-STANDARDS.md'), 'utf8');

const UI_READING_CITATION = 'UI §3.4';
const LEFT_TO_GREEN = 'GREEN corrects a RED test that rejects a correct implementation';

describe('UI-STANDARDS.md says how a UI test reads the screen', () => {
  it('has the §3.4 section the loop prompts cite', () =>
    expect(UI_STANDARDS).toMatch(/^### 3\.4 How a UI test reads the screen$/m));

  for (const rule of [
    'by role and accessible name',
    'inside the element that owns',
    'after it settles',
    'tell the cases apart',
    'fails when it finds nothing to check',
    'every pairing that is actually painted',
    'from the new requirement',
  ]) {
    it(`§3.4 states the rule "${rule}"`, () => expect(UI_STANDARDS.replace(/\s+/g, ' ')).toContain(rule));
  }
});

describe('the RED step checks its own tests before review', () => {
  const brief = (): string => read('red-loop/prompts/brief.md');

  it('asks what wrong implementation would still pass each test', () =>
    expect(brief()).toContain('what wrong implementation would still pass it'));
  it('asks what correct implementation would fail each test', () =>
    expect(brief()).toContain('what correct implementation would fail it'));
  it('points renderer UI tests at UI §3.4', () => expect(brief()).toContain(UI_READING_CITATION));
});

describe('a RED test a correct implementation could fail is left to GREEN', () => {
  for (const charter of ['red-loop/charter/tests.md', 'red-loop/charter/red-authenticity.md']) {
    it(`${charter} does not make it a RED finding`, () => expect(read(charter)).toContain(LEFT_TO_GREEN));
  }

  it('the GREEN brief corrects such a test even when the implementation happens to satisfy it', () =>
    expect(read('green-loop/prompts/brief.md')).toContain('even when your implementation happens to satisfy it'));
});

describe('the infra step builds the UI test helper and fixtures to UI §3.4', () => {
  const brief = (): string => read('infra-loop/prompts/brief.md');

  it('cites UI §3.4', () => expect(brief()).toContain(UI_READING_CITATION));
  it('has one matcher every query in the helper shares', () => expect(brief()).toContain('one matcher'));
  it('gives every value a fixture sets a different value', () => expect(brief()).toContain('a different value'));
});
