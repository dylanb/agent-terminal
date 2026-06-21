// Read-only resolver for the agent-loop LoopDef a flow step binds (§24.2.3 T2 / §18.1). A `loop`
// step names its loop (`loop: impl-loop`); the engine's real LoopDef yaml declares the gate model —
// each `gates[]` entry's `id` IS a status string, carrying that gate's `human_options` and `kind`.
// The app reads this read-only to surface the gate's options + whether the loop has reached a
// TERMINAL status. Resolution mirrors `agent-loop list`: a repo-local `.agent-loop.yaml` `loops:`
// registry override wins, else `$CLAUDE_CONFIG_DIR/loops/<name>/<name>.yaml` (default ~/.claude).
// Like the §19.1 store it NEVER throws — a missing / corrupt / wrong-schema / unknown LoopDef → null.

import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { isRecord } from './yamlRecord';

/** One gate of a LoopDef. `id` doubles as the agent-loop `status` it gates (e.g.
 *  `awaiting-human-pr-approval`); `humanOptions` is that gate's `human_options` (the gate UI's
 *  variable button set, §19.4); `terminal` is the loop's exit — `kind: terminal`. */
export interface LoopGate {
  id: string;
  kind: string;
  humanOptions: string[];
  terminal: boolean;
}

/** The gate slice of a LoopDef the flow reads (§18.1). The engine's other keys (personas, charters,
 *  labels) are irrelevant to the bridge and intentionally not modelled. */
export interface LoopDef {
  name: string;
  gates: LoopGate[];
}

const SCHEMA_VERSION = '4';

/** The engine reads `$CLAUDE_CONFIG_DIR/loops/`, defaulting to `~/.claude` (`agent-loop list`). */
function configLoopsDir(configDir?: string): string {
  const base = configDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  return path.join(base, 'loops');
}

/** Resolve a loop NAME to its LoopDef yaml path: a repo-local `.agent-loop.yaml` `loops:` registry
 *  override (resolved relative to the repo) wins; otherwise the bundled/user-authored config copy at
 *  `<configLoops>/<name>/<name>.yaml`. Returns the path to try — existence is the parser's concern. */
function resolveLoopDefPath(repoDir: string, name: string, configDir?: string): string {
  try {
    const raw = readFileSync(path.join(repoDir, '.agent-loop.yaml'), 'utf8');
    const doc = yaml.load(raw);
    if (isRecord(doc) && isRecord(doc.loops) && typeof doc.loops[name] === 'string') {
      const root = path.resolve(repoDir);
      const target = path.resolve(root, doc.loops[name]);
      // Refuse an override that escapes the repo (CWE-22), mirroring the todoTemplate loader (§20.2):
      // fall through to the trusted config-dir copy rather than read an arbitrary path.
      if (target === root || target.startsWith(root + path.sep)) {
        try {
          // Re-check the realpath so an in-repo symlink can't point OUT of the repo (CWE-59) — the
          // lexical guard above only sees the symlink's own in-repo path — and RETURN that validated
          // real path so the later read can't be redirected by a target swap (CWE-367 TOCTOU,
          // mirroring readArtifact). An escaping symlink falls through to the trusted config copy.
          const real = realpathSync(target);
          const realRoot = realpathSync(root);
          if (real === realRoot || real.startsWith(realRoot + path.sep)) return real;
          return path.join(configLoopsDir(configDir), name, `${name}.yaml`);
        } catch {
          return target; // dangling/unreadable in-repo override → let the parser yield null
        }
      }
    }
  } catch {
    // no/unreadable .agent-loop.yaml → fall through to the config-dir copy
  }
  return path.join(configLoopsDir(configDir), name, `${name}.yaml`);
}

function toGate(raw: unknown): LoopGate | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) return null;
  const kind = typeof raw.kind === 'string' ? raw.kind : '';
  const humanOptions = Array.isArray(raw.human_options)
    ? raw.human_options.filter((o): o is string => typeof o === 'string')
    : [];
  return { id: raw.id, kind, humanOptions, terminal: kind === 'terminal' };
}

/** Resolve + parse the LoopDef bound to `name` for `repoDir`. Returns its gate model, or null for a
 *  missing / corrupt / wrong-`schema_version` / gate-less file (never throws). */
export function parseLoopDef(repoDir: string, name: string, configDir?: string): LoopDef | null {
  let raw: string;
  try {
    raw = readFileSync(resolveLoopDefPath(repoDir, name, configDir), 'utf8');
  } catch {
    return null;
  }
  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch {
    return null;
  }
  if (!isRecord(doc)) return null;
  if (String(doc.schema_version) !== SCHEMA_VERSION) return null;
  if (!Array.isArray(doc.gates)) return null;
  const gates = doc.gates.map(toGate).filter((g): g is LoopGate => g !== null);
  if (gates.length === 0) return null;
  const defName = typeof doc.name === 'string' ? doc.name : name;
  return { name: defName, gates };
}

/** The gate whose `id` matches `status` (the agent-loop state-machine string), or undefined when the
 *  status is mid-work (no gate — the loop is running, not awaiting a human). */
export function gateForStatus(def: LoopDef, status: string): LoopGate | undefined {
  return def.gates.find((g) => g.id === status);
}
