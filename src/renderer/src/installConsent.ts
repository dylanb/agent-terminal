import {
  INSTALL_DESTINATION_IDS,
  type InstallDestinationId,
  type InstallDestinationPreview,
  type InstallExamplesPreview,
  type RetiredExample,
} from '../../shared/ipc';
import { RETIRED_FLOW_IDS } from '../../shared/retiredFlows';
import type { ModalCard } from './modalShell';

export type InstallPreview = Extract<InstallExamplesPreview, { ok: true }>;

export interface InstallChoice {
  replace: InstallDestinationId[];
  removeRetired: boolean;
}

type Conflict = Extract<InstallDestinationPreview, { conflict: true }>;

const inWords = (names: readonly string[]): string =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

export const DESTINATION_LABEL: Record<InstallDestinationId, string> = {
  flow: 'Flow home',
  flowCatalog: 'Flow catalog',
  appLoops: 'App loop definitions',
  commands: 'Claude Code commands',
  agents: 'Claude Code reviewer agents',
  codexLoops: 'Codex loop definitions',
  codexAgents: 'Codex reviewer agents',
  codexSkills: 'Codex skills',
  engineGuide: 'Engine capabilities guide',
};

function retiredList(retired: RetiredExample[]): string {
  return INSTALL_DESTINATION_IDS.flatMap((id) => {
    const rels = retired.filter((r) => r.destination === id).map((r) => r.rel);
    return rels.length > 0 ? [`${DESTINATION_LABEL[id]}: ${rels.join(', ')}`] : [];
  }).join('; ');
}

const conflictsOf = (preview: InstallPreview): Conflict[] =>
  preview.destinations.flatMap((d) => (d.conflict ? [d] : []));

export function asksBeforeInstall(preview: InstallPreview): boolean {
  return conflictsOf(preview).length > 0 || preview.retired.length > 0;
}

export interface InstallConsent {
  card(foot: HTMLElement, fallbackFocus: HTMLElement): ModalCard;
  choice(): InstallChoice;
}

export function createInstallConsent(doc: Document, titleId: string, preview: InstallPreview): InstallConsent {
  const conflicts = conflictsOf(preview);
  const { retired, retiredFallback, alwaysReplaced } = preview;

  const p = doc.createElement('p');
  p.className = 'ph';
  p.id = `${titleId}-msg`;
  p.textContent = [
    ...(conflicts.length > 0
      ? ['Some places already hold files that differ from the bundled versions. Choose where to replace them — anything you leave unchecked keeps your files. Missing files are installed either way.']
      : []),
    ...(retired.length > 0
      ? [`The retired ${inWords(RETIRED_FLOW_IDS)} flows left files behind. They are kept unless you choose to remove them.`]
      : []),
    ...(conflicts.length === 0 ? ['The bundled examples are installed either way; only the ticked option removes anything.'] : []),
  ].join(' ');

  // Not a <fieldset>: Chromium renders its children in an anonymous content box, so it can be neither a
  // scroll box nor a shrinkable flex column. WAI-ARIA `group` + aria-labelledby, on a box that can be.
  const body = doc.createElement('div');
  body.className = 'install-consent-body';
  const consentGroup = (key: string, labelText: string): HTMLDivElement => {
    const group = doc.createElement('div');
    group.className = 'install-consent';
    group.setAttribute('role', 'group');
    const groupLabelId = `${titleId}-${key}-group-label`;
    group.setAttribute('aria-labelledby', groupLabelId);
    const groupLabel = doc.createElement('span');
    groupLabel.className = 'ic-group-label';
    groupLabel.id = groupLabelId;
    groupLabel.textContent = labelText;
    const rows = doc.createElement('div');
    rows.className = 'install-consent-rows';
    group.append(groupLabel, rows);
    body.append(group);
    return rows;
  };
  // accname 1.2 step 2D folds the WHOLE label subtree into the control's name, so the file manifest
  // has to sit OUTSIDE the label and attach as a description — otherwise the checkbox announces
  // dozens of paths before the user hears which choice it is (WCAG 4.1.2).
  const option = (rows: HTMLElement, key: string, nameText: string, filesText: string): HTMLInputElement => {
    const row = doc.createElement('div');
    row.className = 'install-consent-opt';
    const label = doc.createElement('label');
    label.className = 'ic-label';
    const box = doc.createElement('input');
    box.type = 'checkbox';
    const filesId = `${titleId}-${key}-files`;
    box.setAttribute('aria-describedby', filesId);
    const name = doc.createElement('span');
    name.className = 'ic-name';
    name.textContent = nameText;
    label.append(box, name);
    const files = doc.createElement('span');
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
      consentGroup('retired', 'Retired examples'),
      'retired',
      `Remove ${retired.length} retired item${retired.length === 1 ? '' : 's'}, whatever they hold`,
      [
        `${retiredList(retired)}. A run using one of these flows stops until you choose another flow.`,
        ...(retiredFallback !== null
          ? [`Your fallback flow is still the retired ${retiredFallback}, which may use what these remove: replace ${DESTINATION_LABEL.flow} too.`]
          : []),
      ].join(' '),
    );
    retiredBox.setAttribute('data-retired', '');
  }

  if (alwaysReplaced.length > 0) {
    const rows = consentGroup('always', 'Always replaced');
    for (const entry of alwaysReplaced) {
      const row = doc.createElement('div');
      row.className = 'install-consent-opt ic-fixed';
      const name = doc.createElement('span');
      name.className = 'ic-name';
      name.textContent = DESTINATION_LABEL[entry.destination];
      const files = doc.createElement('span');
      files.className = 'ic-files';
      files.textContent = entry.files.join(', ');
      row.append(name, files);
      rows.append(row);
    }
  }
  const title = doc.createElement('h3');
  title.className = 'serif';
  title.id = titleId;
  title.textContent = conflicts.length > 0 ? 'Replace existing files?' : 'Install examples?';
  const firstChoice: HTMLElement | null = boxes.values().next().value ?? retiredBox;

  return {
    card: (foot, fallbackFocus) => {
      const card = doc.createElement('div');
      card.className = 'card';
      card.append(title, p, body, foot);
      return { card, initialFocus: firstChoice ?? fallbackFocus, describedById: p.id, grow: body, scroll: body };
    },
    choice: () => ({
      replace: [...boxes].filter(([, box]) => box.checked).map(([id]) => id),
      removeRetired: retiredBox?.checked ?? false,
    }),
  };
}
