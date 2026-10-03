// #167 doc guards: the flow is bound at Start and pickup then binds the ticket; no clause requires or plans a
// ticket-borne flow stamp or pickup seeding of the pointer. Needles are built from split literals and the
// constructed `SECTION` glyph so this file never matches its own phrase list.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SECTION = String.fromCharCode(0xa7);
const RULE = `retired by ${SECTION}18.7.5 / D63, #167`;
const SPEC_DIR = 'docs/spec';
const CH06 = join(SPEC_DIR, '06-ipc-contract.md');
const CH18 = join(SPEC_DIR, '18-flow-definitions-flow-yaml.md');
const CH23 = join(SPEC_DIR, '23-multi-instance-and-epics.md');
const CH24 = join(SPEC_DIR, '24-build-plan-ui-inwards.md');
const CHANGELOG = join(SPEC_DIR, 'changelog.md');
const ROOT_SPEC = 'terminal-web-ui-spec.md';
const REQUIREMENTS = 'flow-management-requirements.md';
const DESIGN = 'design/granular-flow-and-flow-selection-plan.md';

const read = (f: string): string => readFileSync(f, 'utf8');
const lower = (s: string): string => s.toLowerCase();
const join2 = (...parts: string[]): string => parts.join('');
const headingPattern = (num: string, after: string): RegExp =>
  new RegExp(`^(#{1,6})\\s+${num.replace(/\./g, '\\.')}${after}`);
const changelogEntries = (): string[] => read(CHANGELOG).split(/(?=\*\*Changelog v\d+\.\d+:\*\*)/);

/** The body under the heading carrying `num`, at any level, up to the next heading of the same or a higher
 *  level. The heading line itself is excluded. */
function sectionBody(text: string, num: string): string {
  const lines = text.split('\n');
  const head = headingPattern(num, '(?![.\\d])');
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

/** `sectionBody` of `file`, asserted present so a renamed or missing heading fails rather than passing vacuously. */
function sectionOf(file: string, num: string): string {
  const body = sectionBody(read(file), num);
  expect(body.length, `${file} ${SECTION}${num} body not found`).toBeGreaterThan(0);
  return body;
}

const specFilesExceptChangelog = (): string[] =>
  readdirSync(SPEC_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'changelog.md')
    .map((f) => join(SPEC_DIR, f))
    .concat(ROOT_SPEC);

describe(`#167 — no ${SECTION}18 / spec clause requires or plans pickup seeding or a ticket-borne stamp (AC 3)`, () => {
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
    const hits = sectionOf(CH18, '18.7').split('\n').filter((l) => /\bstamp/i.test(l));
    expect(hits, `stamp clause (${RULE}) still in ${SECTION}18.7:\n${hits.join('\n')}`).toEqual([]);
  });
});

