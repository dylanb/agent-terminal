// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlowInputModal } from '../../src/renderer/src/flowInputModal';
import type { FlowPrompt } from '../../src/shared/ipc';

// §24.2.3 T3 — the typed-input modal organism (UI-STANDARDS §1.2): the one deliberate blocking
// surface (§18.4), rendering design/shell/loop-flow.html's input modal. For each required input it
// shows the field name + its catalog type and an entry box; Confirm collects the typed values and
// calls the submit callback; Cancel / Escape / scrim close it without submitting. It is
// placement-agnostic — it touches only its host subtree and renders identically wherever mounted.

const prompt = (over: Partial<FlowPrompt> = {}): FlowPrompt => ({
  inputs: [{ name: 'ticket', type: 'github-ticket' }],
  bootstrap: 'agent-loop pickup',
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

describe('typed-input modal (§24.2.3 T3 / §18.4)', () => {
  it('renders a labelled field per input with its catalog type and the bootstrap helper', () => {
    createFlowInputModal(host).render(prompt(), 'plan', vi.fn());
    const f = field('ticket');
    expect(f).toBeTruthy();
    expect(f!.querySelector('.ty')?.textContent).toBe('github-ticket');
    expect(f!.querySelector('input')).toBeTruthy();
    // The heading names the step being entered, and the helper names the bootstrap command (§18.3).
    expect(host.querySelector('.flow-modal h3')?.textContent).toContain('plan');
    expect(host.textContent).toContain('agent-loop pickup');
  });

  it('Confirm collects the typed values and calls submit with the name→value map', () => {
    const submit = vi.fn();
    createFlowInputModal(host).render(prompt(), 'plan', submit);
    (field('ticket')!.querySelector('input') as HTMLInputElement).value = '176';
    (host.querySelector('.flow-modal .confirm') as HTMLButtonElement).click();
    expect(submit).toHaveBeenCalledWith({ ticket: '176' });
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

  it('Cancel closes the modal without submitting', () => {
    const submit = vi.fn();
    createFlowInputModal(host).render(prompt(), 'plan', submit);
    (host.querySelector('.flow-modal .cancel') as HTMLButtonElement).click();
    expect(submit).not.toHaveBeenCalled();
    expect(host.querySelector('.flow-modal')).toBeNull(); // closed
  });

  it('Escape closes the modal without submitting', () => {
    const submit = vi.fn();
    createFlowInputModal(host).render(prompt(), 'plan', submit);
    host.querySelector('.flow-modal')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(submit).not.toHaveBeenCalled();
    expect(host.querySelector('.flow-modal')).toBeNull();
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
    expect(a.innerHTML).toBe(b.innerHTML);
  });
});
