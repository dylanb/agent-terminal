// Install-examples VIEW organism (§18.1/§23.4 / UI-STANDARDS): a single Install action that seeds the
// bundled feature-dev flow into the global flow home. Non-destructive — a read-only preview drives an
// up-front overwrite prompt (the blocking-dialog pattern via createModalShell, UI §5) only when a target
// exists and differs; otherwise it installs without prompting. Built from the host document so it stays
// relocatable; signals out only through the injected contract.

import type { InstallExamplesPreview, InstallExamplesResult } from '../../shared/ipc';
import { createModalShell } from './modalShell';

export interface InstallExamplesDeps {
  preview(): Promise<InstallExamplesPreview>;
  apply(overwrite: boolean): Promise<InstallExamplesResult>;
}

export interface InstallExamples {
  dispose(): void;
}

function report(label: string, files: string[]): string {
  return files.length === 0 ? `${label} none` : `${label} ${files.length} (${files.join(', ')})`;
}

function resultMessage(res: Extract<InstallExamplesResult, { ok: true }>): string {
  return `Installed examples — ${report('created', res.created)}, ${report('overwrote', res.overwritten)}, ${report('skipped', res.skipped)}.`;
}

export function createInstallExamples(host: HTMLElement, deps: InstallExamplesDeps): InstallExamples {
  const doc = host.ownerDocument;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const root = el('div', 'kview install-examples');
  const head = el('div', 'kview-head');
  head.append(
    el('div', 'eyebrow', 'Settings'),
    el('h1', 'serif', 'Example flow'),
    el('div', 'sub', 'Install the bundled feature-dev flow into your global flow home so a new instance renders it outside a repo.'),
  );

  const card = el('div', 'kprofile');
  const txt = el('div');
  txt.append(
    el('div', 'kp-label', 'feature-dev flow'),
    el('div', 'kp-help', 'Copies the flow definition and its todo templates to ~/.agent-terminal. Already-customized files are left untouched unless you choose to overwrite.'),
  );
  const btn = el('button', 'pill signal', 'Install examples');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Install the bundled example flow');
  card.append(txt, btn);

  const status = el('div', 'cli-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const alert = el('div', 'cli-status err');
  alert.setAttribute('role', 'alert');

  const modalHost = el('div', 'install-examples-modal-host');

  root.append(head, card, status, alert, modalHost);
  host.appendChild(root);

  const modal = createModalShell(modalHost, 'install-examples-overwrite');

  function showStatus(cls: string, text: string): void {
    alert.textContent = '';
    status.className = cls;
    status.textContent = text;
  }
  function showError(text: string): void {
    status.className = 'cli-status';
    status.textContent = '';
    alert.textContent = text;
  }

  let busy = false;
  function setBusy(v: boolean): void {
    busy = v;
    btn.disabled = v;
  }

  function restoreFocus(hadFocus: boolean): void {
    if (hadFocus && (doc.activeElement === doc.body || doc.activeElement === btn)) btn.focus();
  }

  async function install(overwrite: boolean, hadFocus: boolean): Promise<void> {
    setBusy(true);
    showStatus('cli-status', 'Installing…');
    try {
      const res = await deps.apply(overwrite);
      if (res.ok) showStatus('cli-status ok', resultMessage(res));
      else showError(res.error);
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Install failed.');
    } finally {
      setBusy(false);
      restoreFocus(hadFocus);
    }
  }

  function promptOverwrite(count: number, hadFocus: boolean): void {
    modal.render(({ doc: d, titleId, close }) => {
      const describedById = `${titleId}-msg`;
      const cardEl = d.createElement('div');
      cardEl.className = 'card';
      const h3 = d.createElement('h3');
      h3.className = 'serif';
      h3.id = titleId;
      h3.textContent = 'Overwrite customized files?';
      const p = d.createElement('p');
      p.className = 'ph';
      p.id = describedById;
      p.textContent = `${count} file${count === 1 ? '' : 's'} already exist with different content. Overwrite ${count === 1 ? 'it' : 'them'} with the bundled version, or keep your version? Missing files are installed either way.`;
      cardEl.append(h3, p);

      const foot = d.createElement('div');
      foot.className = 'mfoot';
      const keep = d.createElement('button');
      keep.className = 'pill cancel keep';
      keep.textContent = 'Keep mine';
      keep.addEventListener('click', () => {
        close();
        void install(false, hadFocus);
      });
      const overwrite = d.createElement('button');
      overwrite.className = 'pill danger overwrite';
      overwrite.textContent = 'Overwrite';
      overwrite.addEventListener('click', () => {
        close();
        void install(true, hadFocus);
      });
      foot.append(keep, overwrite);
      cardEl.append(foot);

      return { card: cardEl, initialFocus: keep, describedById };
    });
  }

  async function run(): Promise<void> {
    if (busy) return;
    const hadFocus = doc.activeElement === btn;
    setBusy(true);
    showStatus('cli-status', 'Checking…');
    let conflicts: string[];
    try {
      conflicts = (await deps.preview()).conflicts;
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Install failed.');
      setBusy(false);
      restoreFocus(hadFocus);
      return;
    }
    if (conflicts.length === 0) {
      await install(false, hadFocus);
      return;
    }
    setBusy(false);
    promptOverwrite(conflicts.length, hadFocus);
  }

  btn.addEventListener('click', () => void run());

  return {
    dispose: () => {
      modal.dispose();
      host.replaceChildren();
    },
  };
}
