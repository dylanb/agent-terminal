export const AGENT_KINDS = ['claude-code', 'codex'] as const;

export type AgentKind = (typeof AGENT_KINDS)[number];

export const isAgentKind = (value: unknown): value is AgentKind => (AGENT_KINDS as readonly unknown[]).includes(value);
