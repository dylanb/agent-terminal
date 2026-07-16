import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { isErrno, errMsg } from '../../src/main/errno';

describe('isErrno', () => {
  it('is true only for an Error carrying exactly that code', () => {
    const e = Object.assign(new Error('x'), { code: 'ENOENT' });
    expect(isErrno(e, 'ENOENT')).toBe(true);
    expect(isErrno(e, 'EEXIST')).toBe(false);
  });

  it('fails closed on a thrown non-Error (a string, a plain object, null)', () => {
    expect(isErrno('ENOENT', 'ENOENT')).toBe(false);
    expect(isErrno({ code: 'ENOENT' }, 'ENOENT')).toBe(false);
    expect(isErrno(null, 'ENOENT')).toBe(false);
  });

  it('is false for an Error with no code, or a non-string code', () => {
    expect(isErrno(new Error('x'), 'ENOENT')).toBe(false);
    expect(isErrno(Object.assign(new Error('x'), { code: 1 }), 'ENOENT')).toBe(false);
  });
});

describe('errMsg', () => {
  it('reads an Error message and stringifies anything else', () => {
    expect(errMsg(new Error('boom'))).toBe('boom');
    expect(errMsg('boom')).toBe('boom');
    expect(errMsg({ toString: () => 'obj' })).toBe('obj');
    expect(errMsg(undefined)).toBe('undefined');
  });
});

// The `ErrnoCode` union is a CLAIM: "the codes this codebase branches on." An unused member is that claim
// made false — which is exactly what round 8 found and fixed by hand. This is the enforcement, so the doc
// no longer has to assert an invariant nothing checks (CLAUDE.md: a comment asserting an invariant is a
// missing check). Every `isErrno(e, 'CODE')` call across src/main names its code as a string literal, so
// the set actually branched on is recoverable statically.
describe('ErrnoCode names exactly the codes the code branches on', () => {
  const SRC = path.resolve(__dirname, '..', '..', 'src', 'main');

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });

  it('every isErrno call uses a code in the union, and every union member is used', () => {
    const branchedOn = new Set<string>();
    for (const file of walk(SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/isErrno\([^,]+,\s*'([A-Z]+)'\)/g)) branchedOn.add(m[1]);
    }
    // The union's members, read from the declaration — the one place they are spelled.
    const decl = readFileSync(path.join(SRC, 'errno.ts'), 'utf8');
    const unionLine = decl.match(/export type ErrnoCode =([^;]+);/)![1];
    const members = new Set([...unionLine.matchAll(/'([A-Z]+)'/g)].map((m) => m[1]));

    expect([...branchedOn].sort()).toEqual([...members].sort());
  });
});
