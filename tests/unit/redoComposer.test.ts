// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRedoComposer } from '../../src/renderer/src/redoComposer';
import { assertRendersFromHostDocument } from './relocatable';

// §27.9 (AC5) — the redo instruction composer, a blocking dialog (UI-STANDARDS §5) opened when the operator
// chooses redo at a §27 gate. It collects the human's clean-slate INSTRUCTION (free text) and its submit carries
// the instruction back to the caller, which dispatches the two-way redo decision. Like the feedback composer it
// holds open until delivery confirms so a drop never loses the operator's instruction. Placement-agnostic — it
// touches only its host subtree.

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let host: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="redo-composer-host"></div>';
  host = document.getElementById('redo-composer-host')!;
});
afterEach(() => {
  document.body.innerHTML = '';
});

const textarea = (): HTMLTextAreaElement => host.querySelector('.flow-modal textarea')!;
const submitBtn = (): HTMLButtonElement => host.querySelector('.flow-modal .confirm')!;
const cancelBtn = (): HTMLButtonElement => host.querySelector('.flow-modal .cancel')!;
const open = (over: Partial<{ step: string }> = {}) => ({ step: 'plan', ...over });
const buttonNamed = (name: string): HTMLElement => {
  const found = [...host.querySelectorAll<HTMLElement>('button, [role="button"]')].filter(
    (b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === name,
  );
  expect(found).toHaveLength(1);
  return found[0];
};

describe('redo composer (§27.9 / AC5)', () => {
  it('opens a dialog naming the step, with a free-text instruction field', () => {
    createRedoComposer(host).render(open(), vi.fn());
    expect(host.querySelector('.flow-modal')).not.toBeNull();
    expect(textarea()).not.toBeNull();
    expect(host.querySelector('.flow-modal h3')?.textContent).toContain('Plan');
  });

  it('Submit carries the typed instruction back to the caller', () => {
    const submit = vi.fn();
    createRedoComposer(host).render(open(), submit);
    textarea().value = 'Start over; keep only the schema section.';
    submitBtn().click();
    expect(submit).toHaveBeenCalledWith('Start over; keep only the schema section.');
  });

  it('trims surrounding whitespace from the submitted instruction', () => {
    const submit = vi.fn();
    createRedoComposer(host).render(open(), submit);
    textarea().value = '  redo the migration  ';
    submitBtn().click();
    expect(submit).toHaveBeenCalledWith('redo the migration');
  });

  it('Submit is refused when nothing is provided — redo needs an instruction (§27.9)', () => {
    const submit = vi.fn();
    createRedoComposer(host).render(open(), submit);
    textarea().value = '   \n  ';
    submitBtn().click();
    expect(submit).not.toHaveBeenCalled();
    expect(host.querySelector('.flow-modal')).not.toBeNull(); // stays open to re-collect
  });

  it('marks Submit aria-disabled while empty and clears it once an instruction is entered (WCAG 3.3.1)', () => {
    createRedoComposer(host).render(open(), vi.fn());
    expect(submitBtn().getAttribute('aria-disabled')).toBe('true');
    textarea().value = 'now there is an instruction';
    textarea().dispatchEvent(new Event('input', { bubbles: true }));
    expect(submitBtn().getAttribute('aria-disabled')).toBe('false');
  });

  it('announces a required-instruction error when Submit is pressed empty, instead of doing nothing silently (WCAG 3.3.1)', () => {
    const submit = vi.fn();
    createRedoComposer(host).render(open(), submit);
    submitBtn().click();
    expect(submit).not.toHaveBeenCalled();
    const alert = host.querySelector('.flow-modal [role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('associates the error region with Submit via aria-describedby so AT reads the reason (WCAG 1.3.1/3.3.1)', () => {
    createRedoComposer(host).render(open(), vi.fn());
    const describedby = submitBtn().getAttribute('aria-describedby');
    expect(describedby).toBeTruthy();
    const alert = host.querySelector('.flow-modal [role="alert"]');
    expect(alert!.id).toBe(describedby);
  });

  it('closes only once delivery is confirmed (submit resolves true)', async () => {
    createRedoComposer(host).render(open(), vi.fn().mockResolvedValue(true));
    textarea().value = 'do the thing';
    submitBtn().click();
    await flush();
    expect(host.querySelector('.flow-modal')).toBeNull();
  });

  it('stays open, preserves the typed instruction, and shows the reason when delivery is refused (§27.9 — never lose the human input)', async () => {
    const submit = vi.fn().mockResolvedValue(false);
    createRedoComposer(host).render(open(), submit);
    textarea().value = 'the instruction I do not want to lose';
    submitBtn().click();
    await flush();
    expect(submit).toHaveBeenCalledWith('the instruction I do not want to lose');
    expect(host.querySelector('.flow-modal')).not.toBeNull(); // STILL OPEN
    expect(textarea().value).toBe('the instruction I do not want to lose'); // text preserved for retry
    const alert = host.querySelector('.flow-modal [role="alert"]');
    expect(alert!.textContent?.toLowerCase()).toContain('again');
  });

  it('does not double-dispatch while a delivery is in flight', async () => {
    let resolve!: (v: boolean) => void;
    const submit = vi.fn().mockReturnValue(new Promise<boolean>((r) => (resolve = r)));
    createRedoComposer(host).render(open(), submit);
    textarea().value = 'once only';
    submitBtn().click();
    submitBtn().click();
    expect(submit).toHaveBeenCalledTimes(1);
    resolve(true);
    await flush();
  });

  it('ignores Submit and Cancel while a delivery is being answered, shows Submit busy, and takes a press again after', async () => {
    const answers: Array<(delivered: boolean) => void> = [];
    const submit = vi.fn(() => new Promise<boolean>((r) => answers.push(r)));
    createRedoComposer(host).render(open(), submit);
    textarea().value = 'once only';
    textarea().dispatchEvent(new Event('input'));
    const send = buttonNamed('Redo the work');
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
    createRedoComposer(host).render(open(), submit);
    cancelBtn().click();
    expect(submit).not.toHaveBeenCalled();
    expect(host.querySelector('.flow-modal')).toBeNull();
  });

  it('Escape closes the dialog without submitting', () => {
    const submit = vi.fn();
    createRedoComposer(host).render(open(), submit);
    host.querySelector('.flow-modal')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(submit).not.toHaveBeenCalled();
    expect(host.querySelector('.flow-modal')).toBeNull();
  });

  it('render(null) closes any open dialog', () => {
    const composer = createRedoComposer(host);
    composer.render(open(), vi.fn());
    composer.render(null, vi.fn());
    expect(host.querySelector('.flow-modal')).toBeNull();
  });

  it('names the dialog via aria-labelledby pointing at its heading (WCAG 4.1.2)', () => {
    createRedoComposer(host).render(open(), vi.fn());
    const dialog = host.querySelector('.flow-modal')!;
    const labelledby = dialog.getAttribute('aria-labelledby');
    expect(labelledby).toBeTruthy();
    expect(host.querySelector(`#${labelledby}`)?.textContent).toBe(dialog.querySelector('h3')?.textContent);
  });

  it('renders from its host document so it relocates (UI §2.2.1)', async () => {
    await assertRendersFromHostDocument((h) => createRedoComposer(h).render(open(), vi.fn()));
  });
});
