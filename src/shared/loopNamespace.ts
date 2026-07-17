// The closed set of def namespaces a flow step's loop binding may name (§27.15 engine selection). The
// namespace is REPO CONTENT, so it is validated as a closed set at flow-load — an unrecognized value is a
// surfaced failure, never a silent default — and it is NEVER joined into a path (tier roots are chosen by
// the parsed enum, not derived from the string). Absence means the §26 (legacy) namespace, so every flow
// file shipped today keeps its meaning. One definition, shared by the flow loader that writes the parsed
// value and the seam that reads it (CLAUDE.md shared-semantics: a serialized vocabulary's writer + reader).

export const LOOP_NAMESPACES = ['legacy', 'app'] as const;

/** `legacy` selects the §26 engine; `app` selects the §27 (agent-terminal-owned) engine. */
export type LoopNamespace = (typeof LOOP_NAMESPACES)[number];

/** Absence of a `loop_namespace` on a flow step means the §26 engine — the default for every flow shipped
 *  today, so a namespace-unaware flow file is unchanged in meaning. */
export const DEFAULT_LOOP_NAMESPACE: LoopNamespace = 'legacy';

/** The namespace that selects the §27 (agent-terminal-owned) engine. The write/read/entry seams all
 *  classify a step by comparing against this one constant, so the classification lives once (per the
 *  header's "one definition, shared") and a third namespace changes one edit, not several un-linked ones. */
export const APP_LOOP_NAMESPACE: LoopNamespace = 'app';

export function isLoopNamespace(v: unknown): v is LoopNamespace {
  return typeof v === 'string' && (LOOP_NAMESPACES as readonly string[]).includes(v);
}
