// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyboardSettings, type KeyboardSettingsDeps } from '../../src/renderer/src/keyboardSettings';
import { PC_DEFAULTS } from '../../src/shared/keymap';

// The Keyboard settings organism (§7.7 / UI-STANDARDS): a profile selector plus a per-action rebind
// list. Tests assert the observable DOM + the contract callbacks (never internals).
describe('keyboard settings organism (§7.7)', () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  function deps(over: Partial<KeyboardSettingsDeps> = {}): KeyboardSettingsDeps {
    return {
      getProfile: () => 'pc',
      onProfileChange: vi.fn(),
      getKeymap: () => PC_DEFAULTS,
      onRebind: vi.fn(),
      ...over,
    };
  }

  it('renders a profile selector reflecting the current setting', () => {
    createKeyboardSettings(host, deps({ getProfile: () => 'mac' }));
    const select = host.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('mac');
    expect([...select.options].map((o) => o.value)).toEqual(expect.arrayContaining(['auto', 'mac', 'pc']));
  });

  it('invokes the contract callback when the user picks a different profile', () => {
    const onProfileChange = vi.fn();
    createKeyboardSettings(host, deps({ getProfile: () => 'auto', onProfileChange }));
    const select = host.querySelector('select') as HTMLSelectElement;
    select.value = 'mac';
    select.dispatchEvent(new Event('change'));
    expect(onProfileChange).toHaveBeenCalledWith('mac');
  });

  it('refresh() re-reads the current profile so an async hydrate is reflected', () => {
    let profile: 'auto' | 'mac' | 'pc' = 'auto';
    const ui = createKeyboardSettings(host, deps({ getProfile: () => profile }));
    expect((host.querySelector('select') as HTMLSelectElement).value).toBe('auto');
    profile = 'mac';
    ui.refresh();
    expect((host.querySelector('select') as HTMLSelectElement).value).toBe('mac');
  });

  it('lists a rebind row with a Record button for each action', () => {
    createKeyboardSettings(host, deps());
    expect(host.querySelector('[data-action="copy"] button')).toBeTruthy();
    expect(host.querySelector('[data-action="paste"] button')).toBeTruthy();
  });

  it('records the next chord and calls onRebind for that action', () => {
    const onRebind = vi.fn();
    createKeyboardSettings(host, deps({ onRebind }));
    (host.querySelector('[data-action="copy"] button') as HTMLButtonElement).click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    expect(onRebind).toHaveBeenCalledWith('copy', { key: 'k', ctrl: true });
  });

  it('ignores a modifier-only keypress while recording (waits for a real key)', () => {
    const onRebind = vi.fn();
    createKeyboardSettings(host, deps({ onRebind }));
    (host.querySelector('[data-action="copy"] button') as HTMLButtonElement).click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true, bubbles: true }));
    expect(onRebind).not.toHaveBeenCalled();
  });

  it('builds its DOM from the host document, not the ambient global (relocatable)', () => {
    const foreign = document.implementation.createHTMLDocument('foreign');
    const foreignHost = foreign.createElement('div');
    foreign.body.appendChild(foreignHost);
    createKeyboardSettings(foreignHost, deps({ getProfile: () => 'pc' }));
    expect(foreignHost.querySelector('select')?.ownerDocument).toBe(foreign);
  });
});
