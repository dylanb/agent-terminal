// Read-only resolver for the agent-loop LoopDef a flow step binds (§24.2.3 T2 / §18.1). The engine
// owns the LoopDef yaml schema; this reads only the gate slice. Resolution mirrors `agent-loop list`.
// Like the §19.1 store it NEVER throws — every failure mode degrades to null.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { confinedRealPath, resolveJail } from './confinedPath';
import { isRecord } from './yamlRecord';
import { userConfigLoopsDir } from './userConfig';

/** One action of a gate's `on_*` list (§26.6): the engine executes these in order when the human picks
 *  an option. `kind` selects the effect (`mark-pr-ready`, `set-phase2`, …); `args` carries its params
 *  verbatim (e.g. `{active: true}`). The orchestrator translates recognized kinds to domain effects
 *  (`gateActions.ts`) and ignores the rest. */
export interface GateAction {
  kind: string;
  args?: Record<string, unknown>;
}

/** One gate of a LoopDef. `id` IS the agent-loop `status` it gates; `humanOptions` mirrors the yaml
 *  `human_options` (the gate UI's button set, §19.4); `terminal` is `kind: terminal`. The `on*`/`nextStatus*`
 *  fields (§26.6 / L5) drive the app-internal transition each option performs. */
export interface LoopGate {
  id: string;
  kind: string;
  humanOptions: string[];
  terminal: boolean;
  onApprove: GateAction[];
  onRequestChanges: GateAction[];
  onImpasse: GateAction[];
  nextStatusOnApprove: string;
  nextStatusOnRequestChanges: string;
  nextStatusOnImpasse: string;
}

/** One resolved label mutation from a pickup_contract `initial_labels` entry (§26.9): the slot has
 *  already been resolved to its concrete label string against the target-scoped label map. */
export interface PickupLabel {
  action: 'add' | 'remove';
  label: string;
  target: 'issue' | 'pr';
}

/** The bound LoopDef's bootstrap (pickup) contract (§26.5 / §26.9) — drives in-app pickup instead of
 *  hardcoding it. Slots in `initial_labels` are resolved to concrete strings at parse time; an
 *  unresolvable slot is dropped (best-effort, never throws). Absent when the def has no contract. */
export interface PickupContract {
  initialStatus: string;
  initialBranchTpl: string;
  initialPrBodyRef: string;
  initialLabels: PickupLabel[];
  onConflict: string;
}

/** The bound LoopDef's `resume_contract` (§26.5 / §26.11) — drives auto-resume of an interrupted run.
 *  `midIterSafe` false rewinds to the iteration start; true re-enters the earliest turn whose
 *  iteration-scoped artifact is missing (the sequence is derived in `decideResume`, loopResume.ts).
 *  Undefined when the def carries no `resume_contract`.
 *  TODO(loop-engine): per-actor replay (§26.11 `replay_actors`/`skip_actors`) is not yet modeled. */
export interface ResumeContract {
  midIterSafe: boolean;
}

/** The orchestrator-relevant slice of a LoopDef phase (§26.5): its `id` and the `entry_status` a run
 *  sits at while that phase's work turn is active — so a status maps back to the phase whose work
 *  prompt (`prompts/work-{id}.md`) and artifacts the orchestrator must drive. */
export interface LoopPhase {
  id: string;
  entryStatus: string;
  /** A non-empty `roster_override_id` binds this phase to a named roster; "" inherits the default. */
  rosterOverrideId: string;
  /** The status a `clean` consolidate verdict advances this phase to (§26.6) — a human gate that STOPs
   *  the loop; "" when the def omits it. */
  postCleanGate: string;
  /** The status a `needs-work` verdict routes to when phase-2/at-cap (§26.6/§26.8); "" when omitted. */
  postNeedsWorkGate: string;
  /** `exit_predicate.severity_cap` (§26.8): the per-phase iteration cap at which a `needs-work` verdict
   *  routes to the triage gate. 0 when the def names no cap (never at cap). */
  iterationCap: number;
  // TODO(loop-engine): the per-phase `exit_predicate.on_phase2_active` override (§26.6) is not modeled —
  // decideConsolidateOutcome routes off the RUNTIME phase2Active flag, so phase-2 always triages. Re-added
  // to the parsed phase when an asymmetric-per-phase def actually needs it (§26.11 drop-until-built precedent).
}

