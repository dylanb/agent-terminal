// The typed-input modal (§24.2.3 T3 / §18.4) — a placement-agnostic blocking dialog (UI-STANDARDS
// §5), the ONE deliberate blocking surface, shown when entering a step whose `bootstrap` needs a
// required input not yet resolved. Composes createModalShell and supplies the input-field body; the
// strip decides WHEN to open/close it.

import type { FlowPrompt } from '../../shared/ipc';
import { createModalShell } from './modalShell';

export interface FlowInputModal {
  /** Open the modal for `prompt`, entering `stepName`; `submit` receives the name→value map on
   *  Confirm. `null` closes any open modal. */
  render(prompt: FlowPrompt | null, stepName: string, submit: (values: Record<string, string>) => void): void;
  /** Tear down: clear the host subtree and drop captured state on unmount/relocation (UI §2.2.1). */
  dispose(): void;
}

function inputField(doc: Document, spec: { name: string; type: string }): { field: HTMLElement; read: () => string } {
  const field = doc.createElement('div');
  field.className = 'field';
  const lab = doc.createElement('div');
  lab.className = 'flab';
  const nm = doc.createElement('span');
  nm.className = 'nm';
  nm.textContent = spec.name;
  const ty = doc.createElement('span');
  ty.className = 'ty';
  ty.textContent = spec.type;
  lab.append(nm, ty);
  const input = doc.createElement('input');
  input.setAttribute('aria-label', spec.name);
  field.append(lab, input);
  return { field, read: () => input.value.trim() };
}

export function createFlowInputModal(host: HTMLElement, opts?: { onFocusLost?: () => void }): FlowInputModal {
  const shell = createModalShell(host, 'flow-modal-title', undefined, { onFocusLost: opts?.onFocusLost });
  return {
    render(prompt, stepName, submit) {
      if (!prompt) return shell.render(null);
      shell.render(({ doc, titleId, close }) => {
        const describedById = `${titleId}-desc`;
        const card = doc.createElement('div');
        card.className = 'card';
        const h3 = doc.createElement('h3');
        h3.className = 'serif';
        h3.id = titleId;
        h3.textContent = `${stepName} needs an input`;
        const ph = doc.createElement('p');
        ph.className = 'ph';
        ph.id = describedById;
        ph.textContent = `Entering the ${stepName} step — provide its required input to bootstrap the loop.`;
        card.append(h3, ph);

        const reads: Array<{ name: string; read: () => string }> = [];
        prompt.inputs.forEach((spec) => {
          const { field, read } = inputField(doc, spec);
          if (reads.length === 0) {
            const help = doc.createElement('div');
            help.className = 'help';
            const helpId = `${titleId}-help`;
            help.id = helpId;
            help.textContent = `Runs ${prompt.bootstrap} on entry: the bound loop definition's own branch-and-draft-PR setup. Threaded to later steps' inputs.`;
            field.append(help);
            field.querySelector('input')?.setAttribute('aria-describedby', helpId);
          }
          reads.push({ name: spec.name, read });
          card.append(field);
        });

        const foot = doc.createElement('div');
        foot.className = 'mfoot';
        const cancel = doc.createElement('button');
        cancel.className = 'pill cancel';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', close);
        const confirm = doc.createElement('button');
        confirm.className = 'pill signal confirm';
        confirm.textContent = 'Confirm & bootstrap';
        confirm.addEventListener('click', () => {
          // Null-prototype map: an input named `__proto__` must store as own data, not hit the
          // prototype setter (which would drop the value and is a prototype-pollution vector, §18.4).
          const values: Record<string, string> = Object.create(null);
          reads.forEach((r) => {
            values[r.name] = r.read();
          });
          // Every prompted input is required (§18.4); refuse a submit with any empty value, re-prompt.
          if (reads.some((r) => values[r.name].length === 0)) return;
          submit(values);
        });
        foot.append(cancel, confirm);
        card.append(foot);

        return { card, initialFocus: card.querySelector('input'), describedById };
      });
    },
    dispose() {
      shell.dispose();
    },
  };
}
