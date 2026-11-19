import { DEFAULT_UI_SETTINGS, type MonitorApi } from '../../shared/ipc';
import { createSwitch } from './switch';

export interface DisplaySettingsDeps {
  settings: Pick<MonitorApi, 'getSettings' | 'setSettings'>;
}

export interface DisplaySettings {
  dispose(): void;
}

export function createDisplaySettings(host: HTMLElement, deps: DisplaySettingsDeps): DisplaySettings {
  const doc = host.ownerDocument;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const root = el('div', 'kview display-settings');
  const head = el('div', 'kview-head');
  head.append(
    el('div', 'eyebrow', 'Settings'),
    el('h1', 'serif', 'Display'),
    el('div', 'sub', 'Choose what the app shows while a flow runs.'),
  );
  const row = el('div', 'display-setting');
  root.append(head, row);
  host.append(root);

  void deps.settings
    .getSettings()
    .then((s) => s.showTokenCounts, () => DEFAULT_UI_SETTINGS.showTokenCounts)
    .then((checked) => {
      createSwitch(row, {
        label: 'Show token counts',
        checked,
        onChange: (next) => deps.settings.setSettings({ showTokenCounts: next }),
      });
    });

  return { dispose: () => root.remove() };
}
