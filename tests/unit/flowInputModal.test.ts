// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlowInputModal } from '../../src/renderer/src/flowInputModal';
import { assertRendersFromHostDocument } from './relocatable';
import type { FlowPrompt } from '../../src/shared/ipc';

// §24.2.3 T3 — the typed-input modal, a blocking dialog (UI-STANDARDS §5): the one deliberate
// blocking surface (§18.4). Placement-agnostic — it touches only its host subtree.

const prompt = (over: Partial<FlowPrompt> = {}): FlowPrompt => ({
  inputs: [{ name: 'ticket', type: 'github-ticket' }],
  bootstrap: 'pickup',
  ...over,
});

let host: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="flow-modal-host"></div>';
  host = document.getElementById('flow-modal-host')!;
});
afterEach(() => {
  document.body.innerHTML = '';
});

const field = (name: string): HTMLElement | undefined =>
  [...host.querySelectorAll<HTMLElement>('.field')].find((f) => f.querySelector('.nm')?.textContent === name);
const buttonNamed = (name: string): HTMLElement | null =>
  [...host.querySelectorAll<HTMLElement>('button, [role="button"]')].find((b) => b.textContent?.trim() === name) ?? null;

describe('typed-input modal (§24.2.3 T3 / §18.4)', () => {
  it('renders a labelled field per input with its catalog type and the bootstrap helper', () => {
    createFlowInputModal(host).render(prompt(), 'plan', vi.fn());
    const f = field('ticket');
    expect(f).toBeTruthy();
    expect(f!.querySelector('.ty')?.textContent).toBe('github-ticket');
    expect(f!.querySelector('input')).toBeTruthy();
    // The helper names the bound def's OWN bootstrap contract that runs on entry (AC 10), scoped to the
    // element aria-describedby resolves to — its accessible description — and cites no retired section (AC 9).
    expect(host.querySelector('.flow-modal h3')?.textContent).toContain('Plan');
    expect(host.textContent).toContain('pickup');
    const helpId = f!.querySelector('input')!.getAttribute('aria-describedby')!;
    const help = host.querySelector(`#${helpId}`)!;
    expect(help.textContent).toContain("bound loop definition's own branch-and-draft-PR setup");
    expect(help.textContent).not.toContain('§');
  });

  it('names the step in sentence case in its title and description', () => {
    createFlowInputModal(host).render(prompt(), 'plan-approve', vi.fn());
    const dialog = host.querySelector('.flow-modal')!;
    for (const text of [dialog.querySelector('h3')?.textContent ?? '', dialog.querySelector('.ph')?.textContent ?? '']) {
      expect(text).toContain('Plan approve');
      expect(text).not.toContain('plan-approve');
    }
  });

  it('Confirm collects the typed values and calls submit with the name→value map', () => {
    const submit = vi.fn();
    createFlowInputModal(host).render(prompt(), 'plan', submit);
    (field('ticket')!.querySelector('input') as HTMLInputElement).value = '176';
    (host.querySelector('.flow-modal .confirm') as HTMLButtonElement).click();
    expect(submit).toHaveBeenCalledWith({ ticket: '176' });
  });

  it('collects an input named __proto__ as own data without prototype pollution', () => {
    let submitted: Record<string, string> | undefined;
    createFlowInputModal(host).render(
      prompt({ inputs: [{ name: '__proto__', type: 'free-text' }] }),
      'plan',
      (v) => {
        submitted = v;
      },
    );
    (field('__proto__')!.querySelector('input') as HTMLInputElement).value = 'PWNED';
    (host.querySelector('.flow-modal .confirm') as HTMLButtonElement).click();
    expect(submitted).toBeTruthy();
    expect(Object.prototype.hasOwnProperty.call(submitted, '__proto__')).toBe(true);
    expect(submitted!['__proto__']).toBe('PWNED');
    expect(({} as Record<string, unknown>).PWNED).toBeUndefined();
  });

  it('collects every field for a multi-input prompt', () => {
    const submit = vi.fn();
    createFlowInputModal(host).render(
      prompt({ inputs: [{ name: 'ticket', type: 'github-ticket' }, { name: 'note', type: 'free-text' }] }),
      'plan',
      submit,
    );
    (field('ticket')!.querySelector('input') as HTMLInputElement).value = '176';
    (field('note')!.querySelector('input') as HTMLInputElement).value = 'urgent';
    (host.querySelector('.flow-modal .confirm') as HTMLButtonElement).click();
    expect(submit).toHaveBeenCalledWith({ ticket: '176', note: 'urgent' });
  });

  it('ignores Confirm and Cancel while a submit is still being answered, and shows Confirm busy', async () => {
    let answer!: () => void;
    const submit = vi.fn(() => new Promise<void>((res) => (answer = res)));
    createFlowInputModal(host).render(prompt(), 'plan', submit);
    (field('ticket')!.querySelector('input') as HTMLInputElement).value = '176';
    const confirm = buttonNamed('Confirm & bootstrap')!;

    confirm.click();
    confirm.click();
    buttonNamed('Cancel')!.click();
    host.querySelector('.flow-modal')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    host.querySelector<HTMLElement>('.flow-scrim')?.click();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    expect(confirm.getAttribute('aria-busy')).toBe('true');

    answer();
    await vi.waitFor(() => expect(confirm.getAttribute('aria-busy')).toBeNull());
    confirm.click();
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('Cancel closes the modal without submitting', () => {
    const submit = vi.fn();
    createFlowInputModal(host).render(prompt(), 'plan', submit);
    (host.querySelector('.flow-modal .cancel') as HTMLButtonElement).click();
    expect(submit).not.toHaveBeenCalled();
    expect(host.querySelector('.flow-modal')).toBeNull();
  });

  it('Escape closes the modal without submitting', () => {
    const submit = vi.fn();
    createFlowInputModal(host).render(prompt(), 'plan', submit);
    host.querySelector('.flow-modal')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(submit).not.toHaveBeenCalled();
    expect(host.querySelector('.flow-modal')).toBeNull();
  });

  it('scrim click closes the modal without submitting', () => {
    const submit = vi.fn();
    createFlowInputModal(host).render(prompt(), 'plan', submit);
    (host.querySelector('.flow-scrim') as HTMLElement).click();
    expect(submit).not.toHaveBeenCalled();
    expect(host.querySelector('.flow-modal')).toBeNull();
  });

  it('does not submit while a required field is empty (no junk empty value persisted, §18.4)', () => {
    // Every prompted input is required (the entry action only prompts for unsatisfied required inputs);
    // an empty Confirm would persist `''` and silently re-prompt, so it must be a no-op until filled.
    const submit = vi.fn();
    createFlowInputModal(host).render(prompt(), 'plan', submit);
    (host.querySelector('.flow-modal .confirm') as HTMLButtonElement).click();
    expect(submit).not.toHaveBeenCalled();
    expect(host.querySelector('.flow-modal')).toBeTruthy();
    (field('ticket')!.querySelector('input') as HTMLInputElement).value = '176';
    (host.querySelector('.flow-modal .confirm') as HTMLButtonElement).click();
    expect(submit).toHaveBeenCalledWith({ ticket: '176' });
  });

  it('render(null) closes any open modal', () => {
    const modal = createFlowInputModal(host);
    modal.render(prompt(), 'plan', vi.fn());
    expect(host.querySelector('.flow-modal')).toBeTruthy();
    modal.render(null, '', vi.fn());
    expect(host.querySelector('.flow-modal')).toBeNull();
  });

  it('renders identically in a second host (placement-agnostic, UI-STANDARDS §1.2)', () => {
    document.body.innerHTML = '<div id="a"></div><div id="b"></div>';
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    createFlowInputModal(a).render(prompt(), 'plan', vi.fn());
    createFlowInputModal(b).render(prompt(), 'plan', vi.fn());
    // Identical structure apart from the per-instance title id (unique by design so two modals in one
    // document keep valid HTML / aria-labelledby, WCAG 4.1.2); normalize it before comparing.
    const norm = (html: string): string => html.replace(/flow-modal-title-\d+/g, 'flow-modal-title');
    expect(norm(a.innerHTML)).toBe(norm(b.innerHTML));
  });

  it('builds from host.ownerDocument, not the global document (UI-STANDARDS §3.3)', async () => {
    await assertRendersFromHostDocument((h) => createFlowInputModal(h).render(prompt(), 'plan', vi.fn()));
  });

  it('names the dialog via aria-labelledby pointing at its heading (WCAG 4.1.2)', () => {
    createFlowInputModal(host).render(prompt(), 'plan', vi.fn());
    const dialog = host.querySelector('.flow-modal')!;
    const labelledby = dialog.getAttribute('aria-labelledby');
    expect(labelledby).toBeTruthy();
    expect(host.querySelector(`#${labelledby}`)?.textContent).toBe(dialog.querySelector('h3')?.textContent);
  });

  it('restores focus to the opener element when the modal closes (WCAG 2.4.3)', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);
    const modal = createFlowInputModal(host);
    modal.render(prompt(), 'plan', vi.fn());
    expect(document.activeElement).not.toBe(opener);
    (host.querySelector('.flow-modal .cancel') as HTMLButtonElement).click();
    expect(document.activeElement).toBe(opener);
  });

  it('restores opener focus when the strip closes it via render(null) — the submit path (WCAG 2.4.3)', () => {
    // Confirm → provideInput → the strip calls render(null) to dismiss; that path must restore focus
    // just like Cancel/Escape/scrim, not strand it on <body>.
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const modal = createFlowInputModal(host);
    modal.render(prompt(), 'plan', vi.fn());
    expect(document.activeElement).not.toBe(opener);
    modal.render(null, '', vi.fn());
    expect(document.activeElement).toBe(opener);
  });

  it('keeps the original opener when re-rendered with a new prompt while already open (WCAG 2.4.3)', () => {
    // A fresh transition can render a new prompt over an already-open modal; capturing the opener
    // again would grab the (about-to-be-detached) modal child, stranding focus on <body> at close.
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const modal = createFlowInputModal(host);
    modal.render(prompt(), 'plan', vi.fn());
    expect(document.activeElement).not.toBe(opener);
    modal.render(prompt({ inputs: [{ name: 'note', type: 'free-text' }] }), 'build', vi.fn());
    modal.render(null, '', vi.fn());
    expect(document.activeElement).toBe(opener);
  });

  it('gives each instance a unique title id so two modals in one document keep valid aria-labelledby (WCAG 4.1.2)', () => {
    document.body.innerHTML = '<div id="a"></div><div id="b"></div>';
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    createFlowInputModal(a).render(prompt(), 'plan', vi.fn());
    createFlowInputModal(b).render(prompt(), 'build', vi.fn());
    const dialogA = a.querySelector('.flow-modal')!;
    const dialogB = b.querySelector('.flow-modal')!;
    const idA = dialogA.querySelector('h3')!.id;
    const idB = dialogB.querySelector('h3')!.id;
    expect(idA).not.toBe(idB);
    expect(dialogA.getAttribute('aria-labelledby')).toBe(idA);
    expect(dialogB.getAttribute('aria-labelledby')).toBe(idB);
    expect(a.querySelector(`#${idA}`)).toBe(dialogA.querySelector('h3'));
    expect(b.querySelector(`#${idB}`)).toBe(dialogB.querySelector('h3'));
  });

  it('dispose() leaves nothing behind: clears the host subtree and drops captured opener state', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const modal = createFlowInputModal(host);
    modal.render(prompt(), 'plan', vi.fn());
    expect(host.childElementCount).toBeGreaterThan(0);

    modal.dispose();
    expect(host.childElementCount).toBe(0);

    // After dispose the captured opener must be dropped: a later close path must not steal focus back.
    const other = document.createElement('button');
    document.body.appendChild(other);
    other.focus();
    expect(document.activeElement).toBe(other);
    modal.render(null, '', vi.fn());
    expect(document.activeElement).toBe(other);
    expect(host.childElementCount).toBe(0);
  });

  it('describes the dialog via aria-describedby pointing at its instructional paragraph (WCAG 1.3.1/4.1.2)', () => {
    createFlowInputModal(host).render(prompt(), 'plan', vi.fn());
    const dialog = host.querySelector('.flow-modal')!;
    const describedby = dialog.getAttribute('aria-describedby');
    expect(describedby).toBeTruthy();
    expect(host.querySelector(`#${describedby}`)?.classList.contains('ph')).toBe(true);
  });

  it('associates the first field help text with its input via aria-describedby (WCAG 1.3.1)', () => {
    createFlowInputModal(host).render(prompt(), 'plan', vi.fn());
    const input = field('ticket')!.querySelector('input')!;
    const describedby = input.getAttribute('aria-describedby');
    expect(describedby).toBeTruthy();
    const help = host.querySelector(`#${describedby}`);
    expect(help?.classList.contains('help')).toBe(true);
    // The association carries the rewritten AC 10 description, so it cannot silently lapse as the text changes.
    expect(help?.textContent).toContain("bound loop definition's own branch-and-draft-PR setup");
  });

  it('traps Tab focus within the dialog (WCAG 2.4.3): last wraps to first, first wraps to last', () => {
    createFlowInputModal(host).render(prompt(), 'plan', vi.fn());
    const modal = host.querySelector('.flow-modal') as HTMLElement;
    const focusables = [...modal.querySelectorAll<HTMLElement>('input,button')];
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    last.focus();
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first);
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(last);
  });
});