/** One entry of the §26.5 roster catalog: a named ordered list of reviewer persona actors. */
export interface LoopRoster {
  id: string;
  actors: string[];
}

/** The §26.5 `verdicts` taxonomy the consolidator applies (§26.3/D45): the consolidated verdict's
 *  canonical values + the synonym→canonical map. The orchestrator reads it to normalize the verdict
 *  the consolidator wrote back before branching (§26.6). */
export interface LoopVerdicts {
  /** Lowercased synonym → canonical verdict; canonical values map to themselves in the real defs. */
  consolidatedSynonyms: Record<string, string>;
  /** Lowercased PERSONA-verdict synonym → canonical (`clean`/`concerns`) — the taxonomy the §26.5 skip-opt
   *  applies to decide who reviewed clean. {} when the def omits it. */
  personaSynonyms: Record<string, string>;
  /** `verdicts.severities.order` (ascending, least-severe first) — the order the §26.8 finding signature
   *  sorts by; [] when the def omits it. */
  severityOrder: string[];
}

/** The gate slice of a LoopDef the flow reads (§18.1) plus the phase/roster/pickup_contract fields the
 *  orchestrator drives from (§26.4/§26.5/§26.9); the engine's other keys are intentionally not modelled. */
export interface LoopDef {
  name: string;
  gates: LoopGate[];
  phases: LoopPhase[];
  /** The §26.5 roster catalog + the catalog's default roster id — the source of the §26.4 fan-out roster. */
  rosters: LoopRoster[];
  defaultRosterId: string;
  /** The consolidated-verdict taxonomy (§26.5); undefined when the def carries no `verdicts` mapping. */
  verdicts?: LoopVerdicts;
  pickup?: PickupContract;
  /** The §26.11 resume contract; undefined when the def carries no `resume_contract`. */
  resume?: ResumeContract;
  /** §26.6 — the `artifacts` slot map (id → `.agent-loop/`-relative `path_pattern`), the source that
   *  resolves an `exec` action's `{{artifact.<id>}}` placeholder to a real path. {} when the def omits it. */
  artifacts: Record<string, string>;
  /** §26.3/D47a — the REPO-relative file the WORK turn must produce to be "done": the agent
   *  verifies it on disk before signalling done, and the runner gates completion on it. `.agent-loop/plan.md`
   *  for a loop that PRODUCES the plan (its `plan` artifact has a producer); `""` for a loop that CONSUMES
   *  the plan as a pre-authored input (impl-loop) — that loop's work is code/commits, so its work turn
   *  completes on the turn-done file alone. One definition, read by both the prompt recipe and the runner
   *  gate, so the injected instruction and the completion check cannot desync (CLAUDE.md shared-semantics). */
  workArtifact: string;
  /** Whose authority this def's bytes carry — see `LoopDefOrigin`. Gates the §26.6 `exec` capability. */
  origin: LoopDefOrigin;
}

const SCHEMA_VERSION = '4';

// Loop names, phase ids, and persona/actor names all become filesystem path components downstream — the
// loop name selects `<configLoops>/<name>/` (and the dir its injected prompts §26.5 are read from), phase
// ids form `prompts/work-{id}.md`, actor names form `reviews/{iter}/{actor}.json`. Repo-supplied config
// (flow.yaml `loop:`, the `.agent-loop.yaml` override, the LoopDef yaml) is untrusted, so every such
// string is confined to a single safe path-segment — no separators or `..` (CWE-22 defense in depth).
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Where a LoopDef's bytes came from, and therefore whose authority they carry: `operator-config` is the
 *  user's own `<configLoops>/` copy; `repo` is a file inside the checked-out repository, i.e. untrusted
 *  content authored by whoever wrote the repo. Capabilities that let a def act on the machine (§26.6
 *  `exec`) are granted on this distinction, never on anything the repo itself asserts. */
export type LoopDefOrigin = 'operator-config' | 'repo';

interface ResolvedLoopDef {
  path: string;
  origin: LoopDefOrigin;
}

