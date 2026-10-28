// The request-changes feedback composer (§27.9/§19.4 / N5, AC4) — a placement-agnostic blocking dialog
// (UI-STANDARDS §5) opened when the operator chooses request-changes at a §27 gate. It collects the human's
// feedback — free text PLUS a curated subset of the repo's review todos — under a delivery mode (submit-as-is
// or compose-with-agent), and its submit carries the composed, mode-framed feedback back to the caller, which
// dispatches the request-changes decision (window.flow.appGateDecision). Composes createModalShell and
// supplies the feedback-field body; the caller decides WHEN to open/close it.

import { createModalShell } from './modalShell';

/** A review todo the operator may curate into the feedback (§19.4) — the id/text projection of the repo's
 *  todo store, passed as data (the composer reaches for nothing). */
export interface ReviewTodo {
  id: string;
  text: string;
}

/** The gate identity the composer is opened for — the `step` names the dialog; the caller holds the full
 *  step+turn identity it dispatches the decision on. `todos` are the repo's review todos to curate (§19.4). */
export interface FeedbackComposerCtx {
  step: string;
  todos: ReviewTodo[];
  /** What the composed text is for: request-changes feedback (required) or a §28.4.2 back-to-RED brief
   *  (optional — an empty submit is a plain reopen). Absent is request-changes. */
  purpose?: 'request-changes' | 'back-to-red';
}

/** The words each purpose shows; everything else about the composer is shared. */
const PURPOSE_COPY = {
  'request-changes': {
    title: (step: string) => `Request changes to ${step}`,
    description: 'Your feedback joins the next review-and-fix round alongside the reviewers’ findings (§27.9).',
    fieldLabel: 'request-changes feedback',
    submitLabel: 'Submit feedback',
    required: true,
    dropped: 'Could not start a new round — the loop was busy. Try again.',
  },
  'back-to-red': {
    title: (step: string) => `Send this slice back to RED from ${step}`,
    description: 'Optional brief: what the slice must redo. It is handed to the RED, GREEN and refactor phases of this slice (§28.4.2).',
    fieldLabel: 'back-to-RED brief',
    submitLabel: 'Back to RED',
    required: false,
    dropped: 'Could not send the slice back to RED. Your brief is kept — try again.',
  },
} as const;

/** The two §19.4 delivery modes: submit-as-is (the material verbatim) or compose-with-agent (the material
 *  framed for the next round's fixer to synthesize before addressing). Carried in the composed text itself,
 *  not on the wire — §27 delivers the composer into the next review round. */
type FeedbackMode = 'as-is' | 'compose';

/** Compose the delivered feedback from the curated todo subset and the free text (§19.4): the free text
 *  first, then the selected items as a bulleted list; either alone is valid, and neither composes to empty. */
function composeFeedbackText(freeText: string, selected: string[]): string {
  const parts: string[] = [];
  if (freeText) parts.push(freeText);
  if (selected.length > 0) parts.push(selected.map((t) => `- ${t}`).join('\n'));
  return parts.join('\n\n');
}

/** Frame the composed material for its delivery mode (§19.4): `as-is` delivers it verbatim; `compose` asks
 *  the next round's fixer to synthesize the operator's raw material into concrete changes before addressing it.
 *  This is the INNER framing only; main's composeReviewAndFixPrompt (reviewTurn.ts) wraps every request-changes
 *  feedback with the outer "operator requested changes / record how you addressed it" block — edit either aware
 *  of the other so the two divide labor rather than drift into redundancy or a gap. */
function frameFeedback(mode: FeedbackMode, composed: string): string {
  if (mode === 'compose') return `Synthesize the following operator feedback into concrete changes, then address them:\n\n${composed}`;
  return composed;
}

export interface FeedbackComposer {
  /** Open the composer for `ctx`. On Submit it calls `submit` with the composed feedback and holds the dialog
   *  OPEN until that promise settles: it closes only when `submit` resolves true (the loop started the round),
   *  and on false keeps the typed feedback and surfaces the reason so a retry needs no retyping. `null` closes
   *  any open dialog. */
  render(ctx: FeedbackComposerCtx | null, submit: (feedback: string) => Promise<boolean>): void;
  /** Tear down: clear the host subtree and drop captured state on unmount/relocation (UI §2.2.1). */
  dispose(): void;
}

