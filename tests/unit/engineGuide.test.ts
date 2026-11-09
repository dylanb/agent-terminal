import { describe, expect, it } from 'vitest';
import { renderEngineGuide } from '../../src/main/engineGuide';
import { ENGINE_CAPABILITIES, type EngineCapabilities } from '../../src/shared/engineCapabilities';
import { TURN_DONE_FILENAME, completionMarker } from '../../src/shared/loopTurn';
import {
  CLOSED_SETS,
  CROSS_FIELD_RULES,
  LOOKUP_ORDER,
  LOOP_CAPABILITIES_KEYS,
  LOOP_LAYOUT,
  LOOP_NAMESPACE_RUNS_ENGINE,
  NAMED_BOUNDARIES,
  NOT_CHECKED_AT_LOAD,
  OPEN_SETS,
  POSITIONS,
  SIDE_EFFECT_ARGS,
  SLOT_EXPANDING,
  SLOT_REJECTING,
  SECTIONS,
  TIER_PATH_FRAGMENTS,
  TIER_SETTINGS,
  TURN_KINDS,
  turnKeyLayout,
  type Definition,
  type OpenSet,
  type PositionId,
  type PositionKey,
} from '../helpers/engineCapabilityOracle';
import { codeSpans, guideHeadings, guideTocLinks, listEntries, sectionBody, subHeadings } from '../helpers/markdownGuide';
import { argHeading, composedShape, entryFor, headingTitled, intro, keyHeading, positionHeading, turnContractParts } from '../helpers/guideSections';
import { descriptorArg, descriptorKey, descriptorOpenSet } from '../helpers/descriptorEntries';
import { MAX_SLICES } from '../../src/shared/engineCapabilities/flow';
import { GOAL_CONDITION_MAX_CHARS } from '../../src/shared/engineCapabilities/loop';

const GUIDE = renderEngineGuide(ENGINE_CAPABILITIES);
const OPEN_SET_LIST: readonly OpenSet[] = Object.values(OPEN_SETS);
const positionIds = (d: Definition): PositionId[] => (Object.keys(POSITIONS) as PositionId[]).filter((id) => POSITIONS[id].definition === d);
const ofDefinition = (d: Definition) => (s: { position: PositionId }) => POSITIONS[s.position].definition === d;

/** `text` when it is non-empty, otherwise a problem is recorded and undefined returned. */
function nonEmpty(problems: string[], what: string, text: string | undefined): string | undefined {
  if (text === undefined || text.trim() === '') {
    problems.push(`${what}: the descriptor gives no text`);
    return undefined;
  }
  return text;
}

/** Records a problem for each marker other than `own` that `text` carries, unless `own` itself contains it. */
function expectOnlyMarker(problems: string[], what: string, text: string, own: string | undefined, others: readonly string[]): void {
  for (const other of others) {
    if (other !== '' && !(own ?? '').includes(other) && text.includes(other)) problems.push(`${what}: carries the other marker ${JSON.stringify(other)}`);
  }
}

function expectIncludes(problems: string[], what: string, haystack: string, needle: string | undefined): void {
  if (needle !== undefined && !haystack.includes(needle)) problems.push(`${what}: the guide does not carry ${JSON.stringify(needle)}`);
}

describe('the engine guide — table of contents (#276)', () => {
  it('has a table of contents whose every entry links to a heading, and lists every heading after it', () => {
    const headings = guideHeadings(GUIDE);
    const links = guideTocLinks(GUIDE);
    const tocLine = GUIDE.split('\n').findIndex((l) => l.includes('](#'));
    const anchors = new Set(headings.map((h) => h.anchor));
    const linked = new Set(links.map((l) => l.anchor));
    const problems = [
      ...(links.length === 0 ? ['the guide has no table of contents'] : []),
      ...links.filter((l) => !anchors.has(l.anchor)).map((l) => `TOC entry #${l.anchor} links to no heading`),
      ...headings.filter((h) => h.line > tocLine && !linked.has(h.anchor)).map((h) => `heading "${h.text}" has no TOC entry`),
    ];
    expect(problems).toEqual([]);
  });

  it('gives each section a heading of its own, linked from the table of contents', () => {
    const linked = new Set(guideTocLinks(GUIDE).map((l) => l.anchor));
    const problems: string[] = [];
    for (const section of SECTIONS) {
      const what = section.kind === 'position' ? section.position : section.kind;
      const title = (ENGINE_CAPABILITIES.sectionTitles as Readonly<Record<string, string | undefined>>)[section.kind];
      const heading = section.kind === 'position' ? positionHeading(GUIDE, section.position) : headingTitled(GUIDE, title ?? '');
      if (heading === undefined) problems.push(`${what}: no heading`);
      else if (!linked.has(heading.anchor)) problems.push(`${what}: its heading has no TOC entry`);
    }
    expect(problems).toEqual([]);
  });
});

