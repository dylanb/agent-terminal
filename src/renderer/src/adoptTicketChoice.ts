// §27.10 — the blocking dialog (UI-STANDARDS §5) in which the operator picks the primary ticket of a run adopting a
// pull request that closes more than one acceptable ticket.

import type { AdoptTicketAnswer, AdoptTicketOffer, ResolveAdoptTicketResult } from '../../shared/ipc';

export interface AdoptTicketChoiceDeps {
  onOffer(cb: (offer: AdoptTicketOffer) => void): () => void;
  answer(repoKey: string, step: string, choiceId: string, answer: AdoptTicketAnswer): Promise<ResolveAdoptTicketResult>;
  onFocusLost?: () => void;
}

export interface AdoptTicketChoice {
  dispose(): void;
}

export function createAdoptTicketChoice(host: HTMLElement, deps: AdoptTicketChoiceDeps): AdoptTicketChoice {
  void host;
  void deps;
  return { dispose() {} };
}