export function createFeedbackComposer(host: HTMLElement, opts?: { onFocusLost?: () => void }): FeedbackComposer {
  const shell = createModalShell(host, 'feedback-composer-title', undefined, { onFocusLost: opts?.onFocusLost });
  return {
    render(ctx, submit) {
      if (!ctx) return shell.render(null);
      const copy = PURPOSE_COPY[ctx.purpose ?? 'request-changes'];
      shell.render(({ doc, titleId, close, confirm, presses: footGroup }) => {
        const describedById = `${titleId}-desc`;
        const card = doc.createElement('div');
        card.className = 'card';
        const h3 = doc.createElement('h3');
        h3.className = 'serif';
        h3.id = titleId;
        h3.textContent = copy.title(ctx.step);
        const ph = doc.createElement('p');
        ph.className = 'ph';
        ph.id = describedById;
        ph.textContent = copy.description;
        card.append(h3, ph);

        // §19.4 — curate a subset of the repo's review todos. Each is a checkbox, unchecked by default; the
        // selected texts join the free text as the composed feedback. Absent todos → a free-text-only composer.
        const reads: Array<() => string | null> = [];
        const boxes: HTMLInputElement[] = [];
        if (ctx.todos.length > 0) {
          const group = doc.createElement('fieldset');
          group.className = 'todo-curate';
          const legend = doc.createElement('legend');
          legend.textContent = 'Include review todos';
          group.append(legend);
          for (const todo of ctx.todos) {
            const row = doc.createElement('label');
            row.className = 'todo-row';
            row.dataset.todo = '';
            const box = doc.createElement('input');
            box.type = 'checkbox';
            const span = doc.createElement('span');
            span.textContent = todo.text;
            row.append(box, span);
            group.append(row);
            boxes.push(box);
            reads.push(() => (box.checked ? todo.text : null));
          }
          card.append(group);
        }

        const field = doc.createElement('div');
        field.className = 'field';
        const area = doc.createElement('textarea');
        area.setAttribute('aria-label', copy.fieldLabel);
        area.rows = 5;
        field.append(area);
        card.append(field);

        // §19.4 — the delivery mode: submit-as-is (verbatim, default) or compose-with-agent (framed for the
        // next round's fixer to synthesize). A radio group so exactly one mode is active; read at submit.
        const modes = doc.createElement('fieldset');
        modes.className = 'feedback-mode';
        const modeLegend = doc.createElement('legend');
        modeLegend.textContent = 'Delivery';
        modes.append(modeLegend);
        const modeName = 'feedback-mode';
        const modeOption = (value: FeedbackMode, label: string, checked: boolean): void => {
          const row = doc.createElement('label');
          row.className = 'mode-row';
          const radio = doc.createElement('input');
          radio.type = 'radio';
          radio.name = modeName;
          radio.value = value;
          radio.checked = checked;
          const span = doc.createElement('span');
          span.textContent = label;
          row.append(radio, span);
          modes.append(row);
        };
        modeOption('as-is', 'Submit as-is', true);
        modeOption('compose', 'Compose with agent', false);
        card.append(modes);
        const selectedMode = (): FeedbackMode =>
          (card.querySelector<HTMLInputElement>(`input[name="${modeName}"]:checked`)?.value as FeedbackMode) ?? 'as-is';

        const currentComposed = (): string =>
          composeFeedbackText(area.value.trim(), reads.map((r) => r()).filter((t): t is string => t !== null));

        // §27.9 requires feedback, so an empty composer is an input error (WCAG 3.3.1). It is surfaced two ways:
        // the submit reflects the empty state as aria-disabled (the app convention that keeps it focusable), and
        // an assertive alert — associated with the submit via aria-describedby so AT reads the reason off the
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
        footGroup.bind(cancel, close);
        const submitBtn = doc.createElement('button');
        submitBtn.className = 'pill signal confirm';
        submitBtn.textContent = copy.submitLabel;
        submitBtn.setAttribute('aria-describedby', err.id);
        const refreshSubmit = (): void => {
          if (footGroup.busy) return;
          const empty = copy.required && currentComposed().length === 0;
          submitBtn.setAttribute('aria-disabled', empty ? 'true' : 'false');
          if (!empty) err.textContent = '';
        };
        footGroup.bind(submitBtn, () => {
          const composed = currentComposed();
          if (copy.required && composed.length === 0) {
            err.textContent = 'Add feedback or select a review todo before submitting.';
            submitBtn.setAttribute('aria-disabled', 'true');
            return;
          }
          // §27.9/AC4 — hold the dialog OPEN until the loop confirms it started the round: on a refusal the
          // operator's typed feedback would otherwise be lost with no route back. `confirm` (on success) closes
          // WITHOUT the shell's dismissal, so the caller's dispatch is the one decision.
          err.textContent = '';
          return Promise.resolve(submit(composed.length === 0 ? '' : frameFeedback(selectedMode(), composed))).then((delivered) => {
            if (delivered) confirm();
            else err.textContent = copy.dropped;
          });
        });
        area.addEventListener('input', refreshSubmit);
        for (const b of boxes) b.addEventListener('change', refreshSubmit);
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
