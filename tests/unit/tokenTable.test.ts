// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { createTokenTable } from '../../src/renderer/src/tokenTable';
import type { FlowTokensView } from '../../src/shared/ipc';
import { KIND_HEADERS, RUN_TOTAL_ROW, accessibleTextOf, tokenCellIn, tokenTableIn } from '../helpers/tokenCountsUi';
import { assertRendersFromHostDocument } from './relocatable';

afterEach(() => document.body.replaceChildren());

type StepCounts = Extract<NonNullable<FlowTokensView['steps'][number]>, { state: 'counted' }>;
type Kind = keyof typeof KIND_HEADERS;
const KINDS = Object.keys(KIND_HEADERS) as Kind[];

const kinds = (cacheRead: number, cacheWrite: number, input: number, output: number): StepCounts['kinds'] => ({
  cacheRead: { reported: 'all', n: cacheRead },
  cacheWrite: { reported: 'all', n: cacheWrite },
  input: { reported: 'all', n: input },
  output: { reported: 'all', n: output },
});
const step = (cacheRead: number, cacheWrite: number, input: number, output: number, billed = true): StepCounts => ({
  state: 'counted',
  billed,
  kinds: kinds(cacheRead, cacheWrite, input, output),
});
const run = (cacheRead: number, cacheWrite: number, input: number, output: number): FlowTokensView['run'] => ({
  state: 'counted',
  someStepsUnavailable: false,
  kinds: kinds(cacheRead, cacheWrite, input, output),
});

const PLAN = step(812_345, 12_006, 307, 45);
const BUILD = step(4_000_271, 450_018, 40_302, 10_049);
const IDLE = step(0, 0, 0, 0, false);
const STEPS = ['plan', 'build', 'ship'];

function mount(tokens: FlowTokensView, steps: string[] = STEPS) {
  const host = document.createElement('section');
  document.body.append(host);
  const table = createTokenTable(host);
  table.update({ steps, tokens });
  return { host, table };
}

const text = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
const row = (root: ParentNode, name: string): string[] => KINDS.map((kind) => text(tokenCellIn(root, name, kind)));

it('names a column for each kind and a row for each step and the run total, and shows each count in exact digits', () => {
  const { host } = mount({ steps: [PLAN, BUILD, null], counting: null, run: run(4_812_616, 462_024, 40_609, 10_094) });
  expect({ plan: row(host, 'plan'), build: row(host, 'build'), run: row(host, RUN_TOTAL_ROW) }).toEqual({
    plan: ['812,345', '12,006', '307', '45'],
    build: ['4,000,271', '450,018', '40,302', '10,049'],
    run: ['4,812,616', '462,024', '40,609', '10,094'],
  });
});

it('shows a dash in every cell of a step not entered, and 0 for an entered step that billed nothing', () => {
  const { host } = mount({ steps: [PLAN, IDLE, null], counting: 1, run: run(812_345, 12_006, 307, 45) });
  expect({ build: row(host, 'build'), ship: row(host, 'ship') }).toEqual({
    build: ['0 counting', '0 counting', '0 counting', '0 counting'],
    ship: ['—', '—', '—', '—'],
  });
});

it('marks every cell of the open step counting, and no other row', () => {
  const { host } = mount({ steps: [PLAN, BUILD, null], counting: 1, run: run(4_812_616, 462_024, 40_609, 10_094) });
  expect({ plan: row(host, 'plan'), build: row(host, 'build'), run: row(host, RUN_TOTAL_ROW) }).toEqual({
    plan: ['812,345', '12,006', '307', '45'],
    build: ['4,000,271 counting', '450,018 counting', '40,302 counting', '10,049 counting'],
    run: ['4,812,616', '462,024', '40,609', '10,094'],
  });
});

it('shows a kind no call reported as not reported, and a partly reported cell with its figure marked, in each cell\'s accessible text', () => {
  const notReported: StepCounts = { ...step(9_000, 0, 140, 260), kinds: { ...kinds(9_000, 0, 140, 260), cacheWrite: { reported: 'none' } } };
  const partly: StepCounts = { ...step(8_000, 0, 85, 150), kinds: { ...kinds(8_000, 0, 85, 150), cacheWrite: { reported: 'some', n: 400 } } };
  const total: FlowTokensView['run'] = { state: 'counted', someStepsUnavailable: false, kinds: { ...kinds(17_000, 0, 225, 410), cacheWrite: { reported: 'some', n: 400 } } };
  const { host } = mount({ steps: [notReported, partly, null], counting: 1, run: total });
  const accessible = (name: string): string[] => KINDS.map((kind) => accessibleTextOf(tokenCellIn(host, name, kind)));

  expect({ plan: accessible('plan'), build: accessible('build'), run: accessible(RUN_TOTAL_ROW), visibleBuild: row(host, 'build') }).toEqual({
    plan: ['9,000', 'not reported', '140', '260'],
    build: ['8,000 counting', '400 partly reported counting', '85 counting', '150 counting'],
    run: ['17,000', '400 partly reported', '225', '410'],
    visibleBuild: ['8,000 counting', '400 partly reported counting', '85 counting', '150 counting'],
  });
});

