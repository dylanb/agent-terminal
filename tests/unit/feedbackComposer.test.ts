// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFeedbackComposer } from '../../src/renderer/src/feedbackComposer';
import { assertRendersFromHostDocument } from './relocatable';

// §27.9/§19.4 (AC4) — the request-changes feedback composer, a blocking dialog (UI-STANDARDS §5) opened when
// the operator chooses request-changes at a §27 gate. It collects the human's feedback (free text PLUS a
// curated review-todo subset, under a submit-as-is / compose-with-agent delivery mode) and its submit carries
// the composed feedback back to the caller, which dispatches the request-changes decision. Placement-agnostic
// — it touches only its host subtree.

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let host: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="feedback-composer-host"></div>';
  host = document.getElementById('feedback-composer-host')!;
});
afterEach(() => {
  document.body.innerHTML = '';
});

const textarea = (): HTMLTextAreaElement => host.querySelector('.flow-modal textarea')!;
const submitBtn = (): HTMLButtonElement => host.querySelector('.flow-modal .confirm')!;
const cancelBtn = (): HTMLButtonElement => host.querySelector('.flow-modal .cancel')!;
const todoBoxes = (): HTMLInputElement[] => [...host.querySelectorAll<HTMLInputElement>('.flow-modal [data-todo] input[type="checkbox"]')];
const TODOS = [
  { id: 't1', text: 'The migration section overspecifies the schema' },
  { id: 't2', text: 'The plan and ticket disagree on the API shape' },
];
const open = (over: Partial<{ step: string; todos: { id: string; text: string }[] }> = {}) => ({ step: 'plan', todos: TODOS, ...over });
const buttonNamed = (name: string): HTMLElement => {
  const found = [...host.querySelectorAll<HTMLElement>('button, [role="button"]')].filter(
    (b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === name,
  );
  expect(found).toHaveLength(1);
  return found[0];
};

describe('feedback composer (§27.9 / AC4)', () => {
  it('opens a dialog naming the step, with a free-text feedback field', () => {
    createFeedbackComposer(host).render(open(), vi.fn());
    expect(host.querySelector('.flow-modal')).not.toBeNull();
    expect(textarea()).not.toBeNull();
    expect(host.querySelector('.flow-modal h3')?.textContent).toContain('plan');
  });

  it('Submit carries the typed feedback back to the caller', () => {
    const submit = vi.fn();
    createFeedbackComposer(host).render(open({ todos: [] }), submit);
    textarea().value = 'Tighten the migration section; it overspecifies the schema.';
    submitBtn().click();
    expect(submit).toHaveBeenCalledWith('Tighten the migration section; it overspecifies the schema.');
  });

  it('Submit is refused when nothing is provided — request-changes needs feedback (§27.9)', () => {
    const submit = vi.fn();
    createFeedbackComposer(host).render(open({ todos: [] }), submit);
    textarea().value = '   \n  ';
    submitBtn().click();
    expect(submit).not.toHaveBeenCalled();
    expect(host.querySelector('.flow-modal')).not.toBeNull(); // stays open to re-collect
  });

  it('marks Submit aria-disabled while empty and clears it once feedback is entered (WCAG 3.3.1)', () => {
    // request-changes REQUIRES feedback; an empty submit is an input error. Reflect that state on the control so
    // an AT user perceives it, using the app's aria-disabled convention (which keeps the button focusable).
    createFeedbackComposer(host).render(open({ todos: [] }), vi.fn());
    expect(submitBtn().getAttribute('aria-disabled')).toBe('true'); // nothing entered yet
    textarea().value = 'now there is feedback';
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
    expect(submitBtn().getAttribute('aria-disabled')).toBe('false');
  });

  it('announces a required-feedback error when Submit is pressed empty, instead of doing nothing silently (WCAG 3.3.1)', () => {
    const submit = vi.fn();
    createFeedbackComposer(host).render(open({ todos: [] }), submit);
    submitBtn().click(); // pressed with nothing entered
    expect(submit).not.toHaveBeenCalled();
    const alert = host.querySelector('.flow-modal [role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent?.trim().length).toBeGreaterThan(0); // a visible, announced reason — not a silent no-op
  });

  it('associates the error region with Submit via aria-describedby so AT reads the reason (WCAG 1.3.1/3.3.1)', () => {
    createFeedbackComposer(host).render(open({ todos: [] }), vi.fn());
    const describedby = submitBtn().getAttribute('aria-describedby');
    expect(describedby).toBeTruthy();
    const alert = host.querySelector('.flow-modal [role="alert"]');
    expect(alert!.id).toBe(describedby); // the disabled submit points at the region that carries its reason
  });

  it('checking a todo clears the empty state so Submit is no longer aria-disabled', () => {
    createFeedbackComposer(host).render(open(), vi.fn()); // has todos
    expect(submitBtn().getAttribute('aria-disabled')).toBe('true');
    todoBoxes()[0].checked = true;
    todoBoxes()[0].dispatchEvent(new Event('change', { bubbles: true }));
    expect(submitBtn().getAttribute('aria-disabled')).toBe('false');
  });

  it('trims surrounding whitespace from the submitted feedback', () => {
    const submit = vi.fn();
    createFeedbackComposer(host).render(open({ todos: [] }), submit);
    textarea().value = '  address the taint flow  ';
    submitBtn().click();
    expect(submit).toHaveBeenCalledWith('address the taint flow');
  });

  it('closes only once delivery is confirmed (submit resolves true)', async () => {
    createFeedbackComposer(host).render(open({ todos: [] }), vi.fn().mockResolvedValue(true));
    textarea().value = 'do the thing';
    submitBtn().click();
    await flush();
    expect(host.querySelector('.flow-modal')).toBeNull();
  });

  it('stays open, preserves the typed feedback, and shows the reason when delivery is refused (§27.9 — never lose the human input)', async () => {
    // A request-changes the loop drops (runner mid-turn / gate raced out) must not discard what the operator
    // typed: the composer keeps it, surfaces why, and stays open so a retry needs no retyping.
    const submit = vi.fn().mockResolvedValue(false);
    createFeedbackComposer(host).render(open({ todos: [] }), submit);
    textarea().value = 'the feedback I do not want to lose';
    submitBtn().click();
    await flush();
    expect(submit).toHaveBeenCalledWith('the feedback I do not want to lose');
    expect(host.querySelector('.flow-modal')).not.toBeNull(); // STILL OPEN
    expect(textarea().value).toBe('the feedback I do not want to lose'); // text preserved for retry
    const alert = host.querySelector('.flow-modal [role="alert"]');
    expect(alert!.textContent?.toLowerCase()).toContain('again'); // "…try again"
  });

  it('does not double-dispatch while a delivery is in flight', async () => {
    let resolve!: (v: boolean) => void;
    const submit = vi.fn().mockReturnValue(new Promise<boolean>((r) => (resolve = r)));
    createFeedbackComposer(host).render(open({ todos: [] }), submit);
    textarea().value = 'once only';
    submitBtn().click();
    submitBtn().click(); // a second press before the first delivery settles
    expect(submit).toHaveBeenCalledTimes(1);
    resolve(true);
    await flush();
  });

  it('ignores Submit and Cancel while a delivery is being answered, shows Submit busy, and takes a press again after', async () => {
    const answers: Array<(delivered: boolean) => void> = [];
    const submit = vi.fn(() => new Promise<boolean>((r) => answers.push(r)));
    createFeedbackComposer(host).render(open({ todos: [] }), submit);
    textarea().value = 'once only';
    textarea().dispatchEvent(new Event('input'));
    const send = buttonNamed('Submit feedback');
    send.click();
    send.click();
    buttonNamed('Cancel').click();
    host.querySelector('.flow-modal')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    host.querySelector<HTMLElement>('.flow-scrim')?.click();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(host.querySelector('.flow-modal')).not.toBeNull();
    expect(send.getAttribute('aria-busy')).toBe('true');
    answers[0](false);
    await flush();
    send.click();
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('Cancel closes the dialog without submitting', () => {
    const submit = vi.fn();
    createFeedbackComposer(host).render(open(), submit);
    cancelBtn().click();
    expect(submit).not.toHaveBeenCalled();
    expect(host.querySelector('.flow-modal')).toBeNull();
  });

  it('Escape closes the dialog without submitting', () => {
    const submit = vi.fn();
    createFeedbackComposer(host).render(open(), submit);
    host.querySelector('.flow-modal')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(submit).not.toHaveBeenCalled();
    expect(host.querySelector('.flow-modal')).toBeNull();
  });

  it('render(null) closes any open dialog', () => {
    const composer = createFeedbackComposer(host);
    composer.render(open(), vi.fn());
    composer.render(null, vi.fn());
    expect(host.querySelector('.flow-modal')).toBeNull();
  });

  it('names the dialog via aria-labelledby pointing at its heading (WCAG 4.1.2)', () => {
    createFeedbackComposer(host).render(open(), vi.fn());
    const dialog = host.querySelector('.flow-modal')!;
    const labelledby = dialog.getAttribute('aria-labelledby');
    expect(labelledby).toBeTruthy();
    expect(host.querySelector(`#${labelledby}`)?.textContent).toBe(dialog.querySelector('h3')?.textContent);
  });

  it('renders from its host document so it relocates (UI §2.2.1)', async () => {
    await assertRendersFromHostDocument((h) => createFeedbackComposer(h).render(open(), vi.fn()));
  });
});

// §19.4 (AC4) — the composer surfaces the repo's review todos as a curatable checklist; the operator picks a
// subset, which joins the free text as the composed feedback delivered to the next round.
describe('feedback composer — curate a review-todo subset (§19.4 / AC4)', () => {
  it('renders one selectable item per review todo, unchecked by default', () => {
    createFeedbackComposer(host).render(open(), vi.fn());
    const boxes = todoBoxes();
    expect(boxes).toHaveLength(2);
    expect(boxes.every((b) => !b.checked)).toBe(true);
    expect(host.querySelector('.flow-modal')!.textContent).toContain('overspecifies the schema');
  });

  it('composes the SELECTED subset (not the unselected) with the free text', () => {
    const submit = vi.fn();
    createFeedbackComposer(host).render(open(), submit);
    todoBoxes()[0].checked = true; // select only the first todo
    textarea().value = 'plus this free-text note';
    submitBtn().click();
    const composed = submit.mock.calls[0][0] as string;
    expect(composed).toContain('plus this free-text note');
    expect(composed).toContain(TODOS[0].text); // the selected item is carried
    expect(composed).not.toContain(TODOS[1].text); // the unselected item is NOT
  });

  it('a selected subset with NO free text still composes and submits (curation alone is feedback)', () => {
    const submit = vi.fn();
    createFeedbackComposer(host).render(open(), submit);
    todoBoxes()[1].checked = true;
    submitBtn().click();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toContain(TODOS[1].text);
  });

  it('renders no checklist when the repo has no review todos (free-text-only composer)', () => {
    createFeedbackComposer(host).render(open({ todos: [] }), vi.fn());
    expect(todoBoxes()).toHaveLength(0);
    expect(textarea()).not.toBeNull();
  });

  it('is refused when neither a todo is selected nor free text typed', () => {
    const submit = vi.fn();
    createFeedbackComposer(host).render(open(), submit);
    submitBtn().click(); // nothing selected, nothing typed
    expect(submit).not.toHaveBeenCalled();
    expect(host.querySelector('.flow-modal')).not.toBeNull();
  });
});

// §19.4 (AC4) — the composer offers two delivery modes: submit-as-is (the curated material verbatim) and
// compose-with-agent (the material framed for the next round's fixer to synthesize before addressing). The
// mode travels IN the composed feedback text, so no new wire field is needed (§27 delivers the §19.4 composer
// into the next review round, not as a slash command).
const modeRadio = (value: string): HTMLInputElement => host.querySelector(`.flow-modal input[name="feedback-mode"][value="${value}"]`)!;

describe('feedback composer — compose-with-agent vs submit-as-is (§19.4 / AC4)', () => {
  it('defaults to submit-as-is, delivering the composed material verbatim', () => {
    const submit = vi.fn();
    createFeedbackComposer(host).render(open({ todos: [] }), submit);
    expect(modeRadio('as-is').checked).toBe(true);
    expect(modeRadio('compose').checked).toBe(false);
    textarea().value = 'apply exactly this';
    submitBtn().click();
    expect(submit).toHaveBeenCalledWith('apply exactly this'); // verbatim, no framing added
  });

  it('compose-with-agent frames the material for the fixer to synthesize, still carrying it', () => {
    const submit = vi.fn();
    createFeedbackComposer(host).render(open({ todos: [] }), submit);
    modeRadio('compose').checked = true;
    textarea().value = 'the rough idea';
    submitBtn().click();
    const composed = submit.mock.calls[0][0] as string;
    expect(composed).toContain('the rough idea'); // the operator's material is still delivered
    expect(composed).not.toBe('the rough idea'); // …but framed differently from verbatim
    expect(composed.toLowerCase()).toContain('synthes'); // a synthesize/compose instruction for the fixer
  });

  it('carries the curated todo subset in compose mode too', () => {
    const submit = vi.fn();
    createFeedbackComposer(host).render(open(), submit);
    modeRadio('compose').checked = true;
    todoBoxes()[0].checked = true;
    submitBtn().click();
    expect(submit.mock.calls[0][0]).toContain(TODOS[0].text);
  });
});

// §28.4.2 — the same composer opened for Back to RED: it names the slice redo, and the brief is OPTIONAL — an
// empty submit dispatches a plain reopen instead of refusing. The two-way hold-open contract is unchanged.
describe('feedback composer — the back-to-red variant (§28.4.2)', () => {
  const backToRed = (over: Partial<{ step: string; todos: { id: string; text: string }[] }> = {}) => ({ ...open(over), purpose: 'back-to-red' as const });

  it('names the step the reopen returns to and the gate it is sent from', () => {
    createFeedbackComposer(host).render({ ...backToRed({ step: 'integration' }), target: 'dev' }, vi.fn());
    const dialog = host.querySelector('.flow-modal')!;
    expect(dialog.querySelector('h3')?.textContent).toContain('dev');
    expect(dialog.querySelector('h3')?.textContent).toContain('integration');
    expect(submitBtn().textContent).toBe('Back to dev');
  });

  it('names RED when no return step is given', () => {
    createFeedbackComposer(host).render(backToRed({ step: 'green' }), vi.fn());
    expect(submitBtn().textContent).toBe('Back to RED');
  });

  it('submits an empty brief as a plain reopen rather than refusing', async () => {
    const submit = vi.fn(() => Promise.resolve(true));
    createFeedbackComposer(host).render(backToRed({ todos: [] }), submit);
    submitBtn().click();
    await flush();
    expect(submit).toHaveBeenCalledWith('');
    expect(host.querySelector('.flow-modal')).toBeNull(); // delivered → closed
  });

  it('carries the typed brief and keeps it on a drop', async () => {
    const submit = vi.fn(() => Promise.resolve(false));
    createFeedbackComposer(host).render(backToRed({ todos: [] }), submit);
    textarea().value = 'Cover the empty-input case';
    textarea().dispatchEvent(new Event('input'));
    submitBtn().click();
    await flush();
    expect(submit).toHaveBeenCalledWith('Cover the empty-input case');
    expect(textarea().value).toBe('Cover the empty-input case'); // held open with the brief intact
  });
});
