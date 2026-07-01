import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLoopDef, gateForStatus } from '../../src/main/loopDef';
import { decideGateOutcome } from '../../src/main/gateActions';

// §26.6 / L5 — the app-internal gate transition. A gate's on_approve / on_request_changes / on_impasse
// action list + next_status_on_* are parsed from the LoopDef (§26.5); `decideGateOutcome` translates the
// chosen option into the normalized outcome the orchestrator executes (write status, run gh side-effects,
// re-iterate/stop). Pure function, tested against a real-shaped plan-loop gate.

const PLAN_LOOP =
  'name: plan-loop\n' +
  'schema_version: "4"\n' +
  'gates:\n' +
  '  - id: awaiting-human-plan-approval\n' +
  '    kind: approve-required\n' +
  '    human_options: [approve, request-changes, impasse]\n' +
  '    on_approve:\n' +
  '      - kind: epic-promote\n' +
  "        args: {when: \"plan.classification == 'epic'\"}\n" +
  '      - kind: mark-pr-ready\n' +
  '      - kind: clear-phase2\n' +
  '      - kind: reset-severity-cycle\n' +
  '      - kind: terminate\n' +
  '    on_request_changes:\n' +
  '      - kind: set-phase2\n' +
  '        args: {active: true}\n' +
  '      - kind: clear-persona-state\n' +
  '      - kind: append-human-note\n' +
  '        args: {title: "human request-changes"}\n' +
  '    on_impasse:\n' +
  '      - kind: append-human-note\n' +
  '        args: {prefix: "impasse: "}\n' +
  '    next_status_on_approve: plan-human-approved\n' +
  '    next_status_on_request_changes: plan-draft\n' +
  '    next_status_on_impasse: impasse\n' +
  '  - id: plan-human-approved\n' +
  '    kind: terminal\n' +
  '    human_options: []\n';

describe('decideGateOutcome (§26.6 / L5 — app-internal gate transition)', () => {
  let repo: string;
  let configDir: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gate-repo-'));
    configDir = mkdtempSync(join(tmpdir(), 'gate-config-'));
    mkdirSync(join(configDir, 'loops', 'plan-loop'), { recursive: true });
    writeFileSync(join(configDir, 'loops', 'plan-loop', 'plan-loop.yaml'), PLAN_LOOP);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  function gate() {
    const def = parseLoopDef(repo, 'plan-loop', configDir);
    expect(def).not.toBeNull();
    const g = gateForStatus(def!, 'awaiting-human-plan-approval');
    expect(g).toBeDefined();
    return g!;
  }

  it('parses the gate action lists + next statuses from the LoopDef', () => {
    const g = gate();
    expect(g.nextStatusOnApprove).toBe('plan-human-approved');
    expect(g.nextStatusOnRequestChanges).toBe('plan-draft');
    expect(g.nextStatusOnImpasse).toBe('impasse');
    expect(g.onApprove.map((a) => a.kind)).toEqual([
      'epic-promote',
      'mark-pr-ready',
      'clear-phase2',
      'reset-severity-cycle',
      'terminate',
    ]);
  });

  it('approve → terminal status, mark-pr-ready side-effect, terminate, no re-iterate', () => {
    const out = decideGateOutcome(gate(), 'approve');
    expect(out.nextStatus).toBe('plan-human-approved');
    expect(out.terminate).toBe(true);
    expect(out.reiterate).toBe(false);
    expect(out.effects.map((e) => e.kind)).toContain('mark-pr-ready');
  });

  it('recognizes the epic-promote effect (§26.9 / L8) — no longer dropped as an unknown kind', () => {
    const out = decideGateOutcome(gate(), 'approve');
    expect(out.effects.map((e) => e.kind)).toContain('epic-promote');
  });

  it('request-changes → re-iterate at entry status; set-phase2, clear-persona-state, append-human-note', () => {
    const out = decideGateOutcome(gate(), 'request-changes');
    expect(out.nextStatus).toBe('plan-draft');
    expect(out.terminate).toBe(false);
    expect(out.reiterate).toBe(true);
    const kinds = out.effects.map((e) => e.kind);
    expect(kinds).toContain('set-phase2');
    expect(kinds).toContain('clear-persona-state');
    expect(kinds).toContain('append-human-note');
    const setPhase2 = out.effects.find((e) => e.kind === 'set-phase2');
    expect(setPhase2).toEqual({ kind: 'set-phase2', active: true });
  });

  it('impasse → terminal impasse status, append-human-note, no re-iterate', () => {
    const out = decideGateOutcome(gate(), 'impasse');
    expect(out.nextStatus).toBe('impasse');
    expect(out.terminate).toBe(true);
    expect(out.reiterate).toBe(false);
    expect(out.effects.map((e) => e.kind)).toContain('append-human-note');
  });
});
