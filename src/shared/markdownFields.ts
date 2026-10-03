// Shared linear-scan Markdown field primitives for the agent-output grammars — the round report (§27.5) and
// the phase result (§28.5.5). ONE definition, imported by both, because the CWE-1333/400 guarantee these
// encode — every parse of untrusted agent output is a plain char scan, never a RegExp, so it is linear-time
// and cannot be driven to catastrophic backtracking — is load-bearing and must stay in lockstep across every
// grammar that parses that output.

/** Strip a leading Markdown list marker — `-`, `*`, `+`, or an ordered `<n>.`/`<n>)` — so a field is
 *  recognized regardless of which bullet the agent chose. The glyph is not part of either grammar's contract,
 *  so binding to one (a composer's `-`) would let a field under any other valid bullet escape recognition.
 *  Plain char scan, never a RegExp (CWE-1333/400). */
export function stripLeadingBullet(t: string): string {
  if (t.length > 0 && (t[0] === '-' || t[0] === '*' || t[0] === '+')) return t.slice(1).trimStart();
  let k = 0;
  while (k < t.length && t[k] >= '0' && t[k] <= '9') k++;
  if (k > 0 && k < t.length && (t[k] === '.' || t[k] === ')')) return t.slice(k + 1).trimStart();
  return t;
}

/** The value of a `label: value` field on a line, or null when the line is not that field. Bullet-stripped and
 *  trimmed; the value is returned verbatim (never normalized — the caller decides membership). */
export function fieldValue(line: string, label: string): string | null {
  const t = stripLeadingBullet(line.trim());
  const idx = t.indexOf(':');
  if (idx < 0) return null;
  return t.slice(0, idx).trim() === label ? t.slice(idx + 1).trim() : null;
}

function indentOf(line: string): number {
  let k = 0;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
  return k;
}

/** The `label:` field starting at `lines[start]`, or null when that line is not the field. A label with nothing
 *  after its colon takes its value from the non-blank lines indented deeper than it (a nested list or a wrapped
 *  paragraph), bullet-stripped and joined by a space; `end` is the index just past the last line consumed. */
export function fieldBlock(lines: readonly string[], start: number, label: string): { value: string; end: number } | null {
  const inline = fieldValue(lines[start], label);
  if (inline === null) return null;
  if (inline !== '') return { value: inline, end: start + 1 };
  const depth = indentOf(lines[start]);
  const parts: string[] = [];
  let end = start + 1;
  for (; end < lines.length; end++) {
    const t = lines[end].trim();
    if (t === '' || indentOf(lines[end]) <= depth) break;
    parts.push(stripLeadingBullet(t));
  }
  return { value: parts.join(' '), end };
}
