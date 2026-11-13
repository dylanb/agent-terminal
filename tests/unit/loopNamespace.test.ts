import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isLoopNamespace,
  isRecognizedLoopBinding,
  bindsNoSurvivingEngine,
  DEFAULT_LOOP_NAMESPACE,
  APP_LOOP_NAMESPACE,
  RETIRED_LOOP_NAMESPACE,
} from '../../src/shared/loopNamespace';
import { loadFlowDefinition } from '../../src/main/flow';

// §27.15 / AC 4 (N8 sweep): the closed set narrows to the ONE surviving (§27) member; absence re-points at
// it; and the retired `legacy` literal is still RECOGNIZED so a flow file naming it LOADS and fails
// per-step rather than being rejected whole. The marking that names no surviving engine lives once and is
// affirmative against the surviving set (CLAUDE.md shared-semantics).
describe('loop namespace closed set (§27.15 engine selection)', () => {
  it('narrows the surviving set to the one §27 member and re-points absence at it', () => {
    expect(isLoopNamespace('app')).toBe(true);
    expect(APP_LOOP_NAMESPACE).toBe('app');
    expect(DEFAULT_LOOP_NAMESPACE).toBe(APP_LOOP_NAMESPACE);
  });

  it('no longer counts the retired legacy literal — or any other value — as a surviving member', () => {
    for (const bad of ['legacy', '', 'other', 'v2', '§27', 42, undefined, null]) {
      expect(isLoopNamespace(bad as unknown)).toBe(false);
    }
  });

  it('still RECOGNIZES legacy as a parseable binding that names no surviving engine (AC 4)', () => {
    expect(RETIRED_LOOP_NAMESPACE).toBe('legacy');
    expect(isRecognizedLoopBinding('legacy')).toBe(true);
    expect(isRecognizedLoopBinding('app')).toBe(true);
    // the marking the three seams read — affirmative against the surviving set, so a marked binding is
    // unbindable by construction
    expect(bindsNoSurvivingEngine('legacy')).toBe(true);
    expect(bindsNoSurvivingEngine('app')).toBe(false);
  });

  it('recognizes NOTHING else as a binding — an unrecognized value is a whole-file rejection', () => {
    for (const bad of ['', 'other', 'v2', 'LEGACY', 'App', 42, undefined, null]) {
      expect(isRecognizedLoopBinding(bad as unknown)).toBe(false);
    }
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

describe('loadFlowDefinition — def-namespace binding on a loop step (AC 4)', () => {
  it('defaults an absent namespace to the surviving engine', () => {
    writeFlow('name: f\nsteps:\n  - id: build\n    kind: loop\n    loop: impl-loop\n');
    const load = loadFlowDefinition(dir, null);
    expect(load.ok).toBe(true);
    if (load.ok) expect(load.definition.steps[0].loopNamespace).toBe(APP_LOOP_NAMESPACE);
  });

  it('parses an explicit app namespace', () => {
    writeFlow('name: f\nsteps:\n  - id: build\n    kind: loop\n    loop: impl-loop\n    loop_namespace: app\n');
    const load = loadFlowDefinition(dir, null);
    expect(load.ok).toBe(true);
    if (load.ok) expect(load.definition.steps[0].loopNamespace).toBe('app');
  });

  it('LOADS a legacy-marked step rather than rejecting it whole (AC 4 tolerance)', () => {
    writeFlow('name: f\nsteps:\n  - id: build\n    kind: loop\n    loop: impl-loop\n    loop_namespace: legacy\n');
    const load = loadFlowDefinition(dir, null);
    expect(load.ok).toBe(true);
    if (load.ok) {
      const ns = load.definition.steps[0].loopNamespace;
      expect(ns).toBe('legacy');
      expect(bindsNoSurvivingEngine(ns!)).toBe(true);
    }
  });

  it('rejects the WHOLE file for an unrecognized namespace, naming the real cause', () => {
    writeFlow('name: f\nsteps:\n  - id: build\n    kind: loop\n    loop: impl-loop\n    loop_namespace: mystery\n');
    const load = loadFlowDefinition(dir, null);
    expect(load.ok).toBe(false);
    if (!load.ok) expect(load.error.toLowerCase()).toContain('namespace');
  });

  // The whole-file safe-segment abort gates on the namespace the FILE names, not on the resolved
  // binding — so an explicitly-`app` step keeps today's whole-file rejection while a namespace-less or a
  // legacy-marked step with the same unsafe name LOADS and fails per-step at resolution (AC 4's floor).
  it('rejects the whole file for an unsafe loop name on an EXPLICITLY-app step', () => {
    writeFlow('name: f\nsteps:\n  - id: build\n    kind: loop\n    loop: plan_loop\n    loop_namespace: app\n');
    expect(loadFlowDefinition(dir, null).ok).toBe(false);
  });

  it('LOADS a namespace-less step whose loop name is not a safe segment (per-step failure, not whole-file)', () => {
    writeFlow('name: f\nsteps:\n  - id: build\n    kind: loop\n    loop: plan_loop\n');
    expect(loadFlowDefinition(dir, null).ok).toBe(true);
  });

  it('LOADS a legacy-marked step whose loop name is not a safe segment (per-step failure, not whole-file)', () => {
    writeFlow('name: f\nsteps:\n  - id: build\n    kind: loop\n    loop: My_Loop\n    loop_namespace: legacy\n');
    expect(loadFlowDefinition(dir, null).ok).toBe(true);
  });
});
