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
  const doc = host.ownerDocument; // build from the host's document so the modal relocates (UI §2.2.1)
  const titleId = `flow-modal-title-${modalSeq++}`; // names the dialog (aria-labelledby → the heading)
  let opener: HTMLElement | null = null; // the element focused when the modal opened (§2.4.3 restore)
  const close = (): void => {
    host.replaceChildren();
    opener?.focus(); // return focus to whoever opened the dialog
    opener = null;
  };
  return {
    render(prompt, stepName, submit) {
      if (!prompt) return close(); // the strip dismissing the modal (incl. the submit path) restores focus
      const wasOpen = host.firstChild !== null;
      host.replaceChildren();
      // Capture the opener only on the FIRST open; a re-render over an already-open modal would else
      // grab the just-detached modal child (activeElement → <body>) and strand focus there at close.
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
        const values: Record<string, string> = {};
        reads.forEach((r) => {
          values[r.name] = r.read();
        });
        // Every prompted input is required (the entry action only prompts for unsatisfied required
        // inputs, §18.4); refuse a submit that would persist an empty value and silently re-prompt.
        if (reads.some((r) => values[r.name].length === 0)) return;
        submit(values);
      });
      foot.append(cancel, confirm);
      card.append(foot);

      modal.append(card);
      host.append(scrim, modal);
      (card.querySelector('input') as HTMLInputElement | null)?.focus();
    },
    // Every listener sits on a node inside the host subtree (scrim/modal/buttons) and dies with it;
    // nothing is attached to document/window. So teardown is: drop the host subtree and the only
    // captured state (opener) — without calling close(), which would restore focus to it (§2.2.1).
    dispose() {
      host.replaceChildren();
      opener = null;
    },
  };
}
