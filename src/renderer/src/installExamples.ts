// Install-examples VIEW organism — §18.1/§23.4; blocking-dialog pattern per UI-STANDARDS §5.

import {
  INSTALL_DESTINATION_IDS,
  type InstallDestinationFiles,
  type InstallDestinationId,
  type InstallDestinationPreview,
  type InstallExamplesPreview,
  type InstallExamplesResult,
  type InstallExamplesReport,
  type InstallPreviewId,
  type RetiredExample,
} from '../../shared/ipc';
import { createModalShell } from './modalShell';
import { captureFocusReturn } from './dom';
import { createPressGroup } from './pressable';
import { RETIRED_FLOW_IDS } from '../../shared/retiredFlows';

export interface InstallExamplesDeps {
  preview(): Promise<InstallExamplesPreview>;
  apply(
    previewId: InstallPreviewId,
    replace: InstallDestinationId[],
    removeRetired: boolean,
  ): Promise<InstallExamplesResult>;
}

export interface InstallExamples {
  dispose(): void;
}

const inWords = (names: readonly string[]): string =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

const DESTINATION_LABEL: Record<InstallDestinationId, string> = {
  flow: 'Flow home',
  flowCatalog: 'Flow catalog',
  stepLibrary: 'Step library',
  appLoops: 'App loop definitions',
  commands: 'Claude Code commands',
  agents: 'Claude Code reviewer agents',
  codexLoops: 'Codex loop definitions',
  codexAgents: 'Codex reviewer agents',
  codexSkills: 'Codex skills',
};

type Report = InstallExamplesReport;

function total(groups: InstallDestinationFiles[]): number {
  return groups.reduce((n, g) => n + g.files.length, 0);
}

function counts(report: Report): string {
  const removed = report.removed.length > 0 ? `, removed ${report.removed.length}` : '';
  return `created ${total(report.created)}, overwrote ${total(report.overwritten)}, skipped ${total(report.skipped)}${removed}.`;
}

function retiredList(retired: RetiredExample[]): string {
  return INSTALL_DESTINATION_IDS.flatMap((id) => {
    const rels = retired.filter((r) => r.destination === id).map((r) => r.rel);
    return rels.length > 0 ? [`${DESTINATION_LABEL[id]}: ${rels.join(', ')}`] : [];
  }).join('; ');
}

function summarize(report: Report): string {
  return `Installed examples — ${counts(report)}`;
}

export const MOVED_LOOPS_TEXT =
  "Some loop definitions now ship once, in the shared folder. Older copies of them are still in a flow's own folder, where they are used instead of the shared copy.";
export const MOVED_LOOPS_REMOVAL_TEXT = 'Removing an older copy makes its flow use the shared copy.';

