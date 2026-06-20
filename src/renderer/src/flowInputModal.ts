// The typed-input modal (§24.2.3 T3 / §18.4) — a placement-agnostic organism (UI-STANDARDS §1.2)
// that renders design/shell/loop-flow.html's input modal: the ONE deliberate blocking surface, shown
// when entering a step whose `bootstrap` needs a required input that isn't resolved yet. For each
// input it renders a labelled field (name + catalog type) and an entry box; Confirm collects the
// typed values and calls `submit` (the strip's provideInput); Cancel / Escape / scrim close it
// without submitting. It touches only its host subtree and renders identically wherever mounted; the
// strip decides WHEN to open/close it (render(prompt|null)), never reaching across to it.

import type { FlowPrompt } from '../../shared/ipc';

export interface FlowInputModal {
  /** Open the modal for `prompt`, entering `stepName`; `submit` receives the name→value map on
   *  Confirm. `null` closes any open modal. */
  render(prompt: FlowPrompt | null, stepName: string, submit: (values: Record<string, string>) => void): void;
}

function inputField(spec: { name: string; type: string }): { field: HTMLElement; read: () => string } {
  const field = document.createElement('div');
  field.className = 'field';
  const lab = document.createElement('div');
  lab.className = 'flab';
  const nm = document.createElement('span');
  nm.className = 'nm';
  nm.textContent = spec.name;
  const ty = document.createElement('span');
  ty.className = 'ty';
  ty.textContent = spec.type;
  lab.append(nm, ty);
  const input = document.createElement('input');
  input.setAttribute('aria-label', spec.name);
  field.append(lab, input);
  return { field, read: () => input.value.trim() };
}

export function createFlowInputModal(host: HTMLElement): FlowInputModal {
  const close = (): void => host.replaceChildren();
  return {
    render(prompt, stepName, submit) {
      host.replaceChildren();
      if (!prompt) return;

      const scrim = document.createElement('div');
      scrim.className = 'flow-scrim';
      scrim.addEventListener('click', close);

      const modal = document.createElement('div');
      modal.className = 'flow-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close();
      });

      const card = document.createElement('div');
      card.className = 'card';
      const h3 = document.createElement('h3');
      h3.className = 'serif';
      h3.textContent = `${stepName} needs an input`;
      const ph = document.createElement('p');
      ph.className = 'ph';
      ph.textContent = `Entering the ${stepName} step — provide its required input to bootstrap the loop.`;
      card.append(h3, ph);

      const reads: Array<{ name: string; read: () => string }> = [];
      prompt.inputs.forEach((spec) => {
        const { field, read } = inputField(spec);
        if (reads.length === 0) {
          const help = document.createElement('div');
          help.className = 'help';
          help.textContent = `Bootstraps \`${prompt.bootstrap} <${spec.name}>\` on entry (§18.3). Threaded to later steps' inputs.`;
          field.append(help);
        }
        reads.push({ name: spec.name, read });
        card.append(field);
      });

      const foot = document.createElement('div');
      foot.className = 'mfoot';
      const cancel = document.createElement('button');
      cancel.className = 'pill cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', close);
      const confirm = document.createElement('button');
      confirm.className = 'pill signal confirm';
      confirm.textContent = 'Confirm & bootstrap';
      confirm.addEventListener('click', () => {
        const values: Record<string, string> = {};
        reads.forEach((r) => {
          values[r.name] = r.read();
        });
        submit(values);
      });
      foot.append(cancel, confirm);
      card.append(foot);

      modal.append(card);
      host.append(scrim, modal);
      (card.querySelector('input') as HTMLInputElement | null)?.focus();
    },
  };
}
