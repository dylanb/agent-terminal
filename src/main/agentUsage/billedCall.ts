import type { TokenKind } from '../../shared/tokenCounts';

/** One API call an agent's log records spend for; a kind absent from `kinds` is one its log did not report. */
export interface BilledCall {
  at: number;
  kinds: Partial<Record<TokenKind, number>>;
}
