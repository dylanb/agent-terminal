import { describe, expect, it } from 'vitest';
import { sectionOf, specSection } from '../helpers/specSection';

const DOC = ['## 27. Engine', '', '### 27.5 The round report (N5)', 'five body', '', '### 27.6 The consolidator (N6)', 'six body', '#### 27.6.1 A sub-clause', 'sub body', '### 27.7 Next', 'seven body', '### 27.60 Not 27.6', 'sixty body'].join('\n');

describe('sectionOf — the text from a numbered heading to the next heading of the same or a higher level', () => {
  it('includes the heading and its sub-clauses and stops at the next sibling heading', () => {
    const six = sectionOf(DOC, '27.6');
    expect(six.startsWith('### 27.6 The consolidator')).toBe(true);
    expect(six).toContain('sub body');
    expect(six).not.toContain('seven body');
  });

  it('matches the section number exactly, never a longer number that starts with it', () => {
    expect(sectionOf(DOC, '27.60')).toContain('sixty body');
    expect(sectionOf(DOC, '27.6')).not.toContain('sixty body');
  });

  it('reads the last section to the end of the document', () => {
    expect(sectionOf(DOC, '27.60').trimEnd().endsWith('sixty body')).toBe(true);
  });

  it('throws on a section the document does not have, so a renumbered heading fails loudly', () => {
    expect(() => sectionOf(DOC, '27.9')).toThrow(/§27\.9/);
  });
});

describe('specSection — a §27 section of the spec on disk', () => {
  it('reads §27.6 from the §27 spec file, bounded by §27.7', () => {
    const six = specSection('27.6');
    expect(six).toMatch(/^### 27\.6 /);
    expect(six).not.toMatch(/^### 27\.7 /m);
  });
});
