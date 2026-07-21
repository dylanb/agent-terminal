// The redo instruction composer (§27.9 / N5, AC5) — a placement-agnostic blocking dialog (UI-STANDARDS §5)
// opened when the operator chooses redo at a §27 gate. It collects the human's clean-slate INSTRUCTION (free
// text — the ticket and the plan are the work turn's other inputs, so redo needs only the instruction), and its
// submit carries that instruction back to the caller, which dispatches the two-way redo decision
// (window.flow.appRedo). Like the feedback composer it holds open until delivery confirms, so a drop (runner
// mid-turn / gate raced out / a polish stand-down) never discards the operator's instruction. Composes
// createModalShell and supplies the instruction-field body; the caller decides WHEN to open/close it.

import { createModalShell } from './modalShell';

/** The gate identity the composer is opened for — the `step` names the dialog; the caller holds the full
 *  step+turn identity it dispatches the decision on. */
export interface RedoComposerCtx {
  step: string;
}

export interface RedoComposer {
  /** Open the composer for `ctx`. On Submit it calls `submit` with the typed instruction and holds the dialog
   *  OPEN until that promise settles: it closes only when `submit` resolves true (the work turn re-entered), and
   *  on false keeps the typed instruction and surfaces the reason so a retry needs no retyping. `null` closes
   *  any open dialog. */
  render(ctx: RedoComposerCtx | null, submit: (instruction: string) => Promise<boolean>): void;
  /** Tear down: clear the host subtree and drop captured state on unmount/relocation (UI §2.2.1). */
  dispose(): void;
}

export function createRedoComposer(host: HTMLElement, opts?: { onFocusLost?: () => void }): RedoComposer {
  const shell = createModalShell(host, 'redo-composer-title', undefined, { onFocusLost: opts?.onFocusLost });
  return {
    render(ctx, submit) {
      if (!ctx) return shell.render(null);
      shell.render(({ doc, titleId, close, confirm }) => {
        const describedById = `${titleId}-desc`;
        const card = doc.createElement('div');
        card.className = 'card';
        const h3 = doc.createElement('h3');
        h3.className = 'serif';
        h3.id = titleId;
        h3.textContent = `Redo ${ctx.step}`;
        const ph = doc.createElement('p');
        ph.className = 'ph';
        ph.id = describedById;
        ph.textContent = 'The work turn re-runs on a clean slate — only the ticket, the plan, and your instruction (§27.9).';
        card.append(h3, ph);

        const field = doc.createElement('div');
        field.className = 'field';
        const area = doc.createElement('textarea');
        area.setAttribute('aria-label', 'redo instruction');
        area.rows = 5;
        field.append(area);
        card.append(field);

        // §27.9 requires an instruction, so an empty composer is an input error (WCAG 3.3.1). It is surfaced two
        // ways: the submit reflects the empty state as aria-disabled (the app convention that keeps it focusable),
        // and an assertive alert — associated with the submit via aria-describedby so AT reads the reason off the
        // button — names the requirement when submit is pressed while empty.
        const err = doc.createElement('p');
        err.className = 'ph err-msg';
        err.id = `${titleId}-err`;
        err.setAttribute('role', 'alert');
        card.append(err);

        const foot = doc.createElement('div');
        foot.className = 'mfoot';
        const cancel = doc.createElement('button');
        cancel.className = 'pill cancel';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', close);
        const submitBtn = doc.createElement('button');
        submitBtn.className = 'pill signal confirm';
        submitBtn.textContent = 'Redo the work';
        submitBtn.setAttribute('aria-describedby', err.id);
        const current = (): string => area.value.trim();
        const refreshSubmit = (): void => {
          const empty = current().length === 0;
          submitBtn.setAttribute('aria-disabled', empty ? 'true' : 'false');
          if (!empty) err.textContent = '';
        };
        let inFlight = false;
        submitBtn.addEventListener('click', () => {
          if (inFlight) return; // a second press before the first delivery settles must not double-dispatch
          const instruction = current();
          if (instruction.length === 0) {
            err.textContent = 'Type an instruction before submitting.';
            submitBtn.setAttribute('aria-disabled', 'true');
            return;
          }
          // §27.9/AC5 — hold the dialog OPEN until the loop confirms the work turn re-entered: on a refusal the
          // operator's typed instruction would otherwise be lost with no route back. Disable submit while the
          // delivery is in flight; `confirm` (on success) closes WITHOUT the shell's dismissal, so the caller's
          // dispatch is the one decision.
          err.textContent = '';
          inFlight = true;
          submitBtn.setAttribute('aria-disabled', 'true');
          void Promise.resolve(submit(instruction)).then((delivered) => {
            inFlight = false;
            if (delivered) {
              confirm();
              return;
            }
            err.textContent = 'Could not re-enter the work turn — the loop was busy. Try again.';
            submitBtn.setAttribute('aria-disabled', 'false');
          });
        });
        area.addEventListener('input', refreshSubmit);
        refreshSubmit();
        foot.append(cancel, submitBtn);
        card.append(foot);

        return { card, initialFocus: area, describedById };
      });
    },
    dispose() {
      shell.dispose();
    },
  };
}
