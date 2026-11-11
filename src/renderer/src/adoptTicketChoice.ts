// §27.10 — the blocking dialog (UI-STANDARDS §5) in which the operator picks the primary ticket of a run adopting a
// pull request that closes more than one acceptable ticket.

import { createModalShell } from './modalShell';
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
  // The offer the open dialog answers; null once it has been answered, so Escape or the scrim never answers twice.
  let open: AdoptTicketOffer | null = null;
  const send = (offer: AdoptTicketOffer, answer: AdoptTicketAnswer): Promise<ResolveAdoptTicketResult> =>
    deps.answer(offer.repoKey, offer.step, offer.choiceId, answer).catch((e: unknown) => ({
      ok: false as const,
      reason: e instanceof Error ? e.message : String(e),
    }));
  const shell = createModalShell(
    host,
    'adopt-ticket-choice-title',
    () => {
      const offer = open;
      open = null;
      if (offer !== null) void send(offer, { kind: 'cancel' });
    },
    { onFocusLost: deps.onFocusLost },
  );

  const show = (offer: AdoptTicketOffer): void => {
    // A displaced, unanswered offer is declined, as the shell's replacing render does not dismiss it: its start is
    // then rolled back instead of left held with nothing on screen to answer it.
    if (open !== null && open.choiceId !== offer.choiceId) void send(open, { kind: 'cancel' });
    open = offer;
    shell.render(({ doc, titleId, close, confirm: accept, presses }) => {
      const card = doc.createElement('div');
      card.className = 'card';
      const h3 = doc.createElement('h3');
      h3.className = 'serif';
      h3.id = titleId;
      h3.textContent = `Choose the primary ticket for pull request #${offer.pr}`;
      const ph = doc.createElement('p');
      ph.className = 'ph';
      ph.id = `${titleId}-desc`;
      ph.textContent = `Pull request #${offer.pr} closes more than one ticket. The run is recorded against the one you choose, and its prompts name every one of them as intent.`;
      card.append(h3, ph);

      const group = doc.createElement('fieldset');
      group.className = 'feedback-mode';
      const legend = doc.createElement('legend');
      legend.textContent = 'Primary ticket';
      group.append(legend);
      const radioName = `${titleId}-ticket`;
      const radios = offer.tickets.map((ticket, i) => {
        const row = doc.createElement('label');
        row.className = 'mode-row';
        const radio = doc.createElement('input');
        radio.type = 'radio';
        radio.name = radioName;
        radio.checked = i === 0;
        const span = doc.createElement('span');
        span.textContent = `${ticket.repo}#${ticket.number}`;
        row.append(radio, span);
        group.append(row);
        return { radio, ticket };
      });
      card.append(group);

      const err = doc.createElement('p');
      err.className = 'ph err-msg';
      err.id = `${titleId}-err`;
      err.setAttribute('role', 'alert');
      card.append(err);

      const answerWith = (answer: AdoptTicketAnswer): Promise<void> => {
        err.textContent = '';
        return send(offer, answer).then((result) => {
          if (open !== offer) return;
          if (result.ok) {
            open = null;
            accept();
          } else err.textContent = result.reason;
        });
      };

      const foot = doc.createElement('div');
      foot.className = 'mfoot';
      const cancel = doc.createElement('button');
      cancel.className = 'pill cancel';
      cancel.textContent = 'Cancel';
      presses.bind(cancel, close);
      const confirmBtn = doc.createElement('button');
      confirmBtn.className = 'pill signal confirm';
      confirmBtn.textContent = 'Confirm';
      confirmBtn.setAttribute('aria-describedby', err.id);
      presses.bind(confirmBtn, () => {
        const chosen = radios.find((r) => r.radio.checked) ?? radios[0];
        if (chosen === undefined) return close();
        return answerWith({ kind: 'ticket', ticket: { ...chosen.ticket } });
      });
      foot.append(cancel, confirmBtn);
      card.append(foot);

      return { card, initialFocus: radios[0]?.radio ?? confirmBtn, describedById: ph.id };
    });
  };

  const unsubscribe = deps.onOffer(show);
  return {
    dispose() {
      unsubscribe();
      open = null;
      shell.dispose();
    },
  };
}
