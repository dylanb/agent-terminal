// The typed-input modal (§24.2.3 T3 / §18.4) — a placement-agnostic organism (UI-STANDARDS §1.2),
// the ONE deliberate blocking surface, shown when entering a step whose `bootstrap` needs a required
// input not yet resolved. The strip decides WHEN to open/close it (render(prompt|null)).

import type { FlowPrompt } from '../../shared/ipc';

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

let modalSeq = 0; // instance-unique title ids: two modals in one document must not collide (WCAG 4.1.2)

export function createFlowInputModal(host: HTMLElement): FlowInputModal {
  const doc = host.ownerDocument; // host's document, not global — relocation (UI §2.2.1)
  const titleId = `flow-modal-title-${modalSeq++}`; // aria-labelledby target
  let opener: HTMLElement | null = null; // focus to restore on close (WCAG 2.4.3)
  const close = (): void => {
    host.replaceChildren();
    opener?.focus();
    opener = null;
  };
  return {
    render(prompt, stepName, submit) {
      if (!prompt) return close();
      const wasOpen = host.firstChild !== null;
      host.replaceChildren();
      // Only on the FIRST open: a re-render over an open modal would capture the just-detached modal
      // child (activeElement → <body>) and strand focus there at close (WCAG 2.4.3).
      if (!wasOpen) opener = doc.activeElement as HTMLElement | null;

      const scrim = doc.createElement('div');
      scrim.className = 'flow-scrim';
      scrim.addEventListener('click', close);

      const modal = doc.createElement('div');
      modal.className = 'flow-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', titleId);
      modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') return close();
        // Trap Tab within the dialog (WCAG 2.4.3): wrap last→first and (shift) first→last so focus
        // never escapes the modal into the inert content behind the scrim.
        if (e.key === 'Tab') {
          const f = [...modal.querySelectorAll<HTMLElement>('input,button')].filter((el) => !el.hasAttribute('disabled'));
          if (f.length === 0) return;
          const first = f[0];
          const last = f[f.length - 1];
          const active = doc.activeElement;
          if (e.shiftKey && active === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
          }
        }
      });

      const card = doc.createElement('div');
      card.className = 'card';
      const h3 = doc.createElement('h3');
      h3.className = 'serif';
      h3.id = titleId;
      h3.textContent = `${stepName} needs an input`;
      const ph = doc.createElement('p');
      ph.className = 'ph';
      ph.textContent = `Entering the ${stepName} step — provide its required input to bootstrap the loop.`;
      card.append(h3, ph);

      const reads: Array<{ name: string; read: () => string }> = [];
      prompt.inputs.forEach((spec) => {
        const { field, read } = inputField(doc, spec);
        if (reads.length === 0) {
          const help = doc.createElement('div');
          help.className = 'help';
          help.textContent = `Bootstraps \`${prompt.bootstrap} <${spec.name}>\` on entry (§18.3). Threaded to later steps' inputs.`;
          field.append(help);
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

      modal.append(card);
      host.append(scrim, modal);
      (card.querySelector('input') as HTMLInputElement | null)?.focus();
    },
    // Teardown drops the host subtree (all listeners live inside it) and clears opener WITHOUT
    // close(), which would wrongly restore focus on unmount/relocation (UI §2.2.1).
    dispose() {
      host.replaceChildren();
      opener = null;
    },
  };
}