export const RETIRED_FLOW_STOPS_TEXT = 'A run using one of these flows stops until you choose another flow.';
export const OLD_ITEM_WORD = 'old';
export const RETIRED_ITEM_WORD = 'retired';

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

  type Conflict = Extract<InstallDestinationPreview, { conflict: true }>;

  function promptReplace(
    previewId: InstallPreviewId,
    conflicts: Conflict[],
    retired: RetiredExample[],
    retiredFallback: string | null,
    returnFocus: () => void,
  ): void {
    modal.render(({ doc: d, titleId, close, confirm: accept }) => {
      const describedById = `${titleId}-msg`;
      const hasRetiredFlow = retired.some((r) => r.kind === 'retired-flow');
      const hasMovedLoop = retired.some((r) => r.kind === 'moved-loop');
      const cardEl = d.createElement('div');
      cardEl.className = 'card';
      const h3 = d.createElement('h3');
      h3.className = 'serif';
      h3.id = titleId;
      h3.textContent = conflicts.length > 0 ? 'Replace existing files?' : 'Install examples?';
      const p = d.createElement('p');
      p.className = 'ph';
      p.id = describedById;
      p.textContent = [
        ...(conflicts.length > 0
          ? ['Some places already hold files that differ from the bundled versions. Choose where to replace them — anything you leave unchecked keeps your files. Missing files are installed either way.']
          : []),
        ...(retired.length > 0
          ? [
              ...(hasRetiredFlow ? [`The retired ${inWords(RETIRED_FLOW_IDS)} flows left files behind.`] : []),
              ...(hasMovedLoop ? [MOVED_LOOPS_TEXT] : []),
              'They are kept unless you choose to remove them.',
            ]
          : []),
        ...(conflicts.length === 0 ? ['The bundled examples are installed either way; only the ticked option removes anything.'] : []),
      ].join(' ');
      cardEl.append(h3, p);

      // Not a <fieldset>: Chromium renders its children in an anonymous content box, so it can be neither a
      // scroll box nor a shrinkable flex column. WAI-ARIA `group` + aria-labelledby, on a box that can be.
      const body = d.createElement('div');
      body.className = 'install-consent-body';
      const consentGroup = (key: string, labelText: string): HTMLDivElement => {
        const group = d.createElement('div');
        group.className = 'install-consent';
        group.setAttribute('role', 'group');
        const groupLabelId = `${titleId}-${key}-group-label`;
        group.setAttribute('aria-labelledby', groupLabelId);
        const groupLabel = d.createElement('span');
        groupLabel.className = 'ic-group-label';
        groupLabel.id = groupLabelId;
        groupLabel.textContent = labelText;
        const rows = d.createElement('div');
        rows.className = 'install-consent-rows';
        group.append(groupLabel, rows);
        body.append(group);
        return rows;
      };
      // accname 1.2 step 2D folds the WHOLE label subtree into the control's name, so the file manifest
      // has to sit OUTSIDE the label and attach as a description — otherwise the checkbox announces
      // dozens of paths before the user hears which choice it is (WCAG 4.1.2).
      const option = (rows: HTMLElement, key: string, nameText: string, filesText: string): HTMLInputElement => {
        const row = d.createElement('div');
        row.className = 'install-consent-opt';
        const label = d.createElement('label');
        label.className = 'ic-label';
        const box = d.createElement('input');
        box.type = 'checkbox';
        const filesId = `${titleId}-${key}-files`;
        box.setAttribute('aria-describedby', filesId);
        const name = d.createElement('span');
        name.className = 'ic-name';
        name.textContent = nameText;
        label.append(box, name);
        const files = d.createElement('span');
        files.className = 'ic-files';
        files.id = filesId;
        files.textContent = filesText;
        row.append(label, files);
        rows.append(row);
        return box;
      };

      const boxes = new Map<InstallDestinationId, HTMLInputElement>();
      if (conflicts.length > 0) {
        const rows = consentGroup('consent', 'Replace files in');
        for (const conflict of conflicts) {
          const box = option(
            rows,
            conflict.destination,
            `${DESTINATION_LABEL[conflict.destination]} — ${conflict.files.length} file${conflict.files.length === 1 ? '' : 's'}`,
            conflict.files.join(', '),
          );
          box.setAttribute('data-destination', conflict.destination);
          boxes.set(conflict.destination, box);
        }
      }
      let retiredBox: HTMLInputElement | null = null;
      if (retired.length > 0) {
        retiredBox = option(
          consentGroup('retired', hasMovedLoop ? 'Old example files' : 'Retired examples'),
          'retired',
          `Remove ${retired.length} ${hasMovedLoop ? OLD_ITEM_WORD : RETIRED_ITEM_WORD} item${retired.length === 1 ? '' : 's'}, whatever they hold`,
          [
            `${retiredList(retired)}.`,
            ...(hasRetiredFlow ? [RETIRED_FLOW_STOPS_TEXT] : []),
            ...(hasMovedLoop ? [MOVED_LOOPS_REMOVAL_TEXT] : []),
            ...(retiredFallback !== null && hasRetiredFlow
              ? [`Your fallback flow is still the retired ${retiredFallback}, which may use what these remove: replace ${DESTINATION_LABEL.flow} too.`]
              : []),
          ].join(' '),
        );
        retiredBox.setAttribute('data-retired', '');
      }
      cardEl.append(body);

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
        const replace = [...boxes].filter(([, box]) => box.checked).map(([id]) => id);
        const removeRetired = retiredBox?.checked ?? false;
        accept(); // NOT close(): installing is the affirmative answer, so nothing is retracted
        installGroup.run(btn, () => install(previewId, replace, removeRetired, returnFocus));
      });
      foot.append(cancel, confirm);
      cardEl.append(foot);

      // The body slots are declared on the contract (UI §5.7); the shell applies them.
      return { card: cardEl, initialFocus: boxes.values().next().value ?? retiredBox ?? confirm, describedById, grow: body, scroll: body };
    });
  }

  async function run(): Promise<void> {
    const returnFocus = captureFocusReturn(btn);
    reportList.replaceChildren();
    reportList.hidden = true;
    showStatus('cli-status', 'Checking…');
    let preview: Extract<InstallExamplesPreview, { ok: true }>;
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
    const conflicts = preview.destinations.flatMap((d) =>
      d.conflict ? [d] : [],
    );
    if (conflicts.length === 0 && preview.retired.length === 0) {
      await install(preview.previewId, [], false, returnFocus);
      return;
    }
    promptReplace(preview.previewId, conflicts, preview.retired, preview.retiredFallback, returnFocus);
  }

  return {
    dispose: () => {
      modal.dispose();
      host.replaceChildren();
    },
  };
}
