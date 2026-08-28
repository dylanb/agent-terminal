// The app's OWN per-repo state directories, shared by the two subsystems that must agree on the set: the
// bootstrap clean-tree gate (churn here is not "dirty") and the §20.1 viewer live-reload watch (always
// watched even when the repo's .gitignore excludes them). One definition both import — CLAUDE.md
// shared-vocabulary rule. `.agent-loop/` is tolerance for residual state the app no longer writes — the
// engine that once wrote and interpreted it is retired, though the audit recorder still snapshots its bytes
// read-only. `.agent-terminal/` is agent-terminal's own state (flow-state, todos, monitor-events,
// audit-pointer) the engine never writes.
export const APP_STATE_DIRS = ['.agent-loop', '.agent-terminal'] as const;

/** Whether a repo-relative POSIX path is the app's own state — one of APP_STATE_DIRS itself or a path beneath
 *  one. THE single membership predicate both subsystems that filter these dirs derive from (the clean-tree gate
 *  and the RED working-tree test check), so "is this path app state" cannot drift between two hand-spelled
 *  copies (CLAUDE.md shared-semantics). Matched against git's repo-relative `-z` output (no leading `./`,
 *  `/`-separated), so a bare dir name and a `dir/…` child both count while a sibling like `.agent-terminalX/`
 *  does not. */
export function isUnderAppStateDir(path: string): boolean {
  return APP_STATE_DIRS.some((dir) => path === dir || path.startsWith(`${dir}/`));
}
