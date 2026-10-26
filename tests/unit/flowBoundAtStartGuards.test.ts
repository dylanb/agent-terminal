import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const RULE = `retired by §18.7.5 / D63, #167`;
const SPEC_DIR = 'docs/spec';
const CH06 = join(SPEC_DIR, '06-ipc-contract.md');
const CH18 = join(SPEC_DIR, '18-flow-definitions-flow-yaml.md');
const CH23 = join(SPEC_DIR, '23-multi-instance-and-epics.md');
const CH24 = join(SPEC_DIR, '24-build-plan-ui-inwards.md');
const ROOT_SPEC = 'terminal-web-ui-spec.md';
const REQUIREMENTS = 'flow-management-requirements.md';

const read = (f: string): string => readFileSync(f, 'utf8');
const lower = (s: string): string => s.toLowerCase();
const headingPattern = (num: string, after: string): RegExp =>
  new RegExp(`^(#{1,6})\\s+${num.replace(/\./g, '\\.')}${after}`);

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
  expect(body.length, `${file} §${num} body not found`).toBeGreaterThan(0);
  return body;
}

const specFilesExceptChangelog = (): string[] =>
  readdirSync(SPEC_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'changelog.md')
    .map((f) => join(SPEC_DIR, f))
    .concat(ROOT_SPEC);

describe(`#167 — no §18 / spec clause requires or plans pickup seeding or a ticket-borne stamp (AC 3)`, () => {
  const NEEDLES = [
    'Pickup seeding (A4)',
    'stamps the chosen selection',
    "A4's seed",
    'A4 seeds',
    'A4 seed',
    'pickup-seeded',
    'stampless',
    'seed-write',
    'trusted-seed',
    'pick/seed',
    'A1–A4',
    'A0–A4',
    'pickup seeding',
    'seed the pointer',
  ];

  for (const needle of NEEDLES) {
    it(`no spec file outside the changelog contains "${needle}"`, () => {
      const offenders = specFilesExceptChangelog().filter((f) => lower(read(f)).includes(lower(needle)));
      expect(offenders, `"${needle}" (${RULE}) still in:\n${offenders.join('\n')}`).toEqual([]);
    });
  }

  it(`§18.7 carries no stamp clause`, () => {
    const hits = sectionOf(CH18, '18.7').split('\n').filter((l) => /\bstamp/i.test(l));
    expect(hits, `stamp clause (${RULE}) still in §18.7:\n${hits.join('\n')}`).toEqual([]);
  });
});

