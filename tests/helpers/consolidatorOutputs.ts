import type { ConsolidatorVerdict } from '../../src/shared/consolidatorOutput';

/** A §27.6 consolidator output carrying `verdict` and, when given, a roster and a reason. */
export function verdictOutput(verdict: ConsolidatorVerdict, extra: { roster?: string[]; reason?: string } = {}): string {
  return `${JSON.stringify({ verdict, ...extra })}\n`;
}
