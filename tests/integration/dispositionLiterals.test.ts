// #207 — a prompt names a disposition through the constants of `src/shared/roundReport.ts`, never a hand-typed
// copy: a renamed disposition must reach every prompt, or the agent writes a value the validator rejects.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { DISPOSITIONS } from '../../src/shared/roundReport';

const SRC = path.resolve(__dirname, '../../src');
const HOME = path.join('shared', 'roundReport.ts');

const literalTexts = (source: string): string[] => {
  const file = ts.createSourceFile('scan.ts', source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const texts: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateLiteralToken(node)) {
      texts.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return texts;
};

const handTypedDispositions = (source: string): string[] =>
  literalTexts(source).flatMap((text) =>
    DISPOSITIONS.filter((d) => text.includes(`\`${d}\``) || text.includes(`"${d}"`)),
  );

describe('handTypedDispositions (self-check)', () => {
  it('finds a code-span disposition in a quoted string', () => {
    expect(handTypedDispositions("const s = 'record it as `dismissed — nit`';")).toEqual(['dismissed — nit']);
  });
  it('finds a code-span disposition in a template literal, beside an interpolation', () => {
    expect(handTypedDispositions('const s = `${a} never \\`fixed\\`, ${b}`;')).toEqual(['fixed']);
  });
  it('finds a double-quoted disposition', () => {
    expect(handTypedDispositions('const s = \'the issue is "needs a human"\';')).toEqual(['needs a human']);
  });
  it('passes a disposition named through a constant', () => {
    expect(handTypedDispositions('const s = `record it as \\`${NIT_DISPOSITION}\\``;')).toEqual([]);
  });
  it('passes a disposition word in a comment or as ordinary prose', () => {
    expect(handTypedDispositions("// never `fixed`\nconst s = 'position: fixed; needs a human to decide';")).toEqual([]);
  });
});

describe('dispositions outside src/shared/roundReport.ts', () => {
  const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter(
    (f) => /\.tsx?$/.test(f) && !f.endsWith('.d.ts') && f !== HOME,
  );

  it('scans the source tree', () => expect(files.length).toBeGreaterThan(0));

  it('no source file spells a disposition by hand', () => {
    const found = files.flatMap((f) =>
      handTypedDispositions(readFileSync(path.join(SRC, f), 'utf8')).map((d) => `src/${f}: ${d}`),
    );
    expect(found).toEqual([]);
  });
});