/** Resolve a loop NAME to its LoopDef yaml path: a repo-local `.agent-loop.yaml` `loops:` registry
 *  override (resolved relative to the repo) wins; otherwise the bundled/user-authored config copy at
 *  `<configLoops>/<name>/<name>.yaml`. Returns the path to try (existence is the parser's concern) with
 *  its origin, or null when the name is not a single safe path segment — never a traversal lever. */
function resolveLoopDefPath(repoDir: string, name: string, configDir?: string): ResolvedLoopDef | null {
  if (!SAFE_NAME.test(name)) return null;
  const fromConfig: ResolvedLoopDef = {
    path: path.join(userConfigLoopsDir(configDir), name, `${name}.yaml`),
    origin: 'operator-config',
  };
  try {
    const raw = readFileSync(path.join(repoDir, '.agent-loop.yaml'), 'utf8');
    const doc = yaml.load(raw);
    if (isRecord(doc) && isRecord(doc.loops) && typeof doc.loops[name] === 'string') {
      const root = path.resolve(repoDir);
      const target = path.resolve(root, doc.loops[name]);
      const jail = resolveJail(root);
      // §20.2
      if (jail !== null && (target === root || target.startsWith(root + path.sep))) {
        const real = confinedRealPath(jail, target);
        if (real !== null) return { path: real, origin: 'repo' };
      }
    }
  } catch {
    // no/unreadable .agent-loop.yaml → config-dir copy
  }
  return fromConfig;
}

/** The directory that holds a loop's def + its `prompts/`, `charter/`, `skills/` (§26.5) — the parent
 *  of the resolved LoopDef yaml, so prompt/recipe assembly reads from the same source the parser used.
 *  Null when the name does not resolve to a safe path (see resolveLoopDefPath). */
export function resolveLoopDir(repoDir: string, name: string, configDir?: string): string | null {
  const resolved = resolveLoopDefPath(repoDir, name, configDir);
  return resolved === null ? null : path.dirname(resolved.path);
}

/** The orchestrator-relevant slice of `phases` (§26.5): id + entry_status + roster binding; malformed or
 *  unsafe-named entries drop. `roster_override_id` is optional (absent → "" = inherit the catalog default). */
function toPhases(doc: Record<string, unknown>): LoopPhase[] {
  if (!Array.isArray(doc.phases)) return [];
  return doc.phases
    .map((p): LoopPhase | null => {
      if (!isRecord(p) || typeof p.id !== 'string' || !SAFE_NAME.test(p.id) || typeof p.entry_status !== 'string') {
        return null;
      }
      const exit = isRecord(p.exit_predicate) ? p.exit_predicate : {};
      return {
        id: p.id,
        entryStatus: p.entry_status,
        rosterOverrideId: typeof p.roster_override_id === 'string' ? p.roster_override_id : '',
        postCleanGate: typeof p.post_clean_gate === 'string' ? p.post_clean_gate : '',
        postNeedsWorkGate: typeof p.post_needs_work_gate === 'string' ? p.post_needs_work_gate : '',
        iterationCap: typeof exit.severity_cap === 'number' && exit.severity_cap > 0 ? exit.severity_cap : 0,
      };
    })
    .filter((p): p is LoopPhase => p !== null);
}

/** The §26.5 roster catalog: each `rosters[]` entry's id + `ordered_actors` (the fan-out roster, §26.4).
 *  Malformed entries drop; a non-string actor in an entry is dropped from that entry. */
function toRosters(doc: Record<string, unknown>): LoopRoster[] {
  if (!Array.isArray(doc.rosters)) return [];
  return doc.rosters
    .map((r): LoopRoster | null =>
      isRecord(r) && typeof r.id === 'string'
        ? {
            id: r.id,
            actors: Array.isArray(r.ordered_actors)
              ? r.ordered_actors.filter((a): a is string => typeof a === 'string' && SAFE_NAME.test(a))
              : [],
          }
        : null,
    )
    .filter((r): r is LoopRoster => r !== null);
}

/** The §26.5 `verdicts.consolidated` slice (§26.3/D45): the synonym map the orchestrator normalizes a read
 *  verdict against, degrading to empty when absent/ill-typed. Only the consolidated verdict is modelled —
 *  the persona verdict taxonomy is the reviewers' concern, not the orchestrator's branch. */
