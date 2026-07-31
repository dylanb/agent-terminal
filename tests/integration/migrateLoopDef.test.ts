import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateBundledLoopDef, migrateBundledLoopDefOnEntry } from '../../src/main/migrateLoopDef';

// §B.6 / AC 5 — the first time a loop step binds a def that resolves from the app bundle, the whole def tree
// is copied into the operator's config tier so they can edit it, and they are told ONCE. The copy is
// best-effort: a failure degrades to "no copy, the step still runs on the bundle" and NEVER throws into the
// transition path (CWE-703). These are integration tests over a real filesystem — no fs mock (CLAUDE.md).

const NAME = 'plan-loop';

// A def is a DIRECTORY: `<name>.yaml` plus `charter/` and `prompts/` subtrees. The whole tree must copy —
// a partial copy is precisely the def that parses and cannot compose (§B.6).
function seedBundledDef(appBundledDir: string): void {
  const def = path.join(appBundledDir, NAME);
  mkdirSync(path.join(def, 'charter'), { recursive: true });
  mkdirSync(path.join(def, 'prompts'), { recursive: true });
  writeFileSync(path.join(def, `${NAME}.yaml`), 'work:\n  recipe: prompts/work.md\n');
  writeFileSync(path.join(def, 'charter', 'reviewers.md'), '# reviewers\n');
  writeFileSync(path.join(def, 'prompts', 'work.md'), '# work prompt\n');
}

let root: string;
let appBundledDir: string;
let operatorDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'migrate-loop-def-'));
  appBundledDir = path.join(root, 'app-bundled');
  operatorDir = path.join(root, 'operator');
  mkdirSync(appBundledDir, { recursive: true });
  mkdirSync(operatorDir, { recursive: true });
});

afterEach(() => {
  try {
    chmodSync(operatorDir, 0o755);
  } catch {}
  rmSync(root, { recursive: true, force: true });
});

describe('migrateBundledLoopDef (§B.6 / AC 5)', () => {
  it('copies the WHOLE def tree into the operator tier and returns a notice naming the def', () => {
    seedBundledDef(appBundledDir);

    const notice = migrateBundledLoopDef({ name: NAME, appBundledDir, operatorDir });

    expect(notice).not.toBeNull();
    expect(notice).toContain(NAME);
    const dest = path.join(operatorDir, NAME);
    expect(readFileSync(path.join(dest, `${NAME}.yaml`), 'utf8')).toBe('work:\n  recipe: prompts/work.md\n');
    expect(readFileSync(path.join(dest, 'charter', 'reviewers.md'), 'utf8')).toBe('# reviewers\n');
    expect(readFileSync(path.join(dest, 'prompts', 'work.md'), 'utf8')).toBe('# work prompt\n');
  });

  it('is idempotent: a def already in the operator tier is left byte-for-byte untouched and no notice is raised (AC 9)', () => {
    seedBundledDef(appBundledDir);
    const dest = path.join(operatorDir, NAME);
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, `${NAME}.yaml`), 'OPERATOR EDIT\n');

    const notice = migrateBundledLoopDef({ name: NAME, appBundledDir, operatorDir });

    expect(notice).toBeNull();
    expect(readFileSync(path.join(dest, `${NAME}.yaml`), 'utf8')).toBe('OPERATOR EDIT\n');
  });

  it.skipIf(process.getuid?.() === 0)(
    'a non-writable operator tier (0o555) copies nothing, raises a notice naming the folder, and the step still runs',
    () => {
      seedBundledDef(appBundledDir);
      chmodSync(operatorDir, 0o555);

      const notice = migrateBundledLoopDef({ name: NAME, appBundledDir, operatorDir });

      expect(notice).not.toBeNull();
      expect(notice).toContain(NAME);
      expect(notice).toContain(operatorDir);
      expect(existsSync(path.join(operatorDir, NAME))).toBe(false);
    },
  );

  it('a non-regular member in the source tree yields a notice (errMsg) and does NOT throw or write a partial tree', () => {
    const def = path.join(appBundledDir, NAME);
    mkdirSync(def, { recursive: true });
    writeFileSync(path.join(def, `${NAME}.yaml`), 'work:\n');
    symlinkSync('/etc/passwd', path.join(def, 'link.md'));

    let notice: string | null = null;
    expect(() => {
      notice = migrateBundledLoopDef({ name: NAME, appBundledDir, operatorDir });
    }).not.toThrow();
    expect(notice).not.toBeNull();
    expect(existsSync(path.join(operatorDir, NAME))).toBe(false);
  });

  it('refuses a source def dir that is a symlink escaping the app bundle — reads nothing outside it and copies nothing (CWE-59/CWE-22)', () => {
    // A tampered bundle (an installed artifact this build did not necessarily write): `<appBundledDir>/<NAME>`
    // is itself a symlink to a directory OUTSIDE the bundle root. The read must confine the same way the write
    // does, or it follows the link and copies whatever it points at into the operator's own tier.
    const outside = path.join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'secret.md'), 'SECRET\n');
    symlinkSync(outside, path.join(appBundledDir, NAME));

    const notice = migrateBundledLoopDef({ name: NAME, appBundledDir, operatorDir });

    expect(notice).toBeNull();
    expect(existsSync(path.join(operatorDir, NAME))).toBe(false);
    expect(existsSync(path.join(operatorDir, NAME, 'secret.md'))).toBe(false);
  });

  it('a config root the app declines to resolve (a dangling-symlink parent) yields no write and no notice', () => {
    seedBundledDef(appBundledDir);
    const danglingParent = path.join(root, 'dangling');
    symlinkSync(path.join(root, 'does-not-exist'), danglingParent);
    const unresolvable = path.join(danglingParent, 'loops-v2');

    const notice = migrateBundledLoopDef({ name: NAME, appBundledDir, operatorDir: unresolvable });

    expect(notice).toBeNull();
  });

  it('an absent source def (raced away after it resolved) copies nothing and raises no notice', () => {
    const notice = migrateBundledLoopDef({ name: NAME, appBundledDir, operatorDir });

    expect(notice).toBeNull();
    expect(existsSync(path.join(operatorDir, NAME))).toBe(false);
  });
});

