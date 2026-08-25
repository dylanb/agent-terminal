// Single-sourced local-code-execution hardening for git in an UNTRUSTED checked-out repo (CLAUDE.md
// shared-semantics), so no consumer drifts a second copy.
//
// These two `-c` overrides neutralize the only levers by which a repo-local `.git/config` runs a program in a
// *local* git op — a planted `core.fsmonitor` (run when git refreshes the index) and `core.hooksPath` (hooks)
// — because a command-line `-c` outranks any repo-local value. Callers that also reach the network add their
// own protocol/credential hardening ON TOP; a local read must NOT inherit network-op args it does not need.
export function coreExecHardeningArgs(disabledHooksPath: string): string[] {
  return ['-c', `core.hooksPath=${disabledHooksPath}`, '-c', 'core.fsmonitor=false'];
}