function toVerdicts(doc: Record<string, unknown>): LoopVerdicts | undefined {
  const v = doc.verdicts;
  if (!isRecord(v) || !isRecord(v.consolidated)) return undefined;
  const c = v.consolidated;
  const toSynonyms = (raw: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (isRecord(raw)) {
      for (const [syn, canon] of Object.entries(raw)) if (typeof canon === 'string') out[syn.toLowerCase()] = canon;
    }
    return out;
  };
  const consolidatedSynonyms = toSynonyms(c.synonyms);
  const personaSynonyms = isRecord(v.persona) ? toSynonyms(v.persona.synonyms) : {};
  const severityOrder =
    isRecord(v.severities) && Array.isArray(v.severities.order)
      ? v.severities.order.filter((x): x is string => typeof x === 'string')
      : [];
  return { consolidatedSynonyms, personaSynonyms, severityOrder };
}

/** Read the resume_contract slice (§26.5 / §26.11); undefined when the def carries no `resume_contract`.
 *  Never throws — a malformed field degrades to its empty/default. */
function toResumeContract(doc: Record<string, unknown>): ResumeContract | undefined {
  const rc = doc.resume_contract;
  if (!isRecord(rc)) return undefined;
  return { midIterSafe: rc.mid_iter_safe === true };
}

/** One `on_*` action list entry → GateAction; drops a non-mapping/kind-less entry (best-effort). */
function toGateAction(raw: unknown): GateAction | null {
  if (!isRecord(raw) || typeof raw.kind !== 'string') return null;
  return isRecord(raw.args) ? { kind: raw.kind, args: raw.args } : { kind: raw.kind };
}

function toGateActions(raw: unknown): GateAction[] {
  return Array.isArray(raw) ? raw.map(toGateAction).filter((a): a is GateAction => a !== null) : [];
}

function toGate(raw: unknown): LoopGate | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) return null;
  const kind = typeof raw.kind === 'string' ? raw.kind : '';
  const humanOptions = Array.isArray(raw.human_options)
    ? raw.human_options.filter((o): o is string => typeof o === 'string')
    : [];
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    id: raw.id,
    kind,
    humanOptions,
    terminal: kind === 'terminal',
    onApprove: toGateActions(raw.on_approve),
    onRequestChanges: toGateActions(raw.on_request_changes),
    onImpasse: toGateActions(raw.on_impasse),
    nextStatusOnApprove: str(raw.next_status_on_approve),
    nextStatusOnRequestChanges: str(raw.next_status_on_request_changes),
    nextStatusOnImpasse: str(raw.next_status_on_impasse),
  };
}

/** The engine stores label-slot→string maps under config_bindings entries keyed by `yaml_path`
 *  (`labels.pr` / `labels.issue`). Pull the `default` string-map for one path; {} when absent. */
function labelSlotMap(doc: Record<string, unknown>, yamlPath: string): Record<string, string> {
  const bindings = doc.config_bindings;
  if (!Array.isArray(bindings)) return {};
  const entry = bindings.find((b) => isRecord(b) && b.yaml_path === yamlPath);
  if (!isRecord(entry) || !isRecord(entry.default)) return {};
  const out: Record<string, string> = {};
  for (const [slot, label] of Object.entries(entry.default)) if (typeof label === 'string') out[slot] = label;
  return out;
}

/** Resolve one `initial_labels` slot entry to a concrete PickupLabel, or null when the entry is
 *  ill-typed or its slot has no mapping in the target's label map (dropped, best-effort §26.9). */
function toPickupLabel(
  raw: unknown,
  prMap: Record<string, string>,
  issueMap: Record<string, string>,
): PickupLabel | null {
  if (!isRecord(raw)) return null;
  const action = raw.action;
  const target = raw.target;
  if ((action !== 'add' && action !== 'remove') || (target !== 'issue' && target !== 'pr')) return null;
  if (typeof raw.slot !== 'string') return null;
  const label = (target === 'pr' ? prMap : issueMap)[raw.slot];
  return typeof label === 'string' ? { action, label, target } : null;
}

/** Read the pickup_contract slice (§26.5 / §26.9) with its label slots resolved; undefined when the
 *  def carries no `pickup_contract` mapping. Never throws — a malformed field degrades to undefined. */