describe.each(['flow', 'loop'] as const)('the engine guide — %s-definition values (#276)', (definition) => {
  it('lists every value of each closed set under its key, with what it does and when to choose it', () => {
    const problems: string[] = [];
    for (const set of CLOSED_SETS.filter(ofDefinition(definition))) {
      const where = `${set.position} ${set.key}`;
      const key = descriptorKey(ENGINE_CAPABILITIES, set.position, set.key);
      const heading = keyHeading(GUIDE, set.position, set.key);
      if (key?.values.kind !== 'closed') problems.push(`${where}: the descriptor holds no closed set`);
      if (heading === undefined) problems.push(`${where}: no heading`);
      const entries = heading === undefined ? [] : listEntries(sectionBody(GUIDE, heading));
      for (const value of set.values) {
        const doc = key?.values.kind === 'closed' ? key.values.values.find((v) => v.value === value) : undefined;
        const at = `${where} ${String(value)}`;
        const does = nonEmpty(problems, `${at} does`, doc?.does);
        const when = nonEmpty(problems, `${at} when`, doc?.when);
        const entry = entries.find((e) => e.code === String(value));
        if (entry === undefined) {
          problems.push(`${at}: no entry`);
          continue;
        }
        expectIncludes(problems, at, entry.text, does);
        expectIncludes(problems, at, entry.text, when);
      }
    }
    expect(problems).toEqual([]);
  });

  it('documents every key a position reads, with what it does, whether it is required, and its cross-field rules', () => {
    const problems: string[] = [];
    for (const id of positionIds(definition)) {
      for (const [key, required] of Object.entries(POSITIONS[id].keys)) {
        const where = `${id} ${key}`;
        const doc = descriptorKey(ENGINE_CAPABILITIES, id, key);
        const heading = keyHeading(GUIDE, id, key);
        if (doc === undefined) problems.push(`${where}: not in the descriptor`);
        if (heading === undefined) {
          problems.push(`${where}: no heading`);
          continue;
        }
        const body = intro(GUIDE, heading);
        const markers = ENGINE_CAPABILITIES.markers.required;
        const marker = nonEmpty(problems, `${required} marker`, markers[required]);
        expectIncludes(problems, `${where} does`, body, nonEmpty(problems, `${where} does`, doc?.does));
        expectIncludes(problems, `${where} when`, body, nonEmpty(problems, `${where} when`, doc?.when));
        expectIncludes(problems, `${where} required`, body, marker);
        expectOnlyMarker(problems, `${where} required`, body, marker, Object.values(markers));
        if (required === 'conditional') {
          const condition = doc?.required.kind === 'conditional' ? doc.required.condition : undefined;
          expectIncludes(problems, `${where} condition`, body, nonEmpty(problems, `${where} condition`, condition));
        }
        for (const rule of CROSS_FIELD_RULES.filter((r) => ofDefinition(definition)(r) && r.position === id && r.key === key)) {
          const text = doc?.rules.find((r) => r.id === rule.rule)?.text;
          expectIncludes(problems, `${where} ${rule.rule}`, body, nonEmpty(problems, `${where} ${rule.rule}`, text));
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('states for each position whether a key the loader does not read is rejected or ignored', () => {
    const problems: string[] = [];
    for (const id of positionIds(definition)) {
      const mode = POSITIONS[id].unreadKeys;
      const heading = positionHeading(GUIDE, id);
      const marker = nonEmpty(problems, `${mode} marker`, ENGINE_CAPABILITIES.markers.unreadKeys[mode]);
      if (heading === undefined) {
        problems.push(`${id}: no heading`);
        continue;
      }
      expectIncludes(problems, `${id} unread keys`, intro(GUIDE, heading), marker);
      expectOnlyMarker(problems, `${id} unread keys`, intro(GUIDE, heading), marker, Object.values(ENGINE_CAPABILITIES.markers.unreadKeys));
    }
    expect(problems).toEqual([]);
  });

  it('lists every name the engine acts on for each open set, with what it does and when, and what it does with any other name', () => {
    const problems: string[] = [];
    for (const set of OPEN_SET_LIST.filter(ofDefinition(definition))) {
      const where = set.argOf === undefined ? `${set.position} ${set.key}` : `${set.position} ${set.argOf} ${set.key}`;
      const values = descriptorOpenSet(ENGINE_CAPABILITIES, set);
      const open = values?.kind === 'open' ? values : undefined;
      const heading = set.argOf === undefined ? keyHeading(GUIDE, set.position, set.key) : argHeading(GUIDE, set.position, set.argOf, set.key);
      if (open === undefined) problems.push(`${where}: the descriptor holds no open set`);
      if (heading === undefined) problems.push(`${where}: no heading`);
      const body = heading === undefined ? '' : sectionBody(GUIDE, heading);
      const entries = listEntries(body);
      for (const name of set.acted) {
        const named = open?.acted.find((a) => a.name === name);
        const does = nonEmpty(problems, `${where} ${name} does`, named?.does);
        const when = nonEmpty(problems, `${where} ${name} when`, named?.when);
        const entry = entries.find((e) => e.code === name);
        if (entry === undefined) {
          problems.push(`${where} ${name}: no entry`);
          continue;
        }
        expectIncludes(problems, `${where} ${name}`, entry.text, does);
        expectIncludes(problems, `${where} ${name}`, entry.text, when);
      }
      expectIncludes(problems, `${where} other names`, body, nonEmpty(problems, `${where} other names`, open?.otherNames));
      for (const name of set.loadRejected) if (!codeSpans(body).includes(name)) problems.push(`${where}: does not name the load-rejected ${name}`);
    }
    expect(problems).toEqual([]);
  });
});

describe('the engine guide — loop_namespace engines and run-time outcomes (#276)', () => {
  it('marks each loop_namespace value with whether it selects an engine that runs the step', () => {
    const { yes, no } = ENGINE_CAPABILITIES.markers.selectsEngine;
    const problems: string[] = [];
    const runs = nonEmpty(problems, 'selects-engine marker', yes);
    const none = nonEmpty(problems, 'selects-no-engine marker', no);
    const heading = keyHeading(GUIDE, 'flow.steps[]', 'loop_namespace');
    const entries = heading === undefined ? [] : listEntries(sectionBody(GUIDE, heading));
    for (const [value, runsEngine] of Object.entries(LOOP_NAMESPACE_RUNS_ENGINE)) {
      const entry = entries.find((e) => e.code === value);
      if (entry === undefined) {
        problems.push(`loop_namespace ${value}: no entry`);
        continue;
      }
      const [carries, lacks] = runsEngine ? [runs, none] : [none, runs];
      expectIncludes(problems, `loop_namespace ${value}`, entry.text, carries);
      expectOnlyMarker(problems, `loop_namespace ${value}`, entry.text, carries, lacks === undefined ? [] : [lacks]);
    }
    expect(problems).toEqual([]);
  });

  it('says which keys are not checked at load, with each run-time outcome and the engine cap', () => {
    const problems: string[] = [];
    for (const { position, key, cases, capCase } of NOT_CHECKED_AT_LOAD) {
      const where = `${position} ${key}`;
      const doc = descriptorKey(ENGINE_CAPABILITIES, position, key);
      const outcomes = doc?.values.kind === 'not-checked-at-load' ? doc.values.outcomes : [];
      const listed = outcomes.map((o) => o.case).sort();
      if (JSON.stringify(listed) !== JSON.stringify([...cases].sort())) problems.push(`${where}: the descriptor's outcome cases are ${JSON.stringify(listed)}, not ${JSON.stringify([...cases].sort())}`);
      const capText = outcomes.find((o) => o.case === capCase)?.text ?? '';
      if (!capText.includes(String(MAX_SLICES))) problems.push(`${where}: the ${capCase} outcome does not name the cap ${MAX_SLICES}`);
      const heading = keyHeading(GUIDE, position, key);
      if (heading === undefined) {
        problems.push(`${where}: no heading`);
        continue;
      }
      const body = sectionBody(GUIDE, heading);
      expectIncludes(problems, `${where} not checked`, body, nonEmpty(problems, 'not-checked marker', ENGINE_CAPABILITIES.markers.notCheckedAtLoad));
      for (const c of cases) expectIncludes(problems, `${where} ${c} outcome`, body, nonEmpty(problems, `${where} ${c} outcome text`, outcomes.find((o) => o.case === c)?.text ?? ''));
    }
    expect(problems).toEqual([]);
  });
});

describe('the engine guide — side-effect args and the work goal cap (#276)', () => {
  it('documents each arg the engine reads beside a side-effect kind, with what it does and when', () => {
    const { position } = OPEN_SETS.sideEffectKind;
    const problems: string[] = [];
    for (const [kind, args] of Object.entries(SIDE_EFFECT_ARGS)) {
      for (const arg of args) {
        const where = `${kind} ${arg}`;
        const doc = descriptorArg(ENGINE_CAPABILITIES, position, kind, arg);
        const does = nonEmpty(problems, `${where} does`, doc?.does);
        const when = nonEmpty(problems, `${where} when`, doc?.when);
        const heading = argHeading(GUIDE, position, kind, arg);
        if (heading === undefined) {
          problems.push(`${where}: no heading`);
          continue;
        }
        expectIncludes(problems, `${where} does`, intro(GUIDE, heading), does);
        expectIncludes(problems, `${where} when`, intro(GUIDE, heading), when);
      }
    }
    expect(problems).toEqual([]);
  });

  it('states the engine’s cap on a work goal’s length under the goal key', () => {
    const heading = keyHeading(GUIDE, 'loop.work', 'goal');
    expect({
      heading: heading !== undefined,
      namesCap: heading !== undefined && sectionBody(GUIDE, heading).includes(String(GOAL_CONDITION_MAX_CHARS)),
    }).toEqual({ heading: true, namesCap: true });
  });
});

describe('the engine guide — boundary names (#276)', () => {
  it('names under the boundary key every boundary name the engine looks up', () => {
    const heading = keyHeading(GUIDE, 'loop.boundaries[]', 'boundary');
    const spans = heading === undefined ? [] : codeSpans(intro(GUIDE, heading));
    expect({ heading: heading !== undefined, missing: NAMED_BOUNDARIES.filter((n) => !spans.includes(n)) }).toEqual({ heading: true, missing: [] });
  });
});

describe('the engine guide — where things live and the lookup order (#276)', () => {
  it('names where flows and loops live in each tier, with the setting that relocates each', () => {
    const heading = headingTitled(GUIDE, ENGINE_CAPABILITIES.sectionTitles['where-things-live']);
    const body = heading === undefined ? '' : sectionBody(GUIDE, heading);
    const [before, between, after] = LOOP_LAYOUT.defRelPath('\u0000').split('\u0000');
    const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const loopLayout = new RegExp(`(?:^|[\\s\`/])${escape(before)}([^\\s\`/]+)${escape(between)}\\1${escape(after)}`);
    expect({
      section: heading !== undefined,
      missing: [...TIER_PATH_FRAGMENTS, ...TIER_SETTINGS].filter((f) => !body.includes(f)),
      loopLayout: loopLayout.test(body),
    }).toEqual({ section: true, missing: [], loopLayout: true });
  });

  it('lists the tiers in the order the engine resolves a loop name', () => {
    const heading = headingTitled(GUIDE, ENGINE_CAPABILITIES.sectionTitles['lookup-order']);
    const body = heading === undefined ? '' : sectionBody(GUIDE, heading);
    const problems: string[] = heading === undefined ? ['no lookup-order heading'] : [];
    let last = -1;
    for (const tier of LOOKUP_ORDER) {
      const text = nonEmpty(problems, tier, ENGINE_CAPABILITIES.lookupOrder.find((t) => t.tier === tier)?.text);
      if (text === undefined) continue;
      const at = body.indexOf(text);
      if (at <= last) problems.push(`${tier}: not listed after the tier before it`);
      last = Math.max(at, last);
    }
    expect(problems).toEqual([]);
  });

  it('renders a lookup order it is given in the order given, under a heading in the table of contents', () => {
    const caps: EngineCapabilities = {
      ...ENGINE_CAPABILITIES,
      sectionTitles: { ...ENGINE_CAPABILITIES.sectionTitles, 'lookup-order': 'Fixture lookup order' },
      lookupOrder: [
        { tier: 'second', text: 'Fixture tier listed first' },
        { tier: 'first', text: 'Fixture tier listed second' },
      ],
    };
    const md = renderEngineGuide(caps);
    const heading = headingTitled(md, 'Fixture lookup order');
    const body = heading === undefined ? '' : sectionBody(md, heading);
    expect({
      linked: heading !== undefined && guideTocLinks(md).some((l) => l.anchor === heading.anchor),
      first: body.indexOf('Fixture tier listed first') >= 0,
      inOrder: body.indexOf('Fixture tier listed first') < body.indexOf('Fixture tier listed second'),
    }).toEqual({ linked: true, first: true, inOrder: true });
  });
});

describe('the engine guide follows its descriptor (#276)', () => {
  const kindWith = (values: { value: string; does: string; when: string }[]): EngineCapabilities => ({
    ...ENGINE_CAPABILITIES,
    positions: [
      {
        definition: 'flow',
        yamlPath: 'steps[]',
        unreadKeys: 'ignored',
        keys: [
          {
            key: 'kind',
            does: 'Fixture kind does.',
            when: 'Fixture kind when.',
            required: { kind: 'always' },
            rules: [],
            values: { kind: 'closed', values },
          },
        ],
      },
    ],
  });
  const kindEntries = (md: string): Record<string, string> => {
    const heading = keyHeading(md, 'flow.steps[]', 'kind');
    return Object.fromEntries((heading === undefined ? [] : listEntries(sectionBody(md, heading))).map((e) => [e.code, e.text]));
  };

  it('gains, loses and renames a closed-set value when the descriptor does, with no other edit', () => {
    const alpha = { value: 'alpha', does: 'Alpha does.', when: 'Alpha when.' };
    const beta = { value: 'beta', does: 'Beta does.', when: 'Beta when.' };
    const delta = { value: 'delta', does: 'Delta does.', when: 'Delta when.' };
    const before = renderEngineGuide(kindWith([alpha, beta]));
    const after = renderEngineGuide(kindWith([{ ...beta, value: 'gamma' }, delta]));
    const was = kindEntries(before);
    const now = kindEntries(after);
    const withoutEntries = (md: string, entries: Record<string, string>): string =>
      Object.values(entries).reduce((text, entry) => text.replace(entry, ''), md);
    expect({
      before: Object.keys(was).sort(),
      after: Object.keys(now).sort(),
      renamedKeepsItsExplanation: now.gamma?.includes(beta.does) === true && now.gamma.includes(beta.when),
      addedIsExplained: now.delta?.includes(delta.does) === true && now.delta.includes(delta.when),
      restUnchanged: withoutEntries(before, was) === withoutEntries(after, now),
    }).toEqual({
      before: ['alpha', 'beta'],
      after: ['delta', 'gamma'],
      renamedKeepsItsExplanation: true,
      addedIsExplained: true,
      restUnchanged: true,
    });
  });
});

/** Whether `spans` name a definition place: as one path (`work.recipe`, `loop.work.recipe`), or, for a position
 *  that stands for two lists, once per list (`inputs[].path` and `outputs[].path`). */
function namesPlace(spans: readonly string[], { position, key }: PositionKey): boolean {
  const { yamlPath } = POSITIONS[position];
  const paths = (p: string): string[] => (p === '' ? [key, `${position}.${key}`] : [`${p}.${key}`, `loop.${p}.${key}`]);
  const named = (p: string): boolean => paths(p).some((form) => spans.includes(form));
  return named(yamlPath) || yamlPath.split('/').every(named);
}

const TURN_TITLES = { contract: ENGINE_CAPABILITIES.sectionTitles['turn-contract'], composition: ENGINE_CAPABILITIES.sectionTitles['turn-composition'] };

describe('the engine guide — the turn contract (#276)', () => {
  const { contract, composition, fixed } = turnContractParts(GUIDE, TURN_TITLES);
  const spans = codeSpans(fixed);
  /** Each entry of the fixed vocabulary: a list item, or a heading with its intro. */
  const entries = [...listEntries(fixed).map((e) => e.text), ...guideHeadings(fixed).map((h) => `${h.text}\n${intro(fixed, h)}`)];

  it('states the artifact marker line the engine composes', () => {
    const shape = composedShape(completionMarker);
    expect({ section: contract !== undefined, marker: spans.some((s) => shape.test(s)) }).toEqual({ section: true, marker: true });
  });

  it('names the turn-done file and the turn key it must hold for each kind of turn', () => {
    const missing = TURN_KINDS.filter((kind) => !spans.some((s) => composedShape((step) => turnKeyLayout(kind, step)).test(s)));
    expect({ section: contract !== undefined, doneFile: spans.includes(TURN_DONE_FILENAME), missing }).toEqual({ section: true, doneFile: true, missing: [] });
  });

  it('lists every loop-capabilities.yaml key with whether it is required', () => {
    const markers = ENGINE_CAPABILITIES.markers.required;
    const problems: string[] = contract === undefined ? ['no turn-contract section'] : [];
    for (const [key, required] of Object.entries(LOOP_CAPABILITIES_KEYS)) {
      const entry = entryFor(fixed, key);
      if (entry === undefined) {
        problems.push(`${key}: no entry`);
        continue;
      }
      const marker = nonEmpty(problems, `${required} marker`, markers[required]);
      expectIncludes(problems, `${key} required`, entry, marker);
      expectOnlyMarker(problems, `${key} required`, entry, marker, Object.values(markers));
    }
    expect(problems).toEqual([]);
  });

  it('names each slot the engine expands with the place it is expanded, and every place a slot is rejected', () => {
    const problems: string[] = contract === undefined ? ['no turn-contract section'] : [];
    for (const { slot, ...place } of SLOT_EXPANDING) {
      const atPlace = (spans: string[]): boolean => namesPlace(spans, place) || (spans.includes(place.key) && [place.position, POSITIONS[place.position].yamlPath].some((p) => spans.includes(p)));
      if (!entries.some((e) => codeSpans(e).includes(slot) && atPlace(codeSpans(e)))) problems.push(`${slot}: no entry naming it with ${place.position} ${place.key}`);
    }
    for (const place of SLOT_REJECTING) if (!namesPlace(spans, place)) problems.push(`${place.position} ${place.key}: not named as rejecting a slot`);
    expect(problems).toEqual([]);
  });

  it('holds the turn-composition part as its own sub-section, linked from the table of contents, with a body', () => {
    const linked = new Set(guideTocLinks(GUIDE).map((l) => l.anchor));
    expect({
      section: contract !== undefined,
      composition: composition !== undefined,
      linked: composition !== undefined && linked.has(composition.anchor),
      body: composition !== undefined && sectionBody(GUIDE, composition).trim() !== '',
    }).toEqual({ section: true, composition: true, linked: true, body: true });
  });

  it('renders the turn-composition prose it is given under that part’s heading', () => {
    const titles = { contract: 'Fixture turn contract', composition: 'Fixture turn composition' };
    const prose = 'Fixture prose on how turns are composed.';
    const md = renderEngineGuide({
      ...ENGINE_CAPABILITIES,
      sectionTitles: { ...ENGINE_CAPABILITIES.sectionTitles, 'turn-contract': titles.contract, 'turn-composition': titles.composition },
      turnComposition: prose,
    });
    const parts = turnContractParts(md, titles);
    expect({
      composition: parts.composition !== undefined,
      underIt: parts.composition !== undefined && sectionBody(md, parts.composition).includes(prose),
      notInFixed: !parts.fixed.includes(prose),
      subOfContract: parts.contract !== undefined && parts.composition !== undefined && subHeadings(md, parts.contract).some((h) => h.line === parts.composition?.line),
    }).toEqual({ composition: true, underIt: true, notInFixed: true, subOfContract: true });
  });
});

describe('the engine guide — the turn contract’s slot places (#276)', () => {
  it('names a slot-expanding place only in the entry for the slot it expands', () => {
    const { fixed } = turnContractParts(GUIDE, TURN_TITLES);
    const problems = SLOT_EXPANDING.flatMap(({ slot, ...place }) =>
      fixed
        .split('\n')
        .filter((line) => namesPlace(codeSpans(line), place) && !codeSpans(line).includes(slot))
        .map((line) => `${place.position} ${place.key}: named outside its ${slot} entry: ${line}`),
    );
    expect(problems).toEqual([]);
  });
});

describe('the engine guide — a repeat’s two count sources', () => {
  it('makes count_input and count_from each required only when the other is absent, under each key in the guide', () => {
    const conditionUnder = (key: string, other: string): { conditional: boolean; namesOther: boolean; inGuide: boolean } => {
      const doc = descriptorKey(ENGINE_CAPABILITIES, 'flow.steps[].repeat', key);
      const heading = keyHeading(GUIDE, 'flow.steps[].repeat', key);
      const condition = doc?.required.kind === 'conditional' ? doc.required.condition : '';
      return {
        conditional: doc?.required.kind === 'conditional',
        namesOther: condition.includes(other),
        inGuide: heading !== undefined && condition !== '' && intro(GUIDE, heading).includes(condition),
      };
    };
    const holds = { conditional: true, namesOther: true, inGuide: true };
    expect({ count_input: conditionUnder('count_input', 'count_from'), count_from: conditionUnder('count_from', 'count_input') }).toEqual({
      count_input: holds,
      count_from: holds,
    });
  });
});
