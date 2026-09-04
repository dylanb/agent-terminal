import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadFlowDefinition,
  loadFlowDefinitionLocalFirst,
  createFlowMachine,
  type FlowLoad,
} from '../../src/main/flow';

// §24.2.2 S2 — the step definition is sourced from a real <worktree>/.agent-terminal/flow.yaml
// (§18.1). The loader runs against real temp dirs (no fs mocks) and surfaces a clear error state —
// never a crash — on a missing/malformed/invalid file.

describe('flow.yaml loader (§24.2.2 S2 / §18.1)', () => {
  let dir: string;
  const writeFlow = (yaml: string): void => {
    mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
    writeFileSync(join(dir, '.agent-terminal', 'flow.yaml'), yaml);
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-def-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads a valid §18.1 minimal manual flow with its skill/template references', () => {
    writeFlow(
      'name: feature-dev\n' +
        'steps:\n' +
        '  - id: groom-ticket\n' +
        '    kind: manual\n' +
        '    skill: groom-ticket\n' +
        '    todo_template: ticket-grooming\n',
    );
    const load = loadFlowDefinition(dir);
    expect(load.ok).toBe(true);
    if (load.ok) {
      expect(load.definition.name).toBe('feature-dev');
      expect(load.definition.steps[0].id).toBe('groom-ticket');
      expect(load.definition.steps[0].kind).toBe('manual');
      expect(load.definition.steps[0].skill).toBe('groom-ticket');
      expect(load.definition.steps[0].todoTemplate).toBe('ticket-grooming');
    }
  });

  it('loads a minimal manual step without optional skill/template', () => {
    writeFlow('name: f\nsteps:\n  - id: do-it\n    kind: manual\n');
    const load = loadFlowDefinition(dir);
    expect(load.ok).toBe(true);
    if (load.ok) {
      expect(load.definition.steps[0].id).toBe('do-it');
      expect(load.definition.steps[0].skill).toBeUndefined();
    }
  });

  it('reports the directory holding the flow.yaml, for resolving co-located templates (§18.6)', () => {
    writeFlow('name: f\nsteps:\n  - id: do-it\n    kind: manual\n');
    const load = loadFlowDefinition(dir);
    expect(load.ok).toBe(true);
    if (load.ok) expect(load.flowDir).toBe(join(dir, '.agent-terminal'));
  });

  it('reports a clear error when flow.yaml is absent', () => {
    const load = loadFlowDefinition(dir);
    expect(load.ok).toBe(false);
    if (!load.ok) expect(load.error.length).toBeGreaterThan(0);
  });

  it('reports an error on malformed YAML rather than throwing', () => {
    writeFlow('name: feature-dev\n  steps: : : broken\n\t- id');
    const load = loadFlowDefinition(dir);
    expect(load.ok).toBe(false);
  });

  it('rejects schema-invalid definitions (no name / no steps / step missing id / unsupported kind)', () => {
    writeFlow('steps:\n  - id: x\n    kind: manual\n'); // no top-level name
    expect(loadFlowDefinition(dir).ok).toBe(false);
    writeFlow('name: f\nsteps: []\n'); // no steps
    expect(loadFlowDefinition(dir).ok).toBe(false);
    writeFlow('name: f\nsteps:\n  - kind: manual\n'); // step missing id
    expect(loadFlowDefinition(dir).ok).toBe(false);
    writeFlow('name: f\nsteps:\n  - id: x\n    kind: action\n'); // `action` is a later phase (§18.2)
    expect(loadFlowDefinition(dir).ok).toBe(false);
  });

  // §24.2.3 T1 — the loader loads ALL steps in order, not just the first, validating each.
  it('loads every step of a multi-step manual flow, in order, with each step\'s refs', () => {
    writeFlow(
      'name: feature-dev\n' +
        'steps:\n' +
        '  - id: groom\n' +
        '    kind: manual\n' +
        '    skill: groom-ticket\n' +
        '  - id: plan\n' +
        '    kind: manual\n' +
        '    todo_template: planning\n' +
        '  - id: implement\n' +
        '    kind: manual\n',
    );
    const load = loadFlowDefinition(dir);
    expect(load.ok).toBe(true);
    if (load.ok) {
      expect(load.definition.steps.map((s) => s.id)).toEqual(['groom', 'plan', 'implement']);
      expect(load.definition.steps[0].skill).toBe('groom-ticket');
      expect(load.definition.steps[1].todoTemplate).toBe('planning');
      expect(load.definition.steps[2].skill).toBeUndefined();
    }
  });

  it('rejects a flow where ANY step (not just the first) has an out-of-scope kind', () => {
    writeFlow(
      'name: f\nsteps:\n' +
        '  - id: groom\n    kind: manual\n' +
        '  - id: ship\n    kind: action\n', // action is a later phase (§18.2)
    );
    expect(loadFlowDefinition(dir).ok).toBe(false);
  });

  // §24.2.3 T2 — the loader gains the `loop` kind: a step binding an agent-loop LoopDef by name. The
  // loader only captures the binding; the bound §27 engine drives it (AC 4).
  it('loads a loop step binding its LoopDef name (§24.2.3 T2)', () => {
    writeFlow(
      'name: feature-dev\nsteps:\n' +
        '  - id: groom\n    kind: manual\n' +
        '  - id: build\n    kind: loop\n    loop: impl-loop\n',
    );
    const load = loadFlowDefinition(dir);
    expect(load.ok).toBe(true);
    if (load.ok) {
      expect(load.definition.steps.map((s) => s.kind)).toEqual(['manual', 'loop']);
      expect(load.definition.steps[1].loop).toBe('impl-loop');
    }
  });

  it('rejects a loop step that names no loop: LoopDef binding (§24.2.3 T2)', () => {
    writeFlow('name: f\nsteps:\n  - id: build\n    kind: loop\n');
    expect(loadFlowDefinition(dir).ok).toBe(false);
  });

  // §24.2.3 T3 — a step may declare a `bootstrap: pickup` entry action (§18.3) and typed `inputs`
  // (§18.4); the loader captures both.
  it('loads a step\'s bootstrap + typed inputs (§24.2.3 T3 / §18.3/§18.4)', () => {
    writeFlow(
      'name: feature-dev\nsteps:\n' +
        '  - id: plan\n    kind: loop\n    loop: plan-loop\n    bootstrap: pickup\n' +
        '    inputs:\n      - name: ticket\n        type: github-ticket\n        required: true\n',
    );
    const load = loadFlowDefinition(dir);
    expect(load.ok).toBe(true);
    if (load.ok) {
      expect(load.definition.steps[0].bootstrap).toBe('pickup');
      expect(load.definition.steps[0].inputs).toEqual([{ name: 'ticket', type: 'github-ticket', required: true }]);
    }
  });

  it('defaults an input\'s required to false and rejects an unsupported bootstrap (§24.2.3 T3)', () => {
    writeFlow(
      'name: f\nsteps:\n  - id: plan\n    kind: loop\n    loop: plan-loop\n' +
        '    inputs:\n      - name: note\n        type: free-text\n',
    );
    const load = loadFlowDefinition(dir);
    expect(load.ok).toBe(true);
    if (load.ok) expect(load.definition.steps[0].inputs).toEqual([{ name: 'note', type: 'free-text', required: false }]);

    writeFlow('name: f\nsteps:\n  - id: plan\n    kind: loop\n    loop: plan-loop\n    bootstrap: teleport\n');
    expect(loadFlowDefinition(dir).ok).toBe(false); // only `pickup` is in scope (§18.3)
  });

  it('rejects malformed inputs: a non-array inputs: or an entry missing name/type (§24.2.3 T3)', () => {
    // The loader must surface an error state (never silently accept) when `inputs:` is not a list of
    // {name, type} entries — otherwise a bootstrap could run with an unvalidated input shape.
    writeFlow('name: f\nsteps:\n  - id: plan\n    kind: loop\n    loop: plan-loop\n    inputs: ticket\n');
    expect(loadFlowDefinition(dir).ok).toBe(false); // inputs: is not an array

    writeFlow('name: f\nsteps:\n  - id: plan\n    kind: loop\n    loop: plan-loop\n    inputs:\n      - name: ticket\n');
    expect(loadFlowDefinition(dir).ok).toBe(false); // entry missing `type`
  });

  // §28.4 loop-back (repeat) primitive — a step may declare `repeat: { back_to, count_input }` making
  // advance() loop back to an EARLIER step `count_input`-many times (§28.2 slice-loop×N). The loader
  // captures the binding; the machine drives the back-jump.
  it('loads a step\'s repeat directive, mapping back_to/count_input to backTo/countInput (§28.4)', () => {
    writeFlow(
      'name: feature-dev\nsteps:\n' +
        '  - id: red\n    kind: loop\n    loop: red-loop\n' +
        '  - id: refactor\n    kind: loop\n    loop: refactor-loop\n' +
        '    repeat:\n      back_to: red\n      count_input: slices\n',
    );
    const load = loadFlowDefinition(dir);
    expect(load.ok).toBe(true);
    if (load.ok) {
      expect(load.definition.steps[0].repeat).toBeUndefined();
      expect(load.definition.steps[1].repeat).toEqual({ backTo: 'red', countInput: 'slices' });
    }
  });

  it('rejects a repeat whose back_to is not an EARLIER step (a repeat is a loop-back, never a skip) (§28.4)', () => {
    // forward target
    writeFlow(
      'name: f\nsteps:\n' +
        '  - id: red\n    kind: manual\n    repeat:\n      back_to: finalize\n      count_input: slices\n' +
        '  - id: finalize\n    kind: manual\n',
    );
    expect(loadFlowDefinition(dir).ok).toBe(false);
    // unknown target
    writeFlow(
      'name: f\nsteps:\n' +
        '  - id: red\n    kind: manual\n' +
        '  - id: refactor\n    kind: manual\n    repeat:\n      back_to: nope\n      count_input: slices\n',
    );
    expect(loadFlowDefinition(dir).ok).toBe(false);
  });

  it('rejects a malformed repeat: not a mapping, or missing back_to / count_input (§28.4)', () => {
    writeFlow('name: f\nsteps:\n  - id: red\n    kind: manual\n  - id: r\n    kind: manual\n    repeat: red\n');
    expect(loadFlowDefinition(dir).ok).toBe(false); // repeat is not a mapping
    writeFlow('name: f\nsteps:\n  - id: red\n    kind: manual\n  - id: r\n    kind: manual\n    repeat:\n      back_to: red\n');
    expect(loadFlowDefinition(dir).ok).toBe(false); // missing count_input
    writeFlow('name: f\nsteps:\n  - id: red\n    kind: manual\n  - id: r\n    kind: manual\n    repeat:\n      count_input: slices\n');
    expect(loadFlowDefinition(dir).ok).toBe(false); // missing back_to
  });
});

