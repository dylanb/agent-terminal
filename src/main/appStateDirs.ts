// The app's OWN per-repo state directories, shared by the two subsystems that must agree on the set: the
// bootstrap clean-tree gate (churn here is not "dirty") and the §20.1 viewer live-reload watch (always
// watched even when the repo's .gitignore excludes them). One definition both import — CLAUDE.md
// shared-vocabulary rule. `.agent-loop/` is tolerance for residual state the app no longer writes — the
// engine that once wrote and interpreted it is retired, though the audit recorder still snapshots its bytes
// read-only. `.agent-terminal/` is agent-terminal's own state (flow-state, todos, monitor-events,
// audit-pointer) the engine never writes.
export const APP_STATE_DIRS = ['.agent-loop', '.agent-terminal'] as const;
