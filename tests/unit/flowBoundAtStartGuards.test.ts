// #167 doc guards: the flow is bound at Start and pickup then binds the ticket; no clause requires or plans a
// ticket-borne flow stamp or pickup seeding of the pointer. Needles are built from split literals and the
// constructed `SECTION` glyph so this file never matches its own phrase list.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SECTION = String.fromCharCode(0xa7);
const RULE = `retired by ${SECTION}18.7.5 / D63, #167`;
const SPEC_DIR = 'docs/spec';
const CH18 = join(SPEC_DIR, '18-flow-definitions-flow-yaml.md');
const CHANGELOG = join(SPEC_DIR, 'changelog.md');
const ROOT_SPEC = 'terminal-web-ui-spec.md';

const read = (f: string): string => readFileSync(f, 'utf8');
const lower = (s: string): string => s.toLowerCase();
const join2 = (...parts: string[]): string => parts.join('');

/** The body under the heading carrying `num`, at any level, up to the next heading of the same or a higher
 *  level. The heading line itself is excluded. */
function sectionBody(text: string, num: string): string {
  const lines = text.split('\n');
  const escaped = num.replace(/\./g, '\\.');
  const head = new RegExp(`^(#{1,6})\\s+${escaped}(?![.\\d])`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return '';
  const level = (head.exec(lines[start]) as RegExpExecArray)[1].length;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const h = /^(#{1,6})\s/.exec(line);
    if (h && h[1].length <= level) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

const specFilesExceptChangelog = (): string[] =>
  readdirSync(SPEC_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'changelog.md')
    .map((f) => join(SPEC_DIR, f))
    .concat(ROOT_SPEC);

describe(`#167 slice 3 — no ${SECTION}18 / spec clause requires or plans pickup seeding or a ticket-borne stamp (AC 3)`, () => {
  const NEEDLES = [
    join2('Pickup see', 'ding (A4)'),
    join2('stamps the chosen ', 'selection'),
    join2("A4's ", 'seed'),
    join2('A4 ', 'seeds'),
    join2('A4 ', 'seed'),
    join2('pickup-', 'seeded'),
    join2('stamp', 'less'),
    join2('seed-', 'write'),
    join2('trusted-', 'seed'),
    join2('pick/', 'seed'),
    join2('A1', '–', 'A4'),
    join2('A0', '–', 'A4'),
    join2('pickup ', 'seeding'),
    join2('seed the ', 'pointer'),
  ];

  for (const needle of NEEDLES) {
    it(`no spec file outside the changelog contains "${needle}"`, () => {
      const offenders = specFilesExceptChangelog().filter((f) => lower(read(f)).includes(lower(needle)));
      expect(offenders, `"${needle}" (${RULE}) still in:\n${offenders.join('\n')}`).toEqual([]);
    });
  }

  it(`${SECTION}18.7 carries no stamp clause`, () => {
    const body = sectionBody(read(CH18), '18.7');
    expect(body.length, `${SECTION}18.7 body not found`).toBeGreaterThan(0);
    const hits = body.split('\n').filter((l) => /\bstamp/i.test(l));
    expect(hits, `stamp clause (${RULE}) still in ${SECTION}18.7:\n${hits.join('\n')}`).toEqual([]);
  });
});

describe(`#167 slice 3 — ${SECTION}18.7.1–${SECTION}18.7.7 keep their numbers and subjects (AC 5)`, () => {
  const SUBJECTS: ReadonlyArray<readonly [string, string]> = [
    ['18.7.1', 'catalog'],
    ['18.7.2', 'pointer'],
    ['18.7.3', 'resolver'],
    ['18.7.4', 'picker'],
    ['18.7.5', 'pickup'],
    ['18.7.6', 'safety'],
    ['18.7.7', 'recovery'],
  ];

  it('each heading exists, in order, keeping its subject word', () => {
    const lines = read(CH18).split('\n');
    const positions = SUBJECTS.map(([num, subject]) => {
      const i = lines.findIndex((l) => new RegExp(`^#{1,6}\\s+${num.replace(/\./g, '\\.')}\\s`).test(l));
      expect(i, `${SECTION}${num} heading missing`).toBeGreaterThanOrEqual(0);
      expect(lower(lines[i]), `${SECTION}${num} heading lost its subject "${subject}"`).toContain(subject);
      return i;
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe(`#167 slice 3 — ${SECTION}18.7.5 states the flow is bound at Start (AC 3)`, () => {
  it(`${SECTION}18.7.5 states the rule and that a ticket is untrusted input`, () => {
    const body = lower(sectionBody(read(CH18), '18.7.5'));
    expect(body.length, `${SECTION}18.7.5 body not found`).toBeGreaterThan(0);
    expect(body).toContain('bound at start');
    expect(body).toContain('pickup binds the ticket');
    expect(body).toContain('untrusted');
    expect(body).toContain('never select the flow');
    expect(
      body.indexOf('bound at start'),
      `${SECTION}18.7.5 must state Start's binding before pickup's`,
    ).toBeLessThan(body.indexOf('pickup binds the ticket'));
  });

  it(`${SECTION}18.7.5 carries no seed clause beyond its one historical mention`, () => {
    const body = sectionBody(read(CH18), '18.7.5');
    expect(body.length, `${SECTION}18.7.5 body not found`).toBeGreaterThan(0);
    const hits = body
      .split('\n')
      .filter((l) => /seed/i.test(l.replace(new RegExp(join2('pickup-', 'seeding clause'), 'gi'), '')));
    expect(hits, `seed clause (${RULE}) still in ${SECTION}18.7.5:\n${hits.join('\n')}`).toEqual([]);
  });

  it(`a changelog entry naming D63 and #167 cites ${SECTION}18.7.5 and the operator decision`, () => {
    const entries = read(CHANGELOG).split(/(?=\*\*Changelog v\d+\.\d+:\*\*)/);
    const entry = entries.find((e) => e.includes('D63') && e.includes('#167'));
    expect(entry, 'no changelog entry names both D63 and #167').toBeDefined();
    expect(entry as string).toContain(`${SECTION}18.7.5`);
    expect(lower(entry as string)).toContain('operator decision');
  });

  it('the historical v2.145 entry that introduced pickup seeding stays as written', () => {
    const v2145 = read(CHANGELOG)
      .split(/(?=\*\*Changelog v\d+\.\d+:\*\*)/)
      .find((e) => e.startsWith('**Changelog v2.145:**'));
    expect(v2145, 'the v2.145 changelog entry is gone').toBeDefined();
    expect(v2145 as string).toContain(join2('**pickup ', 'seeding** (', SECTION, '18.7.5'));
    expect(v2145 as string).toContain(join2('A1', '–', 'A4'));
  });
});

describe(`#167 slice 3 — ${SECTION}18.7.6's shared gates survive without seeding (AC 4)`, () => {
  /** The preamble (non-bullet text before the first `- ` bullet) plus each top-level `- ` bullet. */
  function units(): { preamble: string; bullets: string[] } {
    const body = sectionBody(read(CH18), '18.7.6');
    const lines = body.split('\n');
    const first = lines.findIndex((l) => l.startsWith('- '));
    const preamble = lines.slice(0, first < 0 ? lines.length : first).join('\n').trim();
    const bullets: string[] = [];
    for (const line of first < 0 ? [] : lines.slice(first)) {
      if (line.startsWith('- ')) bullets.push(line);
      else if (bullets.length > 0) bullets[bullets.length - 1] += `\n${line}`;
    }
    return { preamble, bullets };
  }

  const ANCHORS: ReadonlyArray<readonly [string, (u: string) => boolean]> = [
    ['One pointer identity', (u) => u.includes('One pointer identity')],
    ['Read-boundary field validation', (u) => u.includes('Read-boundary field validation')],
    ['Per-tier confinement', (u) => u.includes('Per-tier confinement')],
    ['Enumeration-read totality', (u) => u.includes('Enumeration-read totality')],
    ['Reconcile the segment charset', (u) => u.includes('Reconcile the segment charset')],
    ['Sanitize the refusal reason', (u) => u.includes('Sanitize the refusal reason')],
    ['The display-sanitize treatment', (u) => u.includes('The display-sanitize treatment')],
    ['The catalog *is* the library', (u) => u.includes('The catalog *is* the library')],
    ['The catalog-listing seam', (u) => u.includes('The catalog-listing seam')],
    ['Surface an unreadable-tier notice', (u) => u.includes('Surface an unreadable-tier notice')],
    ['first-run writer', (u) => u.includes('*first-run* writer')],
    ['structured-value write', (u) => u.includes('structured-value write') && u.includes('YAML emitter')],
  ];

  it('the preamble is present and keeps confine-at-use regardless of provenance', () => {
    const { preamble } = units();
    expect(preamble.length, `${SECTION}18.7.6 preamble not found`).toBeGreaterThan(0);
    expect(preamble).toContain('regardless of provenance');
  });

  for (const [name, matches] of ANCHORS) {
    it(`exactly one ${SECTION}18.7.6 bullet is the "${name}" gate`, () => {
      expect(units().bullets.filter(matches)).toHaveLength(1);
    });
  }

  it('the shared name-length bound survives in the segment-charset bullet', () => {
    const charset = units().bullets.find((b) => b.includes('Reconcile the segment charset')) ?? '';
    expect(charset).toContain('shared maximum');
    expect(charset).toContain('64');
  });

  it('the first-run writer survives', () => {
    expect(units().bullets.some((b) => b.includes('first-run'))).toBe(true);
  });

  it('exactly the two seed-only bullets are gone', () => {
    const { bullets } = units();
    expect(bullets.length, `${SECTION}18.7.6 bullets not found`).toBeGreaterThan(0);
    for (const lead of [join2('Structured travel on the ', 'seed-write'), join2('Argument-safe ', 'seed-write')]) {
      expect(bullets.filter((b) => b.includes(lead)), `"${lead}" (${RULE})`).toEqual([]);
    }
  });

  it('no surviving unit, the preamble included, justifies itself by A4 or seeding', () => {
    const { preamble, bullets } = units();
    expect(preamble.length, `${SECTION}18.7.6 preamble not found`).toBeGreaterThan(0);
    expect(bullets.length, `${SECTION}18.7.6 bullets not found`).toBeGreaterThan(0);
    const offenders = [preamble, ...bullets].filter((u) => /A4/.test(u) || /seed/i.test(u));
    expect(offenders.map((u) => u.slice(0, 120)), RULE).toEqual([]);
  });
});
