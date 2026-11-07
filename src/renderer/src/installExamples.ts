// Install-examples VIEW organism — §18.1/§23.4; blocking-dialog pattern per UI-STANDARDS §5.

import {
  INSTALL_DESTINATION_IDS,
  type InstallDestinationFiles,
  type InstallDestinationId,
  type InstallExamplesPreview,
  type InstallExamplesResult,
  type InstallExamplesReport,
  type InstallPreviewId,
} from '../../shared/ipc';
import { createModalShell } from './modalShell';
import { captureFocusReturn } from './dom';
import { createPressGroup } from './pressable';
import { DESTINATION_LABEL, asksBeforeInstall, createInstallConsent, type InstallPreview } from './installConsent';

export interface InstallExamplesDeps {
  preview(): Promise<InstallExamplesPreview>;
  apply(
    previewId: InstallPreviewId,
    replace: InstallDestinationId[],
    removeRetired: boolean,
  ): Promise<InstallExamplesResult>;
}

export interface InstallExamples {
  /** Runs what a press of the Install examples button runs. */
  open(): void;
  dispose(): void;
}

type Report = InstallExamplesReport;

function total(groups: InstallDestinationFiles[]): number {
  return groups.reduce((n, g) => n + g.files.length, 0);
}

function counts(report: Report): string {
  const removed = report.removed.length > 0 ? `, removed ${report.removed.length}` : '';
  return `created ${total(report.created)}, overwrote ${total(report.overwritten)}, skipped ${total(report.skipped)}${removed}.`;
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
      'Install the bundled feature-dev-v3 flow, its app loop definitions, and commands so a new instance can render and run them.',
    ),
  );

  const card = el('div', 'kprofile');
  const txt = el('div');
  txt.append(
    el('div', 'kp-label', 'feature-dev-v3 flow'),
    el(
      'div',
      'kp-help',
      'Copies the flow to ~/.agent-terminal, the app loop definitions and commands to your Claude config directory, and the loop definitions, reviewer agents and a skill for running them to your Codex home if Codex is installed. Files you already have are left untouched unless you choose to replace them.',
    ),
  );
  const btn = el('button', 'pill signal', 'Install examples');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Install examples — the bundled feature-dev-v3 flow');
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
      const removed = report.removed.filter((r) => r.destination === id).map((r) => r.rel);
      if (removed.length > 0) lines.push(`removed ${removed.length}: ${removed.join(', ')}`);
      const absent = report.notInstalled.find((n) => n.destination === id);
      if (absent !== undefined) lines.push(`not installed: ${absent.root} does not exist`);
      if (lines.length === 0) continue;
      const item = el('li');
      item.setAttribute('data-destination', id);
      item.append(el('div', 'ir-dest', DESTINATION_LABEL[id]));
      for (const line of lines) item.append(el('div', 'ir-line', line));
      reportList.append(item);
    }
    reportList.hidden = reportList.childElementCount === 0;
  }

  const installGroup = createPressGroup();
  installGroup.bind(btn, () => run());

  async function install(
    previewId: InstallPreviewId,
    replace: InstallDestinationId[],
    removeRetired: boolean,
    returnFocus: () => void,
  ): Promise<void> {
    showStatus('cli-status', 'Installing…');
    try {
      const res = await deps.apply(previewId, replace, removeRetired);
      renderReport(res);
      // The failure arm carries the same report, and this is the branch where the user most needs it: a
      // partial install is not rolled back (§18.1), so the alert has to say what landed, not just what broke
      // (WCAG 4.1.3).
      if (res.ok) showStatus('cli-status ok', summarize(res));
      else showError(`${res.error} — ${counts(res)}`);
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Install failed.');
    } finally {
      returnFocus();
    }
  }

  function promptReplace(preview: InstallPreview, returnFocus: () => void): void {
    modal.render(({ doc: d, titleId, close, confirm: accept }) => {
      const consent = createInstallConsent(d, titleId, preview);
      const cardEl = d.createElement('div');
      cardEl.className = 'card';
      const h3 = d.createElement('h3');
      h3.className = 'serif';
      h3.id = titleId;
      h3.textContent = consent.title;
      cardEl.append(h3, consent.explanation, consent.body);

      const foot = d.createElement('div');
      foot.className = 'mfoot';
      const cancel = d.createElement('button');
      cancel.type = 'button';
      cancel.className = 'pill cancel';
      cancel.textContent = 'Cancel';
      installGroup.bind(cancel, () => close());
      const confirm = d.createElement('button');
      confirm.type = 'button';
      confirm.className = 'pill signal confirm';
      confirm.textContent = 'Install';
      installGroup.bind(confirm, () => {
        const { replace, removeRetired } = consent.choice();
        accept(); // NOT close(): installing is the affirmative answer, so nothing is retracted
        installGroup.run(btn, () => install(preview.previewId, replace, removeRetired, returnFocus));
      });
      foot.append(cancel, confirm);
      cardEl.append(foot);

      // The body slots are declared on the contract (UI §5.7); the shell applies them.
      return { card: cardEl, initialFocus: consent.initialFocus ?? confirm, describedById: consent.explanation.id, grow: consent.body, scroll: consent.body };
    });
  }

  async function run(): Promise<void> {
    const returnFocus = captureFocusReturn(btn);
    reportList.replaceChildren();
    reportList.hidden = true;
    showStatus('cli-status', 'Checking…');
    let preview: InstallPreview;
    try {
      const response = await deps.preview();
      if (!response.ok) {
        showError(response.error);
        returnFocus();
        return;
      }
      preview = response;
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Install failed.');
      returnFocus();
      return;
    }
    if (!asksBeforeInstall(preview)) {
      await install(preview.previewId, [], false, returnFocus);
      return;
    }
    promptReplace(preview, returnFocus);
  }

  return {
    open: () => {
      btn.focus();
      installGroup.run(btn, () => run());
    },
    dispose: () => {
      modal.dispose();
      host.replaceChildren();
    },
  };
}
