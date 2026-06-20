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
// (§18.1 minimal shape: name + one kind:manual step with id/skill/todo_template), no longer a
// hardcoded constant. The loader runs against real temp dirs (no fs mocks); the machine
// surfaces a clear error state — never a crash — on a missing/malformed/invalid file.

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

  it('rejects a skill carrying control chars (PTY line-injection guard, §9.3)', () => {
    // A skill value reaches inject() → the PTY; an embedded CR executes when bracketed-paste is
    // off (the bare-prompt default), so an untrusted repo's flow.yaml could smuggle a command.
    writeFlow('name: f\nsteps:\n  - id: x\n    kind: manual\n    skill: "groom\\rrm -rf ~"\n');
    expect(loadFlowDefinition(dir).ok).toBe(false);
    writeFlow('name: f\nsteps:\n  - id: x\n    kind: manual\n    skill: "a\\nb"\n');
    expect(loadFlowDefinition(dir).ok).toBe(false);
  });

  it('rejects schema-invalid definitions (no name / no steps / step missing id / not manual)', () => {
    writeFlow('steps:\n  - id: x\n    kind: manual\n'); // no top-level name
    expect(loadFlowDefinition(dir).ok).toBe(false);
    writeFlow('name: f\nsteps: []\n'); // no steps
    expect(loadFlowDefinition(dir).ok).toBe(false);
    writeFlow('name: f\nsteps:\n  - kind: manual\n'); // step missing id
    expect(loadFlowDefinition(dir).ok).toBe(false);
    writeFlow('name: f\nsteps:\n  - id: x\n    kind: loop\n'); // not a manual step (out of S2 scope)
    expect(loadFlowDefinition(dir).ok).toBe(false);
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

// The flow DEFINITION resolves local-first then global: the repository's flow.yaml takes
// precedence, falling back to a global (e.g. $HOME) default only when the repo has none. (The
// flow STATE, by contrast, is always repo-local — see flowState.) A present-but-invalid local
// flow.yaml surfaces its own error rather than being masked by the global file.
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
    write(local, 'name: feature\nsteps:\n  - id: x\n    kind: loop\n'); // invalid: not a manual step
    write(global, VALID('global'));
    const load = loadFlowDefinitionLocalFirst(local, global);
    expect(load.ok).toBe(false); // the local error wins; the global is NOT used
  });
});
