import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLoopNamespace, DEFAULT_LOOP_NAMESPACE } from '../../src/shared/loopNamespace';
import { loadFlowDefinition } from '../../src/main/flow';

describe('loop namespace closed set (§27 engine selection)', () => {
  it('recognizes exactly legacy and app', () => {
    expect(isLoopNamespace('legacy')).toBe(true);
    expect(isLoopNamespace('app')).toBe(true);
  });
  it('rejects any other value, and the default is the §26 legacy namespace', () => {
    for (const bad of ['', 'other', 'v2', '§27', 42, undefined, null]) {
      expect(isLoopNamespace(bad as unknown)).toBe(false);
    }
    expect(DEFAULT_LOOP_NAMESPACE).toBe('legacy');
  });
});

let dir: string;
function writeFlow(body: string): void {
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  writeFileSync(join(dir, '.agent-terminal', 'flow.yaml'), body);
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flow-ns-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadFlowDefinition — def-namespace binding on a loop step (AC 10)', () => {
  it('defaults an absent namespace to the §26 legacy engine', () => {
    writeFlow('name: f\nsteps:\n  - id: build\n    kind: loop\n    loop: impl-loop\n');
    const load = loadFlowDefinition(dir);
    expect(load.ok).toBe(true);
    if (load.ok) expect(load.definition.steps[0].loopNamespace).toBe('legacy');
  });

  it('parses an explicit app namespace', () => {
    writeFlow('name: f\nsteps:\n  - id: build\n    kind: loop\n    loop: impl-loop\n    loop_namespace: app\n');
    const load = loadFlowDefinition(dir);
    expect(load.ok).toBe(true);
    if (load.ok) expect(load.definition.steps[0].loopNamespace).toBe('app');
  });

  it('parses an explicit legacy namespace', () => {
    writeFlow('name: f\nsteps:\n  - id: build\n    kind: loop\n    loop: impl-loop\n    loop_namespace: legacy\n');
    const load = loadFlowDefinition(dir);
    expect(load.ok && load.definition.steps[0].loopNamespace).toBe('legacy');
  });

  it('surfaces a reason for an unrecognized namespace rather than silently defaulting', () => {
    writeFlow('name: f\nsteps:\n  - id: build\n    kind: loop\n    loop: impl-loop\n    loop_namespace: mystery\n');
    const load = loadFlowDefinition(dir);
    expect(load.ok).toBe(false);
    if (!load.ok) expect(load.error.toLowerCase()).toContain('namespace');
  });

  it('rejects an unsafe loop name on an app-namespace step before any tier root is joined', () => {
    writeFlow('name: f\nsteps:\n  - id: build\n    kind: loop\n    loop: ../evil\n    loop_namespace: app\n');
    const load = loadFlowDefinition(dir);
    expect(load.ok).toBe(false);
  });

  it('leaves a legacy (§26) loop step with an unusual name to resolve as it does today', () => {
    writeFlow('name: f\nsteps:\n  - id: build\n    kind: loop\n    loop: My_Loop\n');
    const load = loadFlowDefinition(dir);
    expect(load.ok).toBe(true); // §26 name validation happens at resolution, not flow-load — unchanged
  });
});
