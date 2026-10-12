export type AppTurnPhase = 'work' | 'review' | 'consolidate';

const PHASES: readonly AppTurnPhase[] = ['work', 'review', 'consolidate'];

export function appTurnKey(phase: AppTurnPhase, stepId: string): string {
  return `${phase}-${stepId}`;
}

export function parseAppTurnKey(key: string): { phase: AppTurnPhase; stepId: string } | null {
  for (const phase of PHASES) {
    const prefix = `${phase}-`;
    if (key.startsWith(prefix) && key.length > prefix.length) return { phase, stepId: key.slice(prefix.length) };
  }
  return null;
}
