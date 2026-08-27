// Single-sourced local-code-execution hardening for git in an UNTRUSTED checked-out repo (CLAUDE.md
// shared-semantics), so no consumer drifts a second copy.
//
// These two `-c` overrides disable the two REPO-CONFIG execution levers common to ANY local git op — a planted
// `core.fsmonitor` (run when git refreshes the index) and `core.hooksPath` (hooks) — since a command-line `-c`
// outranks any repo-local value. This is NOT complete hardening: each caller must still neutralize its OWN
// command's execution surfaces (a diff's textconv/external-diff via `--name-only`, filter/merge drivers, …) and,
// if it reaches the network, add protocol/credential hardening ON TOP.
export function coreExecHardeningArgs(disabledHooksPath: string): string[] {
  return ['-c', `core.hooksPath=${disabledHooksPath}`, '-c', 'core.fsmonitor=false'];
}
