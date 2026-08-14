// The closed set of def namespaces a flow step's loop binding may name that select a SURVIVING engine
// (§27.15). The N8 sweep narrowed it to one member: the retired in-terminal loop engine and its `legacy`
// namespace are gone. The
// namespace is REPO CONTENT, so it is validated at flow-load — an unrecognized value is a surfaced failure,
// never a silent default — and it is NEVER joined into a path (tier roots are chosen by the parsed enum,
// not derived from the string). Absence selects the surviving engine, so a namespace-unaware flow file
// binds the engine that ships (AC 4). One definition, shared by the flow loader that writes the parsed
// value and the seams that read it (CLAUDE.md shared-semantics: a serialized vocabulary's writer + reader).

export const LOOP_NAMESPACES = ['app'] as const;

/** `app` selects the §27 (agent-terminal-owned) engine — the only surviving member. */
export type LoopNamespace = (typeof LOOP_NAMESPACES)[number];

/** The namespace that selects the §27 engine. The write/read/entry seams SELECT by comparing against this
 *  one constant, so a third namespace changes one edit, not several un-linked ones. */
export const APP_LOOP_NAMESPACE: LoopNamespace = 'app';

/** Absence of a `loop_namespace` on a flow step selects the surviving engine (AC 4) — the default for every
 *  flow shipped before this release, so a namespace-unaware flow file binds the engine that ships. */
export const DEFAULT_LOOP_NAMESPACE: LoopNamespace = APP_LOOP_NAMESPACE;

/** The retired in-terminal loop engine's namespace literal. It is no longer a legal MEMBER of the closed set, but the
 *  loader still RECOGNIZES it (§H.5) so a flow file that names it LOADS and fails per-step (AC 4) rather
 *  than being rejected whole — tolerance for flow files that were valid until this release. It selects NO
 *  surviving engine. */
export const RETIRED_LOOP_NAMESPACE = 'legacy';

/** A parsed loop binding: a surviving namespace, or the recognized-but-retired marker that names no
 *  surviving engine. The loader writes this; the view-provider, entry-dispatch and gate-decision seams read
 *  it, and the reader that decides "names no surviving engine" lives once (bindsNoSurvivingEngine). */
export type LoopBinding = LoopNamespace | typeof RETIRED_LOOP_NAMESPACE;

/** True for a member of the surviving set only — the affirmative SELECTION test (never the negation of the
 *  deleted member), so a marked binding is unbindable by construction (§B.4). */
export function isLoopNamespace(v: unknown): v is LoopNamespace {
  return typeof v === 'string' && (LOOP_NAMESPACES as readonly string[]).includes(v);
}

/** True for a value the loader can PARSE onto a step: a surviving namespace, or the retired `legacy` literal
 *  the loader still recognizes (§H.5). Any other value is an unrecognized namespace — a whole-file rejection
 *  (AC 4). */
export function isRecognizedLoopBinding(v: unknown): v is LoopBinding {
  return isLoopNamespace(v) || v === RETIRED_LOOP_NAMESPACE;
}

/** The marking the three seams read: a parsed binding names no surviving engine iff it is not a member of
 *  the surviving set (AC 4). Defined against the surviving set — the complement of the seams' affirmative
 *  SELECTION — so the two sides cannot drift (CLAUDE.md shared-semantics). */
export function bindsNoSurvivingEngine(binding: LoopBinding): boolean {
  return !isLoopNamespace(binding);
}

/** The human-needed reason every seam surfaces for a step that binds no surviving engine — ONE definition so
 *  the view provider, the entry dispatcher and the gate decision cannot drift on the text an operator reads
 *  (CLAUDE.md shared-semantics). */
export const MARKED_BINDING_REASON =
  'this loop step binds the retired "legacy" engine, which no longer exists — set loop_namespace to the surviving engine, or remove it';
