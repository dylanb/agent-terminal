import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFlowDefinitionFromFile, MAX_FLOW_STEPS, type FlowLoad } from '../../src/main/flow';
import { createStepLibrary, stepLibraryDir } from '../../src/main/stepLibrary';

describe('flow.yaml step references (§18.2)', () => {
  let repo: string;
  const step = (name: string, text: string): void => {
    mkdirSync(stepLibraryDir(repo), { recursive: true });
    writeFileSync(join(stepLibraryDir(repo), `${name}.yaml`), text);
  };
  const load = (flowYaml: string, withLibrary = true): FlowLoad => {
    const file = join(repo, 'flow.yaml');
    writeFileSync(file, flowYaml);
    return loadFlowDefinitionFromFile(file, withLibrary ? createStepLibrary([{ name: 'repo', worktreeDir: repo }]) : null);
  };
  const errorOf = (flowYaml: string): string => {
    const r = load(flowYaml);
    if (r.ok) throw new Error('expected the flow to fail to load');
    return r.error;
  };
  const LOOP_DEF = 'kind: loop\nloop: plan-loop\n';

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'flow-step-refs-'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('expands two references into steps named after their definitions', () => {
    step('step-a', 'kind: manual\n');
    step('step-b', 'kind: manual\n');
    const r = load('name: t\nsteps:\n  - step: step-a\n  - step: step-b\n');
    expect(r.ok && r.definition.steps).toEqual([
      { id: 'step-a', kind: 'manual' },
      { id: 'step-b', kind: 'manual' },
    ]);
  });

  it('uses the id a reference sets', () => {
    step('step-a', 'kind: manual\n');
    const r = load('name: t\nsteps:\n  - step: step-a\n    id: first\n');
    expect(r.ok && r.definition.steps.map((s) => s.id)).toEqual(['first']);
  });

  it('applies gate authority set on a reference to a loop definition', () => {
    step('step-a', LOOP_DEF);
    const r = load('name: t\nsteps:\n  - step: step-a\n    gate_authority: auto\n');
    expect(r.ok && r.definition.steps[0]).toMatchObject({ kind: 'loop', loop: 'plan-loop', loopNamespace: 'app', gateAuthority: 'auto' });
  });

  it('leaves gate authority unset when the reference sets none', () => {
    step('step-a', LOOP_DEF);
    const r = load('name: t\nsteps:\n  - step: step-a\n');
    expect(r.ok && r.definition.steps[0].gateAuthority).toBeUndefined();
  });

  it('refuses gate authority on a reference to a manual definition', () => {
    step('step-a', 'kind: manual\n');
    expect(errorOf('name: t\nsteps:\n  - step: step-a\n    gate_authority: auto\n')).toContain('only a loop step may carry');
  });

  it.each([
    'gate_authority: auto',
    'id: x',
    'step: other',
    'repeat: { back_to: a, count_input: n }',
    'halt_on_decision: [a]',
    'when: { a: b }',
  ])(
    'refuses a step definition that sets %s',
    (line) => {
      step('step-a', `${LOOP_DEF}${line}\n`);
      const error = errorOf('name: t\nsteps:\n  - step: step-a\n');
      expect(error).toContain('step definition "step-a"');
      expect(error).toContain(`may not set ${line.split(':')[0]}`);
    },
  );

  it('refuses an unknown field in a step definition', () => {
    step('step-a', 'kind: manual\nflavour: mint\n');
    expect(errorOf('name: t\nsteps:\n  - step: step-a\n')).toContain('has unknown field "flavour"');
  });

  it('refuses a step setting on a reference', () => {
    step('step-a', 'kind: manual\n');
    expect(errorOf('name: t\nsteps:\n  - step: step-a\n    todo_template: x\n')).toContain('belongs in step definition "step-a"');
  });

  it('refuses decides on a reference', () => {
    step('step-a', LOOP_DEF);
    expect(errorOf('name: t\nsteps:\n  - step: step-a\n    decides: [a, b]\n')).toContain('belongs in step definition "step-a"');
  });

  describe('branching', () => {
    const DECIDING_DEF = `${LOOP_DEF}decides: [ship, rework]\n`;

    it('takes decides from the definition and halt_on_decision and when from the reference', () => {
      step('decider', DECIDING_DEF);
      step('fix', 'kind: manual\n');
      const r = load(
        'name: t\nsteps:\n' +
          '  - step: decider\n    gate_authority: auto\n    halt_on_decision: [rework]\n' +
          '  - step: fix\n    when: { decider: rework }\n',
      );
      expect(r.ok && r.definition.steps).toEqual([
        { id: 'decider', kind: 'loop', loop: 'plan-loop', loopNamespace: 'app', gateAuthority: 'auto', decides: ['ship', 'rework'], haltOnDecision: ['rework'] },
        { id: 'fix', kind: 'manual', when: { step: 'decider', value: 'rework' } },
      ]);
    });

    it('lets an inline step branch on a referenced step under the id the flow gives it', () => {
      step('decider', DECIDING_DEF);
      const r = load('name: t\nsteps:\n  - step: decider\n    id: review\n  - id: ship-it\n    kind: manual\n    when: { review: ship }\n');
      expect(r.ok && r.definition.steps[1].when).toEqual({ step: 'review', value: 'ship' });
    });

    it('lets a reference branch on an inline deciding step', () => {
      step('fix', 'kind: manual\n');
      const r = load('name: t\nsteps:\n  - id: d\n    kind: loop\n    loop: l\n    decides: [a, b]\n  - step: fix\n    when: { d: b }\n');
      expect(r.ok && r.definition.steps[1].when).toEqual({ step: 'd', value: 'b' });
    });

    it('refuses a when on a reference that names a step whose definition decides nothing', () => {
      step('plain', LOOP_DEF);
      step('fix', 'kind: manual\n');
      const error = errorOf('name: t\nsteps:\n  - step: plain\n  - step: fix\n    when: { plain: ship }\n');
      expect(error).toContain('fix');
      expect(error).toContain('is not an earlier step that decides');
    });

    it('refuses a when on a reference whose value the referenced definition does not decide', () => {
      step('decider', DECIDING_DEF);
      step('fix', 'kind: manual\n');
      expect(errorOf('name: t\nsteps:\n  - step: decider\n  - step: fix\n    when: { decider: merge }\n')).toContain(
        'when value "merge" is not one "decider" decides',
      );
    });

    it('refuses a halt_on_decision on a reference that its definition does not decide', () => {
      step('decider', DECIDING_DEF);
      expect(errorOf('name: t\nsteps:\n  - step: decider\n    halt_on_decision: [merge]\n')).toContain(
        'halt_on_decision value "merge" is not in decides',
      );
    });

    it('refuses decides in a manual definition', () => {
      step('manual-decider', 'kind: manual\ndecides: [a, b]\n');
      expect(errorOf('name: t\nsteps:\n  - step: manual-decider\n')).toContain('"decides" is only valid on a loop step');
    });

    it('refuses a repeat on a reference whose back_to runs under a different when', () => {
      step('decider', DECIDING_DEF);
      step('fix', 'kind: manual\n');
      step('again', LOOP_DEF);
      const error = errorOf(
        'name: t\nsteps:\n  - step: decider\n  - step: fix\n    when: { decider: rework }\n' +
          '  - step: again\n    repeat: { back_to: fix, count_input: n }\n',
      );
      expect(error).toContain('does not share this step\'s when');
    });
  });

  it('loads a reference whose loop-back runs entirely inside one branch', () => {
    step('decider', `${LOOP_DEF}decides: [ship, rework]\n`);
    step('fix', 'kind: manual\n');
    step('again', LOOP_DEF);
    const r = load(
      'name: t\nsteps:\n  - step: decider\n  - step: fix\n    when: { decider: rework }\n' +
        '  - step: again\n    when: { decider: rework }\n    repeat: { back_to: fix, count_input: n }\n',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.definition.steps[2].when).toEqual({ step: 'decider', value: 'rework' });
      expect(r.definition.steps[2].repeat).toEqual({ backTo: 'fix', countInput: 'n' });
    }
  });

  it('applies a repeat set on a reference', () => {
    step('step-a', 'kind: manual\n');
    step('step-b', LOOP_DEF);
    const r = load('name: t\nsteps:\n  - step: step-a\n  - step: step-b\n    repeat: { back_to: step-a, count_input: n }\n');
    expect(r.ok && r.definition.steps[1].repeat).toEqual({ backTo: 'step-a', countInput: 'n' });
  });

  it('loads an inline step and a reference in order', () => {
    step('step-b', 'kind: manual\n');
    const r = load('name: t\nsteps:\n  - id: inline\n    kind: manual\n  - step: step-b\n');
    expect(r.ok && r.definition.steps.map((s) => s.id)).toEqual(['inline', 'step-b']);
  });

  it.each([
    ['two references', '  - step: step-a\n  - step: step-a\n'],
    ['a reference, then an inline step', '  - step: step-a\n  - id: step-a\n    kind: manual\n'],
    ['an inline step, then a reference', '  - id: step-a\n    kind: manual\n  - step: step-a\n'],
    ['two inline steps', '  - id: step-a\n    kind: manual\n  - id: step-a\n    kind: manual\n'],
  ])('refuses %s that share an id', (_case, steps) => {
    step('step-a', 'kind: manual\n');
    expect(errorOf(`name: t\nsteps:\n${steps}`)).toContain('duplicate step id "step-a"');
  });

  it('refuses a reference when no step library is available', () => {
    step('step-a', 'kind: manual\n');
    const r = load('name: t\nsteps:\n  - step: step-a\n', false);
    expect(!r.ok && r.error).toContain('no step library is available');
  });

  it('refuses a definition the step rules reject, naming it', () => {
    step('step-a', 'kind: action\n');
    const error = errorOf('name: t\nsteps:\n  - step: step-a\n');
    expect(error).toContain('step-a');
    expect(error).toContain('unsupported kind');
  });

  it('refuses a flow with more steps than the cap, before reading any definition', () => {
    step('step-a', 'kind: manual\n');
    const refs = Array.from({ length: MAX_FLOW_STEPS + 1 }, (_, i) => `  - step: step-a\n    id: s${i}\n`).join('');
    expect(errorOf(`name: t\nsteps:\n${refs}`)).toContain(`more than ${MAX_FLOW_STEPS} steps`);
  });

  it('loads a flow at the cap', () => {
    step('step-a', 'kind: manual\n');
    const refs = Array.from({ length: MAX_FLOW_STEPS }, (_, i) => `  - step: step-a\n    id: s${i}\n`).join('');
    const r = load(`name: t\nsteps:\n${refs}`);
    expect(r.ok && r.definition.steps.length).toBe(MAX_FLOW_STEPS);
  });

  it.each([
    ['an empty step name', '  - step: ""\n', 'has no step name'],
    ['a step name that is not a string', '  - step: 5\n', 'has no step name'],
    ['an empty id', '  - step: step-a\n    id: ""\n', 'has an invalid id'],
    ['an id that is not a string', '  - step: step-a\n    id: 7\n', 'has an invalid id'],
  ])('refuses a reference with %s', (_case, steps, reason) => {
    step('step-a', 'kind: manual\n');
    expect(errorOf(`name: t\nsteps:\n${steps}`)).toContain(reason);
  });

  it.each([
    ['is not valid YAML', 'kind: [\n', 'is not valid YAML'],
    ['is empty', '', 'must be a mapping'],
    ['is a list', '- a\n', 'must be a mapping'],
  ])('refuses a step definition that %s', (_case, text, reason) => {
    step('step-a', text);
    const error = errorOf('name: t\nsteps:\n  - step: step-a\n');
    expect(error).toContain('step-a');
    expect(error).toContain(reason);
  });

  it('names the reference when its definition cannot be found', () => {
    expect(errorOf('name: t\nsteps:\n  - step: nowhere\n')).toContain('nowhere');
  });
});
