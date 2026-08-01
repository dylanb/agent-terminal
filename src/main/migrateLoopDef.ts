// §B.6 / AC 5 — copy a resolved app-bundled §27 loop def into the operator tier the first time a loop step
// binds it, so the operator can edit it, and tell them ONCE. Best-effort: a failure degrades to "no copy,
// the step still runs on the app bundle" (CWE-703), never a throw into the transition path. The trigger — the
// def resolved from `ctx.tiers.appBundled` — is the composition root's; this module only performs the copy.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteTreeSync, type AtomicWriteTreeMember } from './atomicFile';
import { confinedRealPath, resolveOwnedDirJail } from './confinedPath';
import { readDirEntries } from './dirEntries';
import { errMsg } from './errno';

export interface MigrateBundledLoopDefParams {
  /** The def name. Held to a single safe path segment by `resolveLoopDefV2` upstream (§B.6); both tier-root
   *  joins below are independently confined (`confinedRealPath`), so a direct caller cannot escape either root. */
  name: string;
  /** The app-bundled tier root the def resolved from (`ctx.tiers.appBundled`). */
  appBundledDir: string;
  /** The operator tier root the copy lands in (`userConfigLoopsV2Dir()` = `ctx.tiers.operator`). */
  operatorDir: string;
  /** Test seam for the otherwise-unpredictable staging directory, threaded to `atomicWriteTreeSync`. */
  stageDir?: (destDir: string) => string;
}

/** A source member that is neither a regular file nor a directory — a symlink above all. The bundle is an
 *  installed artifact this build did not necessarily write, so it is never read through (CWE-59); it is
 *  REFUSED, not skipped, exactly as `installExamples`'s `walkFiles` refuses one (§18.1). */
const sourceAnomaly = (p: string): Error =>
  new Error(`the bundled loop def is damaged: a symbolic link or special file stands at ${p}`);

/** Read `<defDir>/**` into tree members — `relPath` POSIX-relative to `defDir`, `data` the file bytes (a def
 *  member may be a non-UTF-8 asset, so bytes not text). An absent def dir yields `[]`; an unreadable one
 *  throws (the `readDirEntries` absent-vs-unreadable split), and the caller wraps the throw. */
function readDefTree(defDir: string): AtomicWriteTreeMember[] {
  const members: AtomicWriteTreeMember[] = [];
  const walk = (dir: string): void => {
    for (const entry of readDirEntries(dir)) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory) walk(abs);
      else if (entry.isFile) members.push({ relPath: path.relative(defDir, abs).split(path.sep).join('/'), data: readFileSync(abs) });
      else throw sourceAnomaly(abs);
    }
  };
  walk(defDir);
  return members;
}

const migratedNotice = (name: string): string =>
  `Copied the built-in "${name}" loop into your config so you can customize it.`;
const containerRefusedNotice = (name: string, dir: string): string =>
  `Kept the built-in "${name}" loop — couldn't write to your config folder ${dir}.`;
const migrationFailedNotice = (name: string, e: unknown): string =>
  `Kept the built-in "${name}" loop — copying it into your config failed: ${errMsg(e)}.`;

/** `<rootDir>/<seg>` as a symlink-free real path confined within `rootDir`, or null when the root does not
 *  resolve or `seg` escapes it. `rootDir` is ground the app owns (the operator's config, the installed
 *  bundle), so a link the owner placed at the root itself is FOLLOWED (§18.1) while `seg` is confined WITHIN
 *  it (CWE-22/59). One derivation for both tier joins the migration makes — the read and the write cannot
 *  confine differently. */
function confinedChild(rootDir: string, seg: string): string | null {
  const jail = resolveOwnedDirJail(rootDir);
  return jail === null ? null : confinedRealPath(jail, path.join(jail, seg));
}

/** Copy `<appBundledDir>/<name>/**` into `<operatorDir>/<name>/` once, all-or-nothing (§B.6). Returns the
 *  one-shot operator-facing notice to accumulate on the transition reply (§B.5 position 6), or `null` when
 *  there is nothing to say: the def is already in the operator tier (AC 9 silent substitution — idempotent),
 *  a tier root does not resolve or its `<root>/<name>` escapes it, or the source raced away after it
 *  resolved. NEVER throws. */
export function migrateBundledLoopDef(params: MigrateBundledLoopDefParams): string | null {
  const { name, appBundledDir, operatorDir, stageDir } = params;
  try {
    // The bundle is an installed artifact this build did not necessarily write, so the read is confined
    // exactly as the write is: a `..` or a symlink at `<root>/<name>` that escapes yields no path, so the
    // read walks only what stays inside the bundle and the copy lands only inside the operator tier (§B.6).
    const destDir = confinedChild(operatorDir, name);
    const srcDir = confinedChild(appBundledDir, name);
    if (destDir === null || srcDir === null) return null;
    const members = readDefTree(srcDir);
    if (members.length === 0) return null; // source absent/empty (raced away): a copy of nothing is not a def
    const result = atomicWriteTreeSync(destDir, members, stageDir ? { stageDir } : {});
    if (result.ok) return migratedNotice(name);
    // A non-writable resolved tier root (0o555, the managed-machine case): the step still runs on the app
    // bundle, so this carries a notice, not a refusal (§B.6). A benign already-present def is the silent case.
    return result.cause === 'container-refused' ? containerRefusedNotice(name, operatorDir) : null;
  } catch (e) {
    // errMsg alone (§B.6): the classification is answered inside the primitive off the destination's shape,
    // so `isErrno` at the caller is both unimplementable (EACCES/ENOSPC are outside the closed union) and
    // wrong (it would re-key on errno the primitive deliberately does not). A failed write degrades to "no
    // copy, step still runs" and reports the real message rather than a bare failure.
    return migrationFailedNotice(name, e);
  }
}

/** The position-6 migration TRIGGER (§B.5/§B.6): decide whether entering `step` migrates its def, then do it.
 *  The affirmative test is on WHERE RESOLUTION STOPPED — the app-bundled tier root the caller supplied — never
 *  on the operator tier's silence. `resolveLoopDefV2` pushes a repo `.agent-loop.yaml` `loops:` override FIRST,
 *  so keying on silence would copy the app bundle into the operator's own tier at a cloned repo's request,
 *  where it then outranks the bundle for every repo forever (CWE-829/CWE-732). Returns the one-shot notice, or
 *  `null` when no migration fires (a repo/operator-tier resolution, a refused operator root, or a nameless
 *  step). Only `step.loop` and `resolved.tierRoot` are read — the narrowest slice the decision needs. */
export function migrateBundledLoopDefOnEntry(
  step: { loop?: string },
  resolved: { tierRoot: string },
  tiers: { appBundled: string; operator: string | null },
): string | null {
  if (resolved.tierRoot !== tiers.appBundled || tiers.operator === null || step.loop === undefined) return null;
  return migrateBundledLoopDef({ name: step.loop, appBundledDir: tiers.appBundled, operatorDir: tiers.operator });
}
