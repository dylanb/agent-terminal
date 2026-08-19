// Single-sourced local-code-execution hardening for running git inside an UNTRUSTED checked-out repo
// (CLAUDE.md shared-semantics): the `core.hooksPath`/`core.fsmonitor` pair was byte-identical in two call
// sites — appBootstrapGit's remote-op wrapper and the §28.5.1 frozen-tests diff — so it is defined once here
// and both compose it, and cannot drift.
//
// These two `-c` overrides neutralize the only levers by which a repo-local `.git/config` can run a program
// during a *local* git operation: a planted `core.fsmonitor` (a command run when git refreshes the index)
// and `core.hooksPath` (git hooks). A command-line `-c` outranks any repo-local value by precedence, so a
// value planted in the checked-out `.git/config` cannot win. Callers that also reach the network add their
// own protocol/credential hardening ON TOP; a local read (e.g. a two-commit `diff --name-only`) must NOT
// inherit network-op args it does not need. Any change to a caller's command form must re-evaluate whether
// this set is still sufficient.
export function coreExecHardeningArgs(disabledHooksPath: string): string[] {
  return ['-c', `core.hooksPath=${disabledHooksPath}`, '-c', 'core.fsmonitor=false'];
}
