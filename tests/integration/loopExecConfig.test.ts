import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLoopDef, artifactPath, loopExecAllowed, readLoopExecAllowed } from '../../src/main/loopDef';

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

  it('resolves a known artifact id to its symlink-free real path under <repo>/.agent-loop/', () => {
    // Returns the RESOLVED path (not the lexical one), so a repo that swaps `.agent-loop` for a symlink
    // between this check and `gh` reading the file cannot redirect the read (CWE-367 — symmetric with
    // resolveLoopDefPath). When `.agent-loop/ticket.md` exists, realpath yields the confined absolute path.
    mkdirSync(join(repo, '.agent-loop'), { recursive: true });
    writeFileSync(join(repo, '.agent-loop', 'ticket.md'), 'body');
    const def = parseLoopDef(repo, 'plan-loop', configDir)!;
    expect(artifactPath(def, repo, 'ticket-body')).toBe(realpathSync(join(repo, '.agent-loop', 'ticket.md')));
  });

  it('returns null for an unknown artifact id', () => {
    const def = parseLoopDef(repo, 'plan-loop', configDir)!;
    expect(artifactPath(def, repo, 'no-such')).toBeNull();
  });

  it('returns null for a path_pattern that escapes .agent-loop/ (CWE-22)', () => {
    const def = parseLoopDef(repo, 'plan-loop', configDir)!;
    expect(artifactPath(def, repo, 'escape')).toBeNull();
  });

  it('returns null when .agent-loop itself is a symlink pointing outside the repo (CWE-59)', () => {
    // Confining against `realpath(.agent-loop)` would adopt the symlink's target as the jail: a repo that
    // commits `.agent-loop -> /some/dir` could then publish `/some/dir/ticket.md`. The confinement dir must
    // be computed under the repo root without following a `.agent-loop` link.
    const outsideDir = mkdtempSync(join(tmpdir(), 'loopexec-outside-'));
    writeFileSync(join(outsideDir, 'ticket.md'), 'SECRET');
    try {
      symlinkSync(outsideDir, join(repo, '.agent-loop'));
      const def = parseLoopDef(repo, 'plan-loop', configDir)!;
      expect(artifactPath(def, repo, 'ticket-body')).toBeNull();
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('returns null when the resolved artifact is a symlink pointing outside .agent-loop/ (CWE-59)', () => {
    // `gh issue edit --body-file <resolved>` FOLLOWS the link, so a lexical prefix check publishes the
    // link's target. A resumed run never wipes `.agent-loop/`, so a link committed in the repo survives.
    const secret = join(repo, 'id_rsa');
    writeFileSync(secret, 'PRIVATE KEY');
    mkdirSync(join(repo, '.agent-loop'), { recursive: true });
    symlinkSync(secret, join(repo, '.agent-loop', 'ticket.md'));
    const def = parseLoopDef(repo, 'plan-loop', configDir)!;
    expect(artifactPath(def, repo, 'ticket-body')).toBeNull();
  });

  it('returns null for a path_pattern carrying an unexpanded {slot} (never a literal `{iter}` directory)', () => {
    // The def calls the field a *pattern* and the vendored plan-loop templates it (`human-notes/{iter}.md`).
    // Resolving it verbatim yields a real path, so interpolateExecArgv's "skip unless fully resolved" guard
    // never fires and `gh` runs against a literal `{iter}` component.
    writeFileSync(
      join(configDir, 'loops', 'plan-loop', 'plan-loop.yaml'),
      DEF_WITH_ARTIFACTS + '  - id: human-note\n    path_pattern: "human-notes/{iter}.md"\n',
    );
    const def = parseLoopDef(repo, 'plan-loop', configDir)!;
    expect(artifactPath(def, repo, 'human-note')).toBeNull();
  });
});

// §26.6 — `exec` runs an arbitrary argv named by the LoopDef. The opt-out policy (v2.122) is premised on
// that def being "(operator-authored/vendored)". A repo-local `.agent-loop.yaml` `loops:` override makes the
// def repo content, so the premise — and with it the whole policy — only holds for a def resolved from the
// operator's config dir. `loops_deny_exec` lives in the same repo file and can never be the security control.
describe('loopExecAllowed (§26.6 — exec only for an operator-authored def, CWE-829)', () => {
  let repo: string;
  let configDir: string;
  const DEF =
    'name: plan-loop\nschema_version: "4"\n' +
    'gates:\n  - id: awaiting-human-plan-approval\n    kind: approve-required\n    human_options: [approve]\n';
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'loopexec-repo-'));
    configDir = mkdtempSync(join(tmpdir(), 'loopexec-config-'));
    mkdirSync(join(configDir, 'loops', 'plan-loop'), { recursive: true });
    writeFileSync(join(configDir, 'loops', 'plan-loop', 'plan-loop.yaml'), DEF);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  it('allows exec for a def resolved from the operator config dir with no deny key', () => {
    const def = parseLoopDef(repo, 'plan-loop', configDir)!;
    expect(def.origin).toBe('operator-config');
    expect(loopExecAllowed(def, repo, 'plan-loop')).toBe(true);
  });

  it('refuses exec for a def the repo redirected to its own in-repo yaml, even with no deny key', () => {
    writeFileSync(join(repo, '.agent-loop.yaml'), 'loops:\n  plan-loop: ./evil.yaml\n');
    writeFileSync(join(repo, 'evil.yaml'), DEF);
    const def = parseLoopDef(repo, 'plan-loop', configDir)!;
    expect(def.origin).toBe('repo');
    expect(loopExecAllowed(def, repo, 'plan-loop')).toBe(false);
  });

  it('refuses exec for a repo-supplied def that also opts ITSELF in via the same untrusted file', () => {
    writeFileSync(
      join(repo, '.agent-loop.yaml'),
      'loops:\n  plan-loop: ./evil.yaml\nloops_deny_exec:\n  plan-loop: false\n',
    );
    writeFileSync(join(repo, 'evil.yaml'), DEF);
    const def = parseLoopDef(repo, 'plan-loop', configDir)!;
    expect(loopExecAllowed(def, repo, 'plan-loop')).toBe(false);
  });

  it('still honors the loops_deny_exec opt-out for an operator-authored def', () => {
    writeFileSync(join(repo, '.agent-loop.yaml'), 'loops_deny_exec:\n  plan-loop: true\n');
    const def = parseLoopDef(repo, 'plan-loop', configDir)!;
    expect(def.origin).toBe('operator-config');
    expect(loopExecAllowed(def, repo, 'plan-loop')).toBe(false);
  });
});
