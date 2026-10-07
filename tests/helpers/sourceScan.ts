import { readdirSync } from 'node:fs';
import path from 'node:path';

export const SRC_MAIN = path.resolve(__dirname, '..', '..', 'src', 'main');

/** Every `.ts` file under `dir`, recursively. */
export function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? tsFilesUnder(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** A TypeScript source with its block and line comments blanked, string literals kept intact. */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      out += ' ';
      continue;
    }
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** The body of the top-level `export function <name>` in `src`, by brace matching from its first `{`. */
export function functionBody(src: string, name: string): string {
  const start = src.search(new RegExp(`export function ${name}\\b`));
  if (start < 0) return '';
  let parens = 0;
  let afterParams = src.indexOf('(', start);
  for (; afterParams < src.length; afterParams += 1) {
    if (src[afterParams] === '(') parens += 1;
    else if (src[afterParams] === ')' && --parens === 0) break;
  }
  const open = src.indexOf('{', afterParams);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}
