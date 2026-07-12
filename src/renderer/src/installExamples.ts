// Install-examples VIEW organism — §18.1/§23.4/§26.5; blocking-dialog pattern per UI-STANDARDS §5.

import {
  INSTALL_DESTINATION_IDS,
  type InstallDestinationFiles,
  type InstallDestinationId,
  type InstallDestinationPreview,
  type InstallExamplesPreview,
  type InstallExamplesResult,
  type InstallExamplesWritten,
} from '../../shared/ipc';
import { createModalShell } from './modalShell';
import { captureFocusReturn } from './dom';

export interface InstallExamplesDeps {
  preview(): Promise<InstallExamplesPreview>;
  apply(replace: InstallDestinationId[]): Promise<InstallExamplesResult>;
}

export interface InstallExamples {
  dispose(): void;
}

const DESTINATION_LABEL: Record<InstallDestinationId, string> = {
  flow: 'Flow home',
  loops: 'Loop definitions',
  skills: 'Claude Code skills',
  commands: 'Claude Code commands',
};

// The created/overwritten/skipped sets are the contract's own vocabulary — derive from it so the two
// cannot drift (CLAUDE.md shared-semantics rule).
type Report = InstallExamplesWritten;

function total(groups: InstallDestinationFiles[]): number {
  return groups.reduce((n, g) => n + g.files.length, 0);
}

function counts(report: Report): string {
  return `created ${total(report.created)}, overwrote ${total(report.overwritten)}, skipped ${total(report.skipped)}.`;
}