describe('flow machine sourced from a definition (§24.2.2 S2)', () => {
  const okLoad: FlowLoad = {
    ok: true,
    definition: { name: 'f', steps: [{ id: 'groom-ticket', kind: 'manual' }] },
    flowDir: '/tmp/f/.agent-terminal',
  };

  it('takes its step name from the loaded definition', () => {
    const flow = createFlowMachine(okLoad);
    expect(flow.state().stepName).toBe('groom-ticket');
    expect(flow.state().status).toBe('not_started');
  });

  it('still drives the unchanged lifecycle not_started → in_progress → done', () => {
    const flow = createFlowMachine(okLoad);
    expect(flow.start().status).toBe('in_progress');
    expect(flow.advance().status).toBe('done');
  });

  it('surfaces an inert error state (no throw, no transition) when the load failed', () => {
    const flow = createFlowMachine({ ok: false, error: 'flow.yaml not found' });
    const s = flow.state();
    expect(s.status).toBe('error');
    expect(s.error).toContain('not found');
    // start/advance are inert in the error state — they neither throw nor leave it.
    expect(flow.start().status).toBe('error');
    expect(flow.advance().status).toBe('error');
  });
});

// The flow DEFINITION resolves local-first then global (the flow STATE, by contrast, is always
// repo-local — see flowState). A present-but-invalid local flow.yaml surfaces its own error rather
// than being masked by the global file.
describe('flow.yaml local-first-then-global resolution (§18.1)', () => {
  let local: string;
  let global: string;
  const write = (dir: string, yaml: string): void => {
    mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
    writeFileSync(join(dir, '.agent-terminal', 'flow.yaml'), yaml);
  };
  const VALID = (name: string): string => `name: ${name}\nsteps:\n  - id: ${name}-step\n    kind: manual\n`;
  beforeEach(() => {
    local = mkdtempSync(join(tmpdir(), 'flow-local-'));
    global = mkdtempSync(join(tmpdir(), 'flow-global-'));
  });
  afterEach(() => {
    rmSync(local, { recursive: true, force: true });
    rmSync(global, { recursive: true, force: true });
  });

  it('prefers the local repo flow.yaml even when a global one exists', () => {
    write(local, VALID('local'));
    write(global, VALID('global'));
    const load = loadFlowDefinitionLocalFirst(local, global);
    expect(load.ok && load.definition.name).toBe('local');
  });

  it('falls back to the global flow.yaml when the repo has none', () => {
    write(global, VALID('global'));
    const load = loadFlowDefinitionLocalFirst(local, global);
    expect(load.ok && load.definition.name).toBe('global');
  });

  it('errors when neither local nor global has a flow.yaml', () => {
    expect(loadFlowDefinitionLocalFirst(local, global).ok).toBe(false);
  });

  it('surfaces a present-but-invalid local file rather than masking it with the global', () => {
    write(local, 'name: feature\nsteps:\n  - id: x\n    kind: action\n'); // invalid: out-of-scope kind
    write(global, VALID('global'));
    const load = loadFlowDefinitionLocalFirst(local, global);
    expect(load.ok).toBe(false); // the local error wins; the global is NOT used
  });

  // The symmetric case (§B.3, AC 4): the repo has NO flow.yaml but the GLOBAL one is present-but-invalid.
  // Its own error must surface — a present global's result stands — rather than being masked behind the
  // absent local's "no flow.yaml found", or a bad global value would be reported as a missing flow. Guards
  // the exact regression the local-first fix closed: `global.ok ? global : localAbsentError` fell back to the
  // absent-local mask for an invalid global; the existsSync-on-global guard surfaces the global's reason.
  it('surfaces a present-but-invalid GLOBAL error rather than masking it as a missing flow (AC 4)', () => {
    write(global, 'name: feature\nsteps:\n  - id: x\n    kind: action\n'); // invalid: out-of-scope kind; local absent
    const load = loadFlowDefinitionLocalFirst(local, global);
    expect(load.ok).toBe(false);
    if (load.ok) return;
    // the GLOBAL's own reason surfaces — NOT the absent-local "no flow.yaml found" mask
    expect(load.error).not.toContain('no flow.yaml found');
  });
});
