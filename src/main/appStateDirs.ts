// The app's OWN per-repo state directories, shared by the two subsystems that must agree on the set: the
// §26.9 pickup clean-tree gate (churn here is not "dirty") and the §20.1 viewer live-reload watch (always
// watched even when the repo's .gitignore excludes them). One definition both import — CLAUDE.md
// shared-vocabulary rule. `.agent-loop/` is external-engine parity (filterAgentLoopStatus); `.agent-terminal/`
// is agent-terminal's own state (flow-state, todos, monitor-events, audit-pointer) the engine never writes.
export const AGENT_STATE_DIRS = ['.agent-loop', '.agent-terminal'] as const;