function toPickupContract(doc: Record<string, unknown>): PickupContract | undefined {
  const pc = doc.pickup_contract;
  if (!isRecord(pc)) return undefined;
  const prMap = labelSlotMap(doc, 'labels.pr');
  const issueMap = labelSlotMap(doc, 'labels.issue');
  const initialLabels = Array.isArray(pc.initial_labels)
    ? pc.initial_labels.map((l) => toPickupLabel(l, prMap, issueMap)).filter((l): l is PickupLabel => l !== null)
    : [];
  return {
    initialStatus: typeof pc.initial_status === 'string' ? pc.initial_status : '',
    initialBranchTpl: typeof pc.initial_branch_tpl === 'string' ? pc.initial_branch_tpl : '',
    initialPrBodyRef: typeof pc.initial_pr_body_ref === 'string' ? pc.initial_pr_body_ref : '',
    initialLabels,
    onConflict: typeof pc.on_conflict === 'string' ? pc.on_conflict : '',
  };
}

/** The §26.6 `artifacts` list → id→path_pattern map: the source that resolves an `exec` action's
 *  `{{artifact.<id>}}` placeholder. Non-mapping / non-string entries drop; {} when the def omits it. */
function toArtifacts(doc: Record<string, unknown>): Record<string, string> {
  if (!Array.isArray(doc.artifacts)) return {};
  const out: Record<string, string> = {};
  for (const a of doc.artifacts) {
    if (isRecord(a) && typeof a.id === 'string' && typeof a.path_pattern === 'string') out[a.id] = a.path_pattern;
  }
  return out;
}

/** §26.3/D47a — derive the work turn's completion artifact from the `plan` artifact's PRODUCER: a loop that
 *  produces the plan (`producer` non-empty) gates its work turn on that file; a loop that consumes the plan
 *  as an external input (`producer: ""`, impl-loop) has no work-turn file deliverable → "". Keyed only off
 *  the `plan` artifact so a scratch file the work agent also writes (impl-loop `notes.md`) is never mistaken
 *  for the deliverable. "" on any missing / ill-typed / producer-less plan entry (never throws). */
function toWorkArtifact(doc: Record<string, unknown>): string {
  if (!Array.isArray(doc.artifacts)) return '';
  const plan = doc.artifacts.find((a) => isRecord(a) && a.id === 'plan');
  if (!isRecord(plan) || typeof plan.path_pattern !== 'string') return '';
  if (typeof plan.producer !== 'string' || plan.producer.trim() === '') return '';
  return path.join('.agent-loop', plan.path_pattern);
}

/** A `path_pattern` slot the def templates per iteration (`human-notes/{iter}.md`, §26.6). */
const UNEXPANDED_SLOT = /\{[^}]*\}/;

/** Resolve an `exec` action's `{{artifact.<id>}}` to a symlink-free absolute path under
 *  `<repoDir>/.agent-loop/` (§26.6). Null when the id is unknown, its `path_pattern` (untrusted def config)
 *  still carries an unexpanded `{slot}`, or the path escapes that dir either lexically (CWE-22) or through a
 *  symlink the consuming command would follow (CWE-59). Existence is the caller's concern. */
export function artifactPath(def: LoopDef, repoDir: string, id: string): string | null {
  const pattern = def.artifacts[id];
  if (typeof pattern !== 'string') return null;
  if (UNEXPANDED_SLOT.test(pattern)) return null;
  const jail = resolveJail(repoDir, '.agent-loop');
  if (jail === null) return null;
  return confinedRealPath(jail, path.resolve(repoDir, '.agent-loop', pattern));
}

/** §26.6 — whether the `exec` gate action may run for `loopName`. exec is allowed by DEFAULT for every
 *  loop; a repo opts a loop OUT via `.agent-loop.yaml` `loops_deny_exec: {<loop>: true}`. Fails OPEN
 *  (allowed) on any missing / unreadable / unparseable config — never throws. This is the operator's
 *  convenience switch over their OWN defs, not a security control: it lives in the repo. See
 *  `loopExecAllowed`, which is the decision every caller must ask. */
export function readLoopExecAllowed(repoDir: string, loopName: string): boolean {
  try {
    const doc = yaml.load(readFileSync(path.join(repoDir, '.agent-loop.yaml'), 'utf8'));
    if (isRecord(doc) && isRecord(doc.loops_deny_exec) && doc.loops_deny_exec[loopName] === true) return false;
  } catch {
    // no/unreadable/unparseable .agent-loop.yaml → allowed (opt-out default)
  }
  return true;
}