// §D.4 (row 2842) / §B.6 — the position-6 migration TRIGGER. The write fires ONLY when resolution stopped at
// the app-bundled tier root the caller supplied, never on the operator tier's silence: resolveLoopDefV2 pushes
// a repo `.agent-loop.yaml` override FIRST, so keying on silence would copy the bundle into the operator's own
// tier at a cloned repo's request, where it then outranks the bundle for every repo forever (CWE-829/CWE-732).
describe('migrateBundledLoopDefOnEntry — the trigger fires only when resolution stopped at the app bundle', () => {
  const tiers = () => ({ appBundled: appBundledDir, operator: operatorDir });

  it('does NOT migrate a def that resolved from a REPO override — the operator tier is left untouched (CWE-829/732)', () => {
    seedBundledDef(appBundledDir); // the bundle HAS the def…
    const repoDir = path.join(root, 'a-cloned-repo');
    // …but resolution stopped at the repo tier (the repo's own registry answered first)
    const notice = migrateBundledLoopDefOnEntry({ loop: NAME }, { tierRoot: repoDir }, tiers());
    expect(notice).toBeNull();
    expect(existsSync(path.join(operatorDir, NAME))).toBe(false);
  });

  it('does NOT migrate a def that resolved from the OPERATOR tier (they already have their own)', () => {
    seedBundledDef(appBundledDir);
    const notice = migrateBundledLoopDefOnEntry({ loop: NAME }, { tierRoot: operatorDir }, tiers());
    expect(notice).toBeNull();
    expect(existsSync(path.join(operatorDir, NAME))).toBe(false);
  });

  it('does NOT migrate when the operator tier is refused (null) — there is nowhere to write', () => {
    seedBundledDef(appBundledDir);
    const notice = migrateBundledLoopDefOnEntry({ loop: NAME }, { tierRoot: appBundledDir }, { appBundled: appBundledDir, operator: null });
    expect(notice).toBeNull();
  });

  it('does NOT migrate a step that carries no loop name', () => {
    seedBundledDef(appBundledDir);
    const notice = migrateBundledLoopDefOnEntry({}, { tierRoot: appBundledDir }, tiers());
    expect(notice).toBeNull();
  });

  it('DOES migrate when resolution stopped at the app-bundled tier and the operator tier exists', () => {
    seedBundledDef(appBundledDir);
    const notice = migrateBundledLoopDefOnEntry({ loop: NAME }, { tierRoot: appBundledDir }, tiers());
    expect(notice).not.toBeNull();
    expect(notice).toContain(NAME);
    expect(existsSync(path.join(operatorDir, NAME))).toBe(true); // the copy landed in the operator tier
  });
});
