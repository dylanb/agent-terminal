import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLoopDef, artifactPath, readLoopExecAllowed } from '../../src/main/loopDef';

// §26.6 — the `exec` gate action (ticket-body publish) runs by DEFAULT for every loop; a repo opts a loop
// OUT via `.agent-loop.yaml` `loops_deny_exec: {<loop>: true}`. Its `{{artifact.<id>}}` placeholder resolves
// through the LoopDef `artifacts` map to a path confined under `<repo>/.agent-loop/` (CWE-22). The allowed
// reader fails OPEN (allowed) on any bad/absent config; the path reader fails safe (null) on a bad id/path.

const DEF_WITH_ARTIFACTS =
  'name: plan-loop\n' +
  'schema_version: "4"\n' +
  'gates:\n' +
  '  - id: awaiting-human-plan-approval\n' +
  '    kind: approve-required\n' +
  '    human_options: [approve, request-changes, impasse]\n' +
  '    next_status_on_approve: plan-human-approved\n' +
  'artifacts:\n' +
  '  - id: plan\n' +
  '    path_pattern: "plan.md"\n' +
  '  - id: ticket-body\n' +
  '    path_pattern: "ticket.md"\n' +
  '  - id: escape\n' +
  '    path_pattern: "../outside.md"\n';

describe('readLoopExecAllowed (§26.6 loops_deny_exec opt-out)', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'loopexec-repo-'));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const writeConfig = (body: string): void => writeFileSync(join(repo, '.agent-loop.yaml'), body);

  it('is false only when loops_deny_exec maps the loop to exactly true', () => {
    writeConfig('loops_deny_exec:\n  plan-loop: true\n');
    expect(readLoopExecAllowed(repo, 'plan-loop')).toBe(false);
  });

  it('is true (allowed by default) for a loop not on the deny list', () => {
    writeConfig('loops_deny_exec:\n  plan-loop: true\n');
    expect(readLoopExecAllowed(repo, 'impl-loop')).toBe(true);
  });

  it('is true when the deny value is not the boolean true (only an explicit true opts out)', () => {
    writeConfig('loops_deny_exec:\n  plan-loop: "true"\n');
    expect(readLoopExecAllowed(repo, 'plan-loop')).toBe(true);
  });

  it('is true when loops_deny_exec is absent', () => {
    writeConfig('loops:\n  plan-loop: ./plan-loop.yaml\n');
    expect(readLoopExecAllowed(repo, 'plan-loop')).toBe(true);
  });

  it('is true (fails open, never throws) when .agent-loop.yaml is missing or unparseable', () => {
    expect(readLoopExecAllowed(repo, 'plan-loop')).toBe(true);
    writeConfig(': not : valid : yaml :\n  - [\n');
    expect(readLoopExecAllowed(repo, 'plan-loop')).toBe(true);
  });
});

describe('artifactPath (§26.6 {{artifact.<id>}} resolution)', () => {
  let repo: string;
  let configDir: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'loopexec-repo-'));
    configDir = mkdtempSync(join(tmpdir(), 'loopexec-config-'));
    mkdirSync(join(configDir, 'loops', 'plan-loop'), { recursive: true });
    writeFileSync(join(configDir, 'loops', 'plan-loop', 'plan-loop.yaml'), DEF_WITH_ARTIFACTS);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it('resolves a known artifact id to its path under <repo>/.agent-loop/', () => {
    const def = parseLoopDef(repo, 'plan-loop', configDir)!;
    expect(artifactPath(def, repo, 'ticket-body')).toBe(join(repo, '.agent-loop', 'ticket.md'));
  });

  it('returns null for an unknown artifact id', () => {
    const def = parseLoopDef(repo, 'plan-loop', configDir)!;
    expect(artifactPath(def, repo, 'no-such')).toBeNull();
  });

  it('returns null for a path_pattern that escapes .agent-loop/ (CWE-22)', () => {
    const def = parseLoopDef(repo, 'plan-loop', configDir)!;
    expect(artifactPath(def, repo, 'escape')).toBeNull();
  });
});
