import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_DIR } from './bundledLoops';

const SPEC_DIR = join(REPO_DIR, 'docs', 'spec');
const HEADING = /^(#{1,6})\s+(\d+(?:\.\d+)*)(?=[.\s]|$)/;
const ANY_HEADING = /^(#{1,6})\s/;

/** The text of section `number` in `doc`: its heading line through the line before the next heading of the
 *  same or a higher level, so its sub-clauses are included. */
export function sectionOf(doc: string, number: string): string {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => HEADING.exec(l)?.[2] === number);
  if (start === -1) throw new Error(`the document has no §${number} heading`);
  const level = (HEADING.exec(lines[start]) as RegExpExecArray)[1].length;
  const rest = lines.slice(start + 1).findIndex((l) => {
    const m = ANY_HEADING.exec(l);
    return m !== null && m[1].length <= level;
  });
  return lines.slice(start, rest === -1 ? undefined : start + 1 + rest).join('\n');
}

/** Section `number` of whichever `docs/spec/` file carries its heading. */
export function specSection(number: string): string {
  for (const f of readdirSync(SPEC_DIR).filter((n) => n.endsWith('.md')).sort()) {
    const doc = readFileSync(join(SPEC_DIR, f), 'utf8');
    if (doc.split('\n').some((l) => HEADING.exec(l)?.[2] === number)) return sectionOf(doc, number);
  }
  throw new Error(`no docs/spec file has a §${number} heading`);
}
