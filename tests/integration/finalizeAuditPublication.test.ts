import { describe, expect, it } from 'vitest';
import { publishFlowAudit } from '../../src/main/flowAuditPublication';

const begin = '<!-- agent-terminal:flow-audit:start -->';
const end = '<!-- agent-terminal:flow-audit:end -->';
const original = '# Implementation\n\nOperator context remains.\n\nCloses #251\n';
const report = '# Flow audit\n\nDevelopment complete; finalization verified. Human completion and merge remain.\n';
const maintained = (text: string) => `${begin}\n${text}${end}`;

function fixture(body: string, options: { reject?: boolean; discard?: boolean; readbackError?: boolean } = {}) {
  let published = body;
  const targets: number[] = [];
  const writes: string[] = [];
  const github = {
    readBody: async (number: number) => {
      targets.push(number);
      if (writes.length && options.readbackError) throw new Error('readback unavailable');
      return published;
    },
    replaceBody: async (number: number, text: string) => {
      targets.push(number);
      if (options.reject) throw new Error('publication rejected');
      writes.push(text);
      if (!options.discard) published = text;
    },
  };
  return {
    body: () => published,
    targets,
    writes,
    options,
    publish: (text = report) => publishFlowAudit(github, 41, text).then(() => ({ outcome: 'done' }))
      .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })),
  };
}

describe('#251 maintained audit publication', () => {
  it('appends the local report below the retained description and closing reference', async () => {
    const fx = fixture(original);
    expect.soft(await fx.publish()).toEqual({ outcome: 'done' });
    expect.soft(fx.body()).toBe(`${original}\n${maintained(report)}\n`);
    expect.soft(fx.targets.length).toBeGreaterThan(0);
    expect(fx.targets.every((number) => number === 41)).toBe(true);
  });

  it('replaces the prior section and moves it below preserved trailing context on repeated publication', async () => {
    const suffix = '\nOperator follow-up.\nCloses #999\n';
    const fx = fixture(`${original}\n${maintained('Old evidence\n')}${suffix}`);
    const expected = `${original}\n${suffix}\n${maintained(report)}\n`;
    expect.soft(await fx.publish()).toEqual({ outcome: 'done' });
    expect.soft(fx.body()).toBe(expected);
    expect.soft(await fx.publish('Updated evidence\n')).toEqual({ outcome: 'done' });
    expect.soft(fx.body()).toBe(`${original}\n${suffix}\n${maintained('Updated evidence\n')}\n`);
  });

  it.each([
    `${begin}\nunterminated`,
    `orphan ${end}`,
    `${end}\n${begin}`,
    `${maintained('one')}\n${maintained('two')}`,
    `${begin}\n${begin}\nnested\n${end}\n${end}`,
  ])('refuses ambiguous ownership without changing remote content: %s', async (owned) => {
    const body = `${original}\n${owned}`;
    const fx = fixture(body);
    expect.soft(await fx.publish()).toEqual({ error: expect.any(String) });
    expect.soft(fx.body()).toBe(body);
    expect.soft(fx.writes).toEqual([]);
  });

  it('surfaces a rejected write and permits retry against the unchanged description', async () => {
    const fx = fixture(original, { reject: true });
    expect(await fx.publish()).toEqual({ error: 'publication rejected' });
    expect(fx.body()).toBe(original);
    fx.options.reject = false;
    expect(await fx.publish()).toEqual({ outcome: 'done' });
    expect(fx.body()).toBe(`${original}\n${maintained(report)}\n`);
  });

  it.each([{ discard: true }, { readbackError: true }])('does not claim success without matching remote readback: %j', async (options) => {
    const fx = fixture(original, options);
    expect.soft(await fx.publish()).toEqual({ error: expect.any(String) });
    expect(fx.writes).toHaveLength(1);
  });
});


describe('#251 publication artifact ownership', () => {
  it.each([begin, end])('rejects a report containing the reserved delimiter %s before writing', async (marker) => {
    const fx = fixture(original);
    expect(await fx.publish(`Report containing ${marker}\n`)).toEqual({ error: expect.any(String) });
    expect(fx.body()).toBe(original);
    expect(fx.writes).toEqual([]);
  });
});

it('rejects an empty report without changing the description', async () => {
  const fx = fixture(original);
  expect(await fx.publish(' \n')).toEqual({ error: expect.stringMatching(/empty/i) });
  expect(fx.body()).toBe(original);
  expect(fx.writes).toEqual([]);
});