describe(`#167 — §18.7.1–§18.7.7 keep their numbers and subjects (AC 5)`, () => {
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
      expect(i, `§${num} heading missing`).toBeGreaterThanOrEqual(0);
      expect(lower(lines[i]), `§${num} heading lost its subject "${subject}"`).toContain(subject);
      return i;
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe(`#167 — §18.7.5 states the flow is bound at Start (AC 3)`, () => {
  it(`§18.7.5 states the rule and that a ticket is untrusted input`, () => {
    const body = lower(sectionOf(CH18, '18.7.5'));
    expect(body).toContain('bound at start');
    expect(body).toContain('pickup binds the ticket');
    expect(body).toContain('untrusted');
    expect(body).toContain('never select the flow');
    expect(
      body.indexOf('bound at start'),
      `§18.7.5 must state Start's binding before pickup's`,
    ).toBeLessThan(body.indexOf('pickup binds the ticket'));
  });

  it(`§18.7.5 carries no seed clause beyond its one historical mention`, () => {
    const hits = sectionOf(CH18, '18.7.5')
      .split('\n')
      .filter((l) => /seed/i.test(l.replace(new RegExp('pickup-seeding clause', 'gi'), '')));
    expect(hits, `seed clause (${RULE}) still in §18.7.5:\n${hits.join('\n')}`).toEqual([]);
  });

});

describe(`#167 — §18.7.6's shared gates survive without seeding (AC 4)`, () => {
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
    expect(preamble.length, `§18.7.6 preamble not found`).toBeGreaterThan(0);
    expect(preamble).toContain('regardless of provenance');
  });

  for (const needles of GATES) {
    it(`exactly one §18.7.6 bullet is the "${needles[0]}" gate`, () => {
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
    expect(bullets.length, `§18.7.6 bullets not found`).toBeGreaterThan(0);
    for (const lead of ['Structured travel on the seed-write', 'Argument-safe seed-write']) {
      expect(bullets.filter((b) => b.includes(lead)), `"${lead}" (${RULE})`).toEqual([]);
    }
  });

  it('no surviving unit, the preamble included, justifies itself by A4 or seeding', () => {
    const { preamble, bullets } = units();
    expect(preamble.length, `§18.7.6 preamble not found`).toBeGreaterThan(0);
    expect(bullets.length, `§18.7.6 bullets not found`).toBeGreaterThan(0);
    const offenders = [preamble, ...bullets].filter((u) => /A4/.test(u) || /seed/i.test(u));
    expect(offenders.map((u) => u.slice(0, 120)), RULE).toEqual([]);
  });
});

const ch23Body = (): string => sectionOf(CH23, '23.2');
const sentences = (text: string): string[] => text.split(/(?<=[.!?])\s+/);

describe(`#167 — no §6 / §23 / §24 clause seeds a child's flow selection or flow-state (AC 6)`, () => {
  const NEEDLES = [
    "seeding that worktree's flow-state",
    'seeding its flow-state',
    'seeds the expected',
  ];

  for (const needle of NEEDLES) {
    it(`no §6 / §23 / §24 chapter contains "${needle}"`, () => {
      const offenders = [CH06, CH23, CH24].filter((f) => lower(read(f)).includes(lower(needle)));
      expect(offenders, `"${needle}" (${RULE}) still in:\n${offenders.join('\n')}`).toEqual([]);
    });
  }

  it(`the §23.2 body uses no form of "seed"`, () => {
    expect(ch23Body(), `seed clause (${RULE}) still in §23.2`).not.toMatch(/seed/i);
  });
});

describe(`#167 — epic child worktrees are bound at Start too (AC 6)`, () => {
  it(`no sentence of §23.2 cites D22 as authority for seeding`, () => {
    const offenders = sentences(ch23Body()).filter((s) => s.includes('D22') && /seed/i.test(s));
    expect(offenders, `D22 cited for seeding (${RULE}):\n${offenders.join('\n')}`).toEqual([]);
  });

  it(`§23.2 states the child's flow is bound at Start and its run begins where an ordinary Start begins`, () => {
    const body = lower(ch23Body());
    expect(body).toContain('bound at start');
    expect(body).toContain('where an ordinary start');
  });

  it(`§23.2 states the app does not set the child worktree's flow selection or flow-state`, () => {
    expect(lower(ch23Body()), RULE).toContain("does not set that worktree's flow selection or flow-state");
  });

  it(`§23.2 no longer says the child runs the parent's flow`, () => {
    expect(lower(ch23Body()), RULE).not.toContain('all steps of the flow run on each pr');
  });

  it(`${REQUIREMENTS} records D63 superseding D22's flow-state seeding`, () => {
    const paragraphs = read(REQUIREMENTS).split(/\n\s*\n/);
    const d63 = paragraphs.filter((p) => p.trimStart().startsWith('**[D63 · 2026-09-29]'));
    expect(d63, `no single [D63 · 2026-09-29] entry in ${REQUIREMENTS}`).toHaveLength(1);
    expect(d63[0]).toContain('D22');
    expect(lower(d63[0])).toContain('supersede');
  });

  it(`${REQUIREMENTS}'s D18, which §23.2 still cites, is annotated as superseded by D63`, () => {
    const paragraphs = read(REQUIREMENTS).split(/\n\s*\n/);
    const d18 = paragraphs.filter((p) => p.trimStart().startsWith('**[D18 · 2026-06-16]'));
    expect(d18, `no single [D18 · 2026-06-16] entry in ${REQUIREMENTS}`).toHaveLength(1);
    expect(d18[0], `D18 still reads as the child running the parent's flow (${RULE})`).toMatch(
      /superseded by D63/i,
    );
  });
});
