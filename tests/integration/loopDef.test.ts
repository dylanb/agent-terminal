import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLoopDef, gateForStatus } from '../../src/main/loopDef';

// §24.2.3 T2 (folded) — the read-only LoopDef resolver. A flow step binds an agent-loop by name
// (`loop: impl-loop`, §18.1); this resolves that name to the engine's real LoopDef yaml and reads
// its `gates:` — each gate's `id` IS a status string and carries `human_options` + `kind`. Resolution
// mirrors `agent-loop list`: a repo-local `.agent-loop.yaml` `loops:` registry override wins, else
// `$CLAUDE_CONFIG_DIR/loops/<name>/<name>.yaml` (default ~/.claude). Like the §19.1 store it NEVER
// throws: a missing / corrupt / wrong-schema / unknown-name LoopDef degrades to null. Real temp files.

// A minimal but real-shaped LoopDef (the gate fields the app reads; the engine's other keys are
// irrelevant to the bridge and intentionally omitted).
const IMPL_LOOP =
  'name: impl-loop\n' +
  'schema_version: "4"\n' +
  'gates:\n' +
  '  - id: awaiting-human-pr-approval\n' +
  '    kind: approve-required\n' +
  '    human_options: [approve, request-changes, impasse]\n' +
  '    next_status_on_approve: awaiting-team-review\n' +
  '  - id: awaiting-human-impl-triage\n' +
  '    kind: triage\n' +
  '    human_options: [approve, request-changes, impasse]\n' +
  '    next_status_on_approve: awaiting-team-review\n' +
  '  - id: awaiting-team-review\n' +
  '    kind: terminal\n' +
  '    human_options: []\n';

describe('LoopDef resolver (§24.2.3 T2 folded / §18.1)', () => {
  let repo: string;
  let configDir: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'loopdef-repo-'));
    configDir = mkdtempSync(join(tmpdir(), 'loopdef-config-'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  const writeRegistry = (mapping: string): void =>
    writeFileSync(join(repo, '.agent-loop.yaml'), `loops:\n${mapping}`);
  const writeConfigLoop = (name: string, body: string): void => {
    mkdirSync(join(configDir, 'loops', name), { recursive: true });
    writeFileSync(join(configDir, 'loops', name, `${name}.yaml`), body);
  };

  it('resolves a loop via the repo .agent-loop.yaml loops: registry override and reads its gates', () => {
    writeFileSync(join(repo, 'my-impl-loop.yaml'), IMPL_LOOP);
    writeRegistry('  impl-loop: ./my-impl-loop.yaml\n');
    const def = parseLoopDef(repo, 'impl-loop', configDir);
    expect(def?.name).toBe('impl-loop');
    expect(def?.gates).toContainEqual({
      id: 'awaiting-human-pr-approval',
      kind: 'approve-required',
      humanOptions: ['approve', 'request-changes', 'impasse'],
      terminal: false,
    });
    // the gate whose id matches a status is found by status, with its human_options exposed
    const gate = gateForStatus(def!, 'awaiting-human-pr-approval');
    expect(gate?.humanOptions).toEqual(['approve', 'request-changes', 'impasse']);
  });

  it('flags a terminal gate (kind: terminal, empty human_options)', () => {
    writeConfigLoop('impl-loop', IMPL_LOOP);
    const def = parseLoopDef(repo, 'impl-loop', configDir);
    expect(gateForStatus(def!, 'awaiting-team-review')).toEqual({
      id: 'awaiting-team-review',
      kind: 'terminal',
      humanOptions: [],
      terminal: true,
    });
  });

  it('resolves from $CLAUDE_CONFIG_DIR/loops/<name>/<name>.yaml when no registry override exists', () => {
    writeConfigLoop('plan-loop', IMPL_LOOP.replace('name: impl-loop', 'name: plan-loop'));
    const def = parseLoopDef(repo, 'plan-loop', configDir);
    expect(def?.name).toBe('plan-loop');
    expect(def?.gates.length).toBe(3);
  });

  it('returns null (never throws) for an unknown loop name', () => {
    expect(parseLoopDef(repo, 'no-such-loop', configDir)).toBeNull();
  });

  it('returns null for a corrupt LoopDef yaml', () => {
    writeConfigLoop('impl-loop', 'name: impl-loop\n  gates: : : broken\n\t- nope');
    expect(parseLoopDef(repo, 'impl-loop', configDir)).toBeNull();
  });

  it('returns null for a LoopDef with the wrong schema_version', () => {
    writeConfigLoop('impl-loop', IMPL_LOOP.replace('schema_version: "4"', 'schema_version: "3"'));
    expect(parseLoopDef(repo, 'impl-loop', configDir)).toBeNull();
  });

  it('returns null when the LoopDef has no gates array', () => {
    writeConfigLoop('impl-loop', 'name: impl-loop\nschema_version: "4"\n');
    expect(parseLoopDef(repo, 'impl-loop', configDir)).toBeNull();
  });

  it('ignores a repo registry override that escapes the repo dir (CWE-22 path traversal), falling through to config', () => {
    // A hostile/buggy committed .agent-loop.yaml points the loop at a file OUTSIDE the repo; the
    // resolver must refuse the override (like the sibling todoTemplate loader, §20.2) and fall
    // through to the trusted config-dir copy rather than read+parse the escaped path.
    const outside = mkdtempSync(join(tmpdir(), 'loopdef-outside-'));
    writeFileSync(join(outside, 'evil.yaml'), IMPL_LOOP.replace('name: impl-loop', 'name: evil-loop'));
    writeConfigLoop('impl-loop', IMPL_LOOP); // the legit config copy

    writeRegistry(`  impl-loop: ${join(outside, 'evil.yaml')}\n`); // absolute escape
    expect(parseLoopDef(repo, 'impl-loop', configDir)?.name).toBe('impl-loop');

    writeRegistry('  impl-loop: ../../../../../../etc/passwd\n'); // relative traversal escape
    expect(parseLoopDef(repo, 'impl-loop', configDir)?.name).toBe('impl-loop');

    rmSync(outside, { recursive: true, force: true });
  });

  it('still honors an in-repo registry override in a subdirectory (containment guard is not over-broad)', () => {
    mkdirSync(join(repo, 'loops'), { recursive: true });
    writeFileSync(join(repo, 'loops', 'my-impl-loop.yaml'), IMPL_LOOP);
    writeRegistry('  impl-loop: ./loops/my-impl-loop.yaml\n');
    expect(parseLoopDef(repo, 'impl-loop', configDir)?.name).toBe('impl-loop');
  });
});