it('shows an unavailable step as unavailable in every cell, and the run total row incomplete, each in its cell\'s accessible text', () => {
  const notReported: StepCounts = { ...step(9_000, 0, 140, 260), kinds: { ...kinds(9_000, 0, 140, 260), cacheWrite: { reported: 'none' } } };
  const total: FlowTokensView['run'] = { state: 'counted', someStepsUnavailable: true, kinds: { ...kinds(29_000, 0, 440, 690), cacheWrite: { reported: 'some', n: 1_200 } } };
  const { host } = mount({ steps: [notReported, { state: 'unavailable' }, null], counting: 1, run: total });
  const accessible = (name: string): string[] => KINDS.map((kind) => accessibleTextOf(tokenCellIn(host, name, kind)));

  expect({ build: accessible('build'), ship: row(host, 'ship'), run: accessible(RUN_TOTAL_ROW), visibleRun: row(host, RUN_TOTAL_ROW) }).toEqual({
    build: ['unavailable counting', 'unavailable counting', 'unavailable counting', 'unavailable counting'],
    ship: ['—', '—', '—', '—'],
    run: ['29,000 incomplete', '1,200 partly reported incomplete', '440 incomplete', '690 incomplete'],
    visibleRun: ['29,000 incomplete', '1,200 partly reported incomplete', '440 incomplete', '690 incomplete'],
  });
});

it('reads a run total cell whose countable steps reported none of its kind not reported, marked incomplete', () => {
  const notReported: StepCounts = { ...step(9_000, 0, 140, 260), kinds: { ...kinds(9_000, 0, 140, 260), cacheWrite: { reported: 'none' } } };
  const total: FlowTokensView['run'] = { state: 'counted', someStepsUnavailable: true, kinds: notReported.kinds };
  const { host } = mount({ steps: [notReported, { state: 'unavailable' }, null], counting: null, run: total });
  expect(accessibleTextOf(tokenCellIn(host, RUN_TOTAL_ROW, 'cacheWrite'))).toBe('not reported incomplete');
});

it('shows unavailable in every run total cell when no entered step can be counted', () => {
  const { host } = mount({ steps: [{ state: 'unavailable' }, { state: 'unavailable' }, null], counting: 1, run: { state: 'unavailable' } });
  expect({ plan: row(host, 'plan'), run: row(host, RUN_TOTAL_ROW) }).toEqual({
    plan: ['unavailable', 'unavailable', 'unavailable', 'unavailable'],
    run: ['unavailable', 'unavailable', 'unavailable', 'unavailable'],
  });
});

it('shows dashes in the run total row while no step is entered', () => {
  const { host } = mount({ steps: [null, null, null], counting: null, run: null });
  expect(row(host, RUN_TOTAL_ROW)).toEqual(['—', '—', '—', '—']);
});

it('an update that changes only the counts changes the values in the cells already shown', () => {
  const { host, table } = mount({ steps: [PLAN, IDLE, null], counting: 1, run: run(812_345, 12_006, 307, 45) });
  const before = { build: tokenCellIn(host, 'build', 'output'), run: tokenCellIn(host, RUN_TOTAL_ROW, 'cacheRead') };

  table.update({ steps: STEPS, tokens: { steps: [PLAN, BUILD, IDLE], counting: 2, run: run(4_812_616, 462_024, 40_609, 10_094) } });

  expect({
    sameCells: tokenCellIn(host, 'build', 'output') === before.build && tokenCellIn(host, RUN_TOTAL_ROW, 'cacheRead') === before.run,
    build: row(host, 'build'),
    ship: row(host, 'ship'),
    run: row(host, RUN_TOTAL_ROW),
  }).toEqual({
    sameCells: true,
    build: ['4,000,271', '450,018', '40,302', '10,049'],
    ship: ['0 counting', '0 counting', '0 counting', '0 counting'],
    run: ['4,812,616', '462,024', '40,609', '10,094'],
  });
});

it('an update naming other steps shows a row for each of them in place of the old ones', () => {
  const { host, table } = mount({ steps: [PLAN, null, null], counting: 0, run: run(812_345, 12_006, 307, 45) });
  table.update({ steps: ['groom', 'red'], tokens: { steps: [BUILD, null], counting: 0, run: run(4_000_271, 450_018, 40_302, 10_049) } });
  expect({ groom: row(host, 'groom'), red: row(host, 'red') }).toEqual({
    groom: ['4,000,271 counting', '450,018 counting', '40,302 counting', '10,049 counting'],
    red: ['—', '—', '—', '—'],
  });
  expect(() => tokenCellIn(host, 'plan', 'output')).toThrow(/"plan" row header/);
});

it('has a header row, a row per step and a run total row', () => {
  const { host } = mount({ steps: [PLAN, null, null], counting: 0, run: run(812_345, 12_006, 307, 45) });
  expect(tokenTableIn(host).rows).toHaveLength(STEPS.length + 2);
});

it('removes what it rendered when disposed', () => {
  const { host, table } = mount({ steps: [PLAN, null, null], counting: 0, run: run(812_345, 12_006, 307, 45) });
  table.dispose();
  expect(host.childElementCount).toBe(0);
});

it('builds from host.ownerDocument, not the global document (UI-STANDARDS §3.3)', async () => {
  await assertRendersFromHostDocument((h) => createTokenTable(h).update({ steps: STEPS, tokens: { steps: [PLAN, null, null], counting: 0, run: null } }));
});