function summarize(report: Report): string {
  return `Installed examples — ${counts(report)}`;
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
    el(
      'div',
      'sub',
      'Install the bundled feature-dev flow, its loop definitions, the reviewer persona skills, and the bundled commands so a new instance can render and run them.',
    ),
  );

  const card = el('div', 'kprofile');
  const txt = el('div');
  txt.append(
    el('div', 'kp-label', 'feature-dev flow'),
    el(
      'div',
      'kp-help',
      'Copies the flow to ~/.agent-terminal, and the loop definitions, persona skills and commands to your Claude config directory. Files you already have are left untouched unless you choose to replace them.',
    ),
  );
  const btn = el('button', 'pill signal', 'Install examples');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Install examples — the bundled feature-dev flow');
  card.append(txt, btn);

  const status = el('div', 'cli-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const alert = el('div', 'cli-status err');
  alert.setAttribute('role', 'alert');

  // Detail lives outside the live region so a screen reader is not read every file name (WCAG 4.1.3).
  const reportList = el('ul', 'install-report');
  reportList.setAttribute('aria-label', 'Installation report');
  reportList.hidden = true;

  const modalHost = el('div', 'install-examples-modal-host');

  root.append(head, card, status, alert, reportList, modalHost);
  host.appendChild(root);

  // A no-choice dismissal stops the operation, so the live region must retract it. Emptying a polite
  // region announces nothing, so the retraction has to be an additive text change (WCAG 4.1.3).
  const modal = createModalShell(modalHost, 'install-examples-replace', () =>
    showStatus('cli-status', 'Install cancelled.'),
  );

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

  function renderReport(report: Report): void {
    reportList.replaceChildren();
    for (const id of INSTALL_DESTINATION_IDS) {
      const lines: string[] = [];
      for (const [label, groups] of [
        ['created', report.created],
        ['overwrote', report.overwritten],
        ['skipped', report.skipped],
      ] as const) {
        const files = groups.find((g) => g.destination === id)?.files ?? [];
        if (files.length > 0) lines.push(`${label} ${files.length}: ${files.join(', ')}`);
      }
      if (lines.length === 0) continue;
      const item = el('li');
      item.setAttribute('data-destination', id);
      item.append(el('div', 'ir-dest', DESTINATION_LABEL[id]));
      for (const line of lines) item.append(el('div', 'ir-line', line));
      reportList.append(item);
    }
    reportList.hidden = reportList.childElementCount === 0;
  }

  let busy = false;
  // Kept focusable while busy: `disabled` blurs the pressed button to <body> for the whole round-trip,
  // so the progress announcement would arrive with focus nowhere (WCAG 2.4.3, 4.1.2).
  function setBusy(v: boolean): void {
    busy = v;
    btn.setAttribute('aria-disabled', String(v));
    btn.setAttribute('aria-busy', String(v));
  }
  setBusy(false);

  async function install(replace: InstallDestinationId[], returnFocus: () => void): Promise<void> {
    setBusy(true);
    showStatus('cli-status', 'Installing…');
    try {
      const res = await deps.apply(replace);
      renderReport(res);
      // The failure arm carries the same created/overwritten/skipped sets, and this is the branch where
      // the user most needs them: a partial install is not rolled back (§18.1), so the alert has to say
      // what landed, not just what broke (WCAG 4.1.3).
      if (res.ok) showStatus('cli-status ok', summarize(res));
      else showError(`${res.error} — ${counts(res)}`);
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Install failed.');
    } finally {
      setBusy(false);
      returnFocus();
    }
  }

  type Conflict = Extract<InstallDestinationPreview, { conflict: true }>;

  function promptReplace(conflicts: Conflict[], returnFocus: () => void): void {
    modal.render(({ doc: d, titleId, close, confirm: accept }) => {
      const describedById = `${titleId}-msg`;
      const cardEl = d.createElement('div');
      cardEl.className = 'card';
      const h3 = d.createElement('h3');
      h3.className = 'serif';
      h3.id = titleId;
      h3.textContent = 'Replace existing files?';
      const p = d.createElement('p');
      p.className = 'ph';
      p.id = describedById;
      p.textContent =
        'Some places already hold files that differ from the bundled versions. Choose where to replace them — anything you leave unchecked keeps your files. Missing files are installed either way.';
      cardEl.append(h3, p);

      // Not a <fieldset>: Chromium renders its children in an anonymous content box, so it can be neither a
      // scroll box nor a shrinkable flex column. WAI-ARIA `group` + aria-labelledby, on a box that can be.
      const group = d.createElement('div');
      group.className = 'install-consent';
      group.setAttribute('role', 'group');
      group.setAttribute('data-modal-grow', ''); // the shell's body slot (UI §5)
      const groupLabelId = `${titleId}-consent-group-label`;
      group.setAttribute('aria-labelledby', groupLabelId);
      const groupLabel = d.createElement('span');
      groupLabel.className = 'ic-group-label';
      groupLabel.id = groupLabelId;
      groupLabel.textContent = 'Replace files in';
      const rows = d.createElement('div');
      rows.className = 'install-consent-rows';
      rows.setAttribute('data-modal-scroll', '');
      group.append(groupLabel, rows);

      const boxes = new Map<InstallDestinationId, HTMLInputElement>();
      for (const conflict of conflicts) {
        // accname 1.2 step 2D folds the WHOLE label subtree into the control's name, so the file manifest
        // has to sit OUTSIDE the label and attach as a description — otherwise the checkbox announces
        // dozens of paths before the user hears which destination it is (WCAG 4.1.2).
        const row = d.createElement('div');
        row.className = 'install-consent-opt';
        const label = d.createElement('label');
        label.className = 'ic-label';
        const box = d.createElement('input');
        box.type = 'checkbox';
        box.setAttribute('data-destination', conflict.destination);
        const filesId = `${titleId}-${conflict.destination}-files`;
        box.setAttribute('aria-describedby', filesId);
        const name = d.createElement('span');
        name.className = 'ic-name';
        name.textContent = `${DESTINATION_LABEL[conflict.destination]} — ${conflict.files.length} file${conflict.files.length === 1 ? '' : 's'}`;
        label.append(box, name);
        const files = d.createElement('span');
        files.className = 'ic-files';
        files.id = filesId;
        files.textContent = conflict.files.join(', ');
        row.append(label, files);
        rows.append(row);
        boxes.set(conflict.destination, box);
      }
      cardEl.append(group);

      const foot = d.createElement('div');
      foot.className = 'mfoot';
      const cancel = d.createElement('button');
      cancel.type = 'button';
      cancel.className = 'pill cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => close());
      const confirm = d.createElement('button');
      confirm.type = 'button';
      confirm.className = 'pill signal confirm';
      confirm.textContent = 'Install';
      confirm.addEventListener('click', () => {
        const replace = [...boxes].filter(([, box]) => box.checked).map(([id]) => id);
        accept(); // NOT close(): installing is the affirmative answer, so nothing is retracted
        void install(replace, returnFocus);
      });
      foot.append(cancel, confirm);
      cardEl.append(foot);

      return { card: cardEl, initialFocus: boxes.values().next().value ?? confirm, describedById };
    });
  }

  async function run(): Promise<void> {
    if (busy) return;
    const returnFocus = captureFocusReturn(btn);
    setBusy(true);
    reportList.replaceChildren();
    reportList.hidden = true;
    showStatus('cli-status', 'Checking…');
    let conflicts: Conflict[];
    try {
      const preview = await deps.preview();
      if (!preview.ok) {
        showError(preview.error);
        setBusy(false);
        returnFocus();
        return;
      }
      conflicts = preview.destinations.flatMap((d) => (d.conflict ? [d] : []));
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Install failed.');
      setBusy(false);
      returnFocus();
      return;
    }
    if (conflicts.length === 0) {
      await install([], returnFocus);
      return;
    }
    setBusy(false);
    promptReplace(conflicts, returnFocus);
  }

  btn.addEventListener('click', () => void run());

  return {
    dispose: () => {
      modal.dispose();
      host.replaceChildren();
    },
  };
}