describe(`#167 — ${SECTION}18.7.1–${SECTION}18.7.7 keep their numbers and subjects (AC 5)`, () => {
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
      const i = lines.findIndex((l) => headingPattern(num, '\\s').test(l));
      expect(i, `${SECTION}${num} heading missing`).toBeGreaterThanOrEqual(0);
      expect(lower(lines[i]), `${SECTION}${num} heading lost its subject "${subject}"`).toContain(subject);
      return i;
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe(`#167 — ${SECTION}18.7.5 states the flow is bound at Start (AC 3)`, () => {
  it(`${SECTION}18.7.5 states the rule and that a ticket is untrusted input`, () => {
    const body = lower(sectionOf(CH18, '18.7.5'));
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
    const hits = sectionOf(CH18, '18.7.5')
      .split('\n')
      .filter((l) => /seed/i.test(l.replace(new RegExp(join2('pickup-', 'seeding clause'), 'gi'), '')));
    expect(hits, `seed clause (${RULE}) still in ${SECTION}18.7.5:\n${hits.join('\n')}`).toEqual([]);
  });

  it(`a changelog entry naming D63 and #167 cites ${SECTION}18.7.5 and the operator decision`, () => {
    const entry = changelogEntries().find((e) => e.includes('D63') && e.includes('#167'));
    expect(entry, 'no changelog entry names both D63 and #167').toBeDefined();
    expect(entry as string).toContain(`${SECTION}18.7.5`);
    expect(lower(entry as string)).toContain('operator decision');
  });

  it('the historical v2.145 entry that introduced pickup seeding stays as written', () => {
    const v2145 = changelogEntries().find((e) => e.startsWith('**Changelog v2.145:**'));
    expect(v2145, 'the v2.145 changelog entry is gone').toBeDefined();
    expect(v2145 as string).toContain(join2('**pickup ', 'seeding** (', SECTION, '18.7.5'));
    expect(v2145 as string).toContain(join2('A1', '–', 'A4'));
  });
});

describe(`#167 — ${SECTION}18.7.6's shared gates survive without seeding (AC 4)`, () => {
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

  /** Each gate is identified by every one of its needles appearing in a single bullet. */
  const GATES: ReadonlyArray<readonly string[]> = [
    ['One pointer identity'],
    ['Read-boundary field validation'],
    ['Per-tier confinement'],
    ['Enumeration-read totality'],
    ['Reconcile the segment charset'],
    ['Sanitize the refusal reason'],
    ['The display-sanitize treatment'],
    ['The catalog *is* the library'],
    ['The catalog-listing seam'],
    ['Surface an unreadable-tier notice'],
    ['*first-run* writer'],
    ['structured-value write', 'YAML emitter'],
  ];

  it('the preamble is present and keeps confine-at-use regardless of provenance', () => {
    const { preamble } = units();
    expect(preamble.length, `${SECTION}18.7.6 preamble not found`).toBeGreaterThan(0);
    expect(preamble).toContain('regardless of provenance');
  });

  for (const needles of GATES) {
    it(`exactly one ${SECTION}18.7.6 bullet is the "${needles[0]}" gate`, () => {
      expect(units().bullets.filter((b) => needles.every((n) => b.includes(n)))).toHaveLength(1);
    });
  }

  it('the shared name-length bound survives in the segment-charset bullet', () => {
    const charset = units().bullets.find((b) => b.includes('Reconcile the segment charset')) ?? '';
    expect(charset).toContain('shared maximum');
    expect(charset).toContain('64');
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

/** The single line of `file` matching `pattern`; asserted unique so a missed or duplicated anchor fails. */
function soleLine(file: string, pattern: RegExp): string {
  const hits = read(file)
    .split('\n')
    .filter((l) => pattern.test(l));
  expect(hits, `expected exactly one line of ${file} matching ${pattern}`).toHaveLength(1);
  return hits[0];
}

const openChildRow = (): string => soleLine(CH06, /^\|\s*`flow:openChild`/);
const openChildSketch = (): string => soleLine(CH06, /^\s*openChild:/);
const childLauncherItem = (): string => soleLine(CH24, /child-instance launcher/i);
const ch23Body = (): string => sectionOf(CH23, '23.2');
const sentences = (text: string): string[] => text.split(/(?<=[.!?])\s+/);

describe(`#167 — no ${SECTION}6 / ${SECTION}23 / ${SECTION}24 clause seeds a child's flow selection or flow-state (AC 6)`, () => {
  const NEEDLES = [
    join2("seeding that worktree's ", 'flow-state'),
    join2('seeding its ', 'flow-state'),
    join2('seeds the ', 'expected'),
  ];

  for (const needle of NEEDLES) {
    it(`no ${SECTION}6 / ${SECTION}23 / ${SECTION}24 chapter contains "${needle}"`, () => {
      const offenders = [CH06, CH23, CH24].filter((f) => lower(read(f)).includes(lower(needle)));
      expect(offenders, `"${needle}" (${RULE}) still in:\n${offenders.join('\n')}`).toEqual([]);
    });
  }

  it(`the ${SECTION}23.2 body, the ${SECTION}6 flow:openChild row and sketch, and the ${SECTION}24 launcher item use no form of "seed"`, () => {
    const scoped: ReadonlyArray<readonly [string, string]> = [
      [`${SECTION}23.2 body`, ch23Body()],
      [`${SECTION}6 flow:openChild row`, openChildRow()],
      [`${SECTION}6 openChild preload sketch`, openChildSketch()],
      [`${SECTION}24 child-instance launcher item`, childLauncherItem()],
    ];
    const offenders = scoped.filter(([, text]) => /seed/i.test(text)).map(([where]) => where);
    expect(offenders, `seed clause (${RULE}) still in:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe(`#167 — epic child worktrees are bound at Start too (AC 6)`, () => {
  it(`the ${SECTION}6 flow:openChild row and preload sketch carry no atStep`, () => {
    expect(openChildRow(), `atStep in the flow:openChild row (${RULE})`).not.toContain('atStep');
    expect(openChildSketch(), `atStep in the openChild preload sketch (${RULE})`).not.toContain('atStep');
  });

  it(`the ${SECTION}6 flow:openChild payload and preload sketch take only prRef — no renamed seeding field`, () => {
    expect(openChildRow(), `flow:openChild payload (${RULE})`).toContain('`{sessionId, prRef} → {worktree, launched}`');
    expect(openChildSketch(), `openChild preload sketch (${RULE})`).toMatch(
      /openChild:\s*\(prRef\)\s*=>\s*ipcRenderer\.invoke\('flow:openChild',\s*\{\s*sessionId:\s*SID,\s*prRef\s*\}\)/,
    );
  });

  it(`${SECTION}23.2 states the child's flow is bound at Start and its run begins where an ordinary Start begins`, () => {
    const body = lower(ch23Body());
    expect(body).toContain('bound at start');
    expect(body).toContain('where an ordinary start');
  });

  it(`${SECTION}23.2 states flow:openChild does not set the child worktree's flow selection or flow-state`, () => {
    expect(lower(ch23Body()), RULE).toContain("does not set that worktree's flow selection or flow-state");
  });

  it(`${SECTION}23.2 no longer says the child runs the parent's flow`, () => {
    expect(lower(ch23Body()), RULE).not.toContain('all steps of the flow run on each pr');
  });

  it(`no sentence of ${SECTION}23.2 or the ${SECTION}6 flow:openChild row cites D22 as authority for seeding`, () => {
    const offenders = [...sentences(ch23Body()), ...sentences(openChildRow())].filter(
      (s) => s.includes('D22') && /seed/i.test(s),
    );
    expect(offenders, `D22 cited for seeding (${RULE}):\n${offenders.join('\n')}`).toEqual([]);
  });

  it(`the ${SECTION}24 child-instance launcher item says the child's flow is bound at Start`, () => {
    expect(lower(childLauncherItem())).toContain('bound at start');
  });

  it(`the ${SECTION}6 flow:openChild row's shape version has a changelog entry citing ${SECTION}23.2 or D63`, () => {
    const shape = /shape v(\d+\.\d+)/.exec(openChildRow());
    expect(shape, 'the flow:openChild row carries no "shape vX.Y" prefix').not.toBeNull();
    const version = (shape as RegExpExecArray)[1];
    const entry = changelogEntries().find((e) => e.startsWith(`**Changelog v${version}:**`));
    expect(entry, `no **Changelog v${version}:** entry for the flow:openChild row's shape`).toBeDefined();
    const text = entry ?? '';
    expect(
      text.includes(`${SECTION}23.2`) || text.includes('D63'),
      `the v${version} changelog entry cites neither ${SECTION}23.2 nor D63`,
    ).toBe(true);
    expect(text, `the v${version} changelog entry does not describe the flow:openChild change`).toContain(
      '`flow:openChild`',
    );
  });

  it(`${REQUIREMENTS} records D63 superseding D22's flow-state seeding`, () => {
    const paragraphs = read(REQUIREMENTS).split(/\n\s*\n/);
    const d63 = paragraphs.filter((p) => p.trimStart().startsWith('**[D63 · 2026-09-29]'));
    expect(d63, `no single [D63 · 2026-09-29] entry in ${REQUIREMENTS}`).toHaveLength(1);
    expect(d63[0]).toContain('D22');
    expect(lower(d63[0])).toContain('supersede');
  });

  it(`${REQUIREMENTS}'s D18, which ${SECTION}23.2 still cites, is annotated as superseded by D63`, () => {
    const paragraphs = read(REQUIREMENTS).split(/\n\s*\n/);
    const d18 = paragraphs.filter((p) => p.trimStart().startsWith('**[D18 · 2026-06-16]'));
    expect(d18, `no single [D18 · 2026-06-16] entry in ${REQUIREMENTS}`).toHaveLength(1);
    expect(d18[0], `D18 still reads as the child running the parent's flow (${RULE})`).toMatch(
      /superseded by D63/i,
    );
  });
});

const themeASliceList = (): string[] => sectionOf(DESIGN, '4.4').split('\n');
const SLICE_ENTRY = /^- \*\*A\d+/;
const A1_CATALOG_SEED = /A1 must seed (the catalog )?through the app-state resolver|seeds the user-config `flows\/` catalog/g;

describe(`#167 — the design doc plans no pickup seeding or ticket-borne flow stamp (AC 7)`, () => {
  const NEEDLES = [
    join2('pickup ', 'seeding'),
    join2('pickup ', 'stamp'),
    join2('Selection at ', 'pickup'),
    join2('A1', '–', 'A4'),
    join2('A0', '–', 'A4'),
    join2('A1', '–', 'A5'),
    join2('pointer is ', 'seeded'),
    join2('stamps the chosen ', 'flow'),
    join2('selecting this ', 'flow'),
  ];

  for (const needle of NEEDLES) {
    it(`${DESIGN} does not contain "${needle}"`, () => {
      const hits = read(DESIGN)
        .split('\n')
        .filter((l) => lower(l).includes(lower(needle)));
      expect(hits, `"${needle}" (${RULE}) still in ${DESIGN}:\n${hits.join('\n')}`).toEqual([]);
    });
  }

  it(`${DESIGN} carries no stamp clause`, () => {
    const hits = read(DESIGN).split('\n').filter((l) => /\bstamp/i.test(l));
    expect(hits, `stamp clause (${RULE}) still in ${DESIGN}:\n${hits.join('\n')}`).toEqual([]);
  });

  it(`${DESIGN} plans no seeding beyond A1's catalog install`, () => {
    const hits = read(DESIGN)
      .split('\n')
      .filter((l) => /\bseed/i.test(l.replace(A1_CATALOG_SEED, '')));
    expect(hits, `seed clause (${RULE}) still in ${DESIGN}:\n${hits.join('\n')}`).toEqual([]);
  });

  it(`the design doc's Theme A slice list has no A4 entry`, () => {
    const lines = themeASliceList();
    expect(lines.some((l) => SLICE_ENTRY.test(l)), 'Theme A slice list entries not found').toBe(true);
    const a4 = lines.filter((l) => l.startsWith('- **A4'));
    expect(a4.map((l) => l.slice(0, 120)), `A4 slice entry (${RULE})`).toEqual([]);
  });

  it(`the design doc's Theme A slice list records that A4 was dropped (#135)`, () => {
    const lines = themeASliceList();
    const lastEntry = lines.map((l) => SLICE_ENTRY.test(l)).lastIndexOf(true);
    const notes = lines
      .slice(lastEntry + 1)
      .filter(
        (l) => /\bA4\b/.test(l) && /\bdropped\b/i.test(l) && l.includes('#135') && l.includes(`${SECTION}18.7.5`),
      );
    expect(
      notes,
      `no line after the Theme A slice list says A4 was dropped, citing #135 and ${SECTION}18.7.5 (${RULE})`,
    ).toHaveLength(1);
  });

  it(`the design doc's ${SECTION}4.2 item 4 says the flow is selected at Start and pickup binds the ticket`, () => {
    const item4 = sectionOf(DESIGN, '4.2')
      .split('\n')
      .filter((l) => l.startsWith('4. **'));
    expect(item4, `expected exactly one ${SECTION}4.2 item 4`).toHaveLength(1);
    expect(item4[0], `${SECTION}4.2 item 4 must become "Selection at Start" (${RULE})`).toContain('Selection at Start');
    expect(lower(item4[0]), `${SECTION}4.2 item 4 must say pickup binds the ticket (${RULE})`).toContain(
      'pickup binds the ticket',
    );
  });

  it(`the design doc's header still lists as many divergences as it says it does`, () => {
    const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    const text = read(DESIGN);
    const stated = /\b(\w+) statements below diverge/i.exec(text);
    expect(stated, 'header divergence count not found').not.toBeNull();
    const bullets = text.split('\n').filter((l) => l.startsWith('> - **'));
    expect(bullets.length, `header says "${stated?.[0]}"`).toBe(WORDS.indexOf(lower(stated?.[1] ?? '')));
  });

  it(`the design doc's B5 epic-path entry says each sub-ticket's flow is picked at Start`, () => {
    const b5 = sectionOf(DESIGN, '5.7')
      .split('\n')
      .filter((l) => l.startsWith('- **B5 —'));
    expect(b5, 'expected exactly one B5 entry in the Theme B slice list').toHaveLength(1);
    expect(b5[0], `B5 must say each sub-ticket's flow is picked at Start (${RULE})`).toMatch(
      /\bpick(?:s|ed)? at Start\b/,
    );
    expect(b5[0], `B5 must not tie the flow to pickup (${RULE})`).not.toMatch(/\bpickup\b/i);
  });
});