/** §26.6 — whether this gate may run `def`'s `exec` argv. `exec` names the PROGRAM, not just its
 *  arguments, so a def the repo supplied would be arbitrary code execution on Approve (CWE-829): the
 *  opt-out policy is premised on an operator-authored def, and only `origin` establishes that. The
 *  repo's own `loops_deny_exec` can then subtract, never add. */
export function loopExecAllowed(def: LoopDef, repoDir: string, loopName: string): boolean {
  if (def.origin !== 'operator-config') return false;
  return readLoopExecAllowed(repoDir, loopName);
}

/** Resolve + parse the LoopDef bound to `name` for `repoDir`. Returns its gate model + pickup contract,
 *  or null for a missing / corrupt / wrong-`schema_version` / gate-less file (never throws). */
export function parseLoopDef(repoDir: string, name: string, configDir?: string): LoopDef | null {
  const resolved = resolveLoopDefPath(repoDir, name, configDir);
  if (resolved === null) return null;
  let raw: string;
  try {
    raw = readFileSync(resolved.path, 'utf8');
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
  const pickup = toPickupContract(doc);
  const phases = toPhases(doc);
  const rosters = toRosters(doc);
  const defaultRosterId = typeof doc.default_roster_id === 'string' ? doc.default_roster_id : '';
  const verdicts = toVerdicts(doc);
  const resume = toResumeContract(doc);
  const artifacts = toArtifacts(doc);
  const workArtifact = toWorkArtifact(doc);
  return {
    name: defName,
    gates,
    phases,
    rosters,
    defaultRosterId,
    artifacts,
    workArtifact,
    origin: resolved.origin,
    ...(verdicts ? { verdicts } : {}),
    ...(pickup ? { pickup } : {}),
    ...(resume ? { resume } : {}),
  };
}

/** The reviewer fan-out roster for `phaseId` (§26.4): the phase's `roster_override_id` if set, else the
 *  catalog `default_roster_id`, resolved to its ordered actors. Empty when the phase or roster is absent. */
export function reviewerRosterForPhase(def: LoopDef, phaseId: string): string[] {
  const phase = def.phases.find((p) => p.id === phaseId);
  if (!phase) return [];
  const rosterId = phase.rosterOverrideId !== '' ? phase.rosterOverrideId : def.defaultRosterId;
  return def.rosters.find((r) => r.id === rosterId)?.actors ?? [];
}

/** The gate whose `id` matches `status` (the agent-loop state-machine string), or undefined when the
 *  status is mid-work (no gate — the loop is running, not awaiting a human). */
export function gateForStatus(def: LoopDef, status: string): LoopGate | undefined {
  return def.gates.find((g) => g.id === status);
}

/** Normalize a consolidator-written verdict to the branch the orchestrator acts on (§26.6): `clean`
 *  advances to the gate, anything else re-iterates. A synonym maps through the LoopDef taxonomy
 *  (§26.3/D45); an unknown or absent-taxonomy value defaults to `needs-work` — the §26.3 strict-rule
 *  fallback (never advance a run to its human gate on an unrecognized verdict). */
export function normalizeConsolidatedVerdict(def: LoopDef, raw: string): 'clean' | 'needs-work' {
  const key = raw.trim().toLowerCase();
  const canon = def.verdicts?.consolidatedSynonyms[key] ?? (key === 'clean' ? 'clean' : '');
  return canon === 'clean' ? 'clean' : 'needs-work';
}

/** True iff a raw PERSONA-review verdict normalizes to `clean` against the LoopDef persona taxonomy
 *  (§26.5) — the skip-opt's "who reviewed clean this iteration" test. An unknown/absent-taxonomy value is
 *  not clean (the same strict fallback as the consolidated normalizer: never treat an unrecognized verdict
 *  as clean). */
export function isPersonaClean(def: LoopDef, raw: string): boolean {
  const key = raw.trim().toLowerCase();
  const canon = def.verdicts?.personaSynonyms[key] ?? (key === 'clean' ? 'clean' : '');
  return canon === 'clean';
}
