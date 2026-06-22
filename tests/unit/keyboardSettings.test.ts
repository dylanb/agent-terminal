// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKeyboardSettings, type KeyboardSettingsDeps } from '../../src/renderer/src/keyboardSettings';
import { MAC_DEFAULTS, resolveKeymap } from '../../src/shared/keymap';

// The Keyboard settings VIEW organism (§7.7 / UI-STANDARDS): a profile selector plus per-action
// rebind rows grouped by category, chords drawn as keycaps. Tests assert the observable DOM + the
// contract callbacks (never internals): grouping, keycap text, capture → onRebind, conflict block,
// reset, profile change, and relocation.
describe('keyboard settings view organism (§7.7)', () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  function deps(over: Partial<KeyboardSettingsDeps> = {}): KeyboardSettingsDeps {
    return {
      getProfile: () => 'mac',
      onProfileChange: vi.fn(),
      getKeymap: () => MAC_DEFAULTS,
      getOverrides: () => ({}),
      isMac: () => true,
      onRebind: vi.fn(),
      onReset: vi.fn(),
      ...over,
    };
  }
  const row = (a: string) => host.querySelector(`[data-action="${a}"]`) as HTMLElement;
  const rebindBtn = (a: string) => row(a).querySelector('button') as HTMLButtonElement;

  it('groups the actions under Clipboard / Editing / Navigation', () => {
    createKeyboardSettings(host, deps());
    expect(host.textContent).toContain('Clipboard');
    expect(host.textContent).toContain('Editing');
    expect(host.textContent).toContain('Navigation');
    expect(row('copy')).toBeTruthy();
    expect(row('deleteLine')).toBeTruthy();
    expect(row('openSettings')).toBeTruthy(); // ⌘, is a rebindable Navigation row
  });

  it('renders each chord as keycaps using the mac glyph set', () => {
    createKeyboardSettings(host, deps());
    const caps = [...row('copy').querySelectorAll('.kc')].map((k) => k.textContent);
    expect(caps).toEqual(['⌘', 'C']);
  });

  it('renders an unbound action as "Not set" (the PC delete-line gap)', () => {
    createKeyboardSettings(host, deps({ getKeymap: () => resolveKeymap('pc'), isMac: () => false, getProfile: () => 'pc' }));
    expect(row('deleteLine').querySelectorAll('.kc').length).toBe(0);
    expect(row('deleteLine').textContent).toContain('Not set');
  });

  it('reflects the active profile in the segmented control and reports a change', () => {
    const onProfileChange = vi.fn();
    createKeyboardSettings(host, deps({ getProfile: () => 'mac', onProfileChange }));
    const seg = host.querySelector('[role="group"]') as HTMLElement;
    expect((seg.querySelector('[aria-pressed="true"]') as HTMLElement).textContent).toMatch(/mac/i);
    const pcBtn = [...seg.querySelectorAll('button')].find((b) => /^pc$/i.test(b.textContent ?? '')) as HTMLButtonElement;
    pcBtn.click();
    expect(onProfileChange).toHaveBeenCalledWith('pc');
  });

  it('records the next chord and calls onRebind when there is no conflict', () => {
    const onRebind = vi.fn();
    createKeyboardSettings(host, deps({ onRebind }));
    rebindBtn('paste').click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: true, shiftKey: true, bubbles: true }));
    expect(onRebind).toHaveBeenCalledWith('paste', { key: 'p', meta: true, shift: true });
  });

  it('ignores a modifier-only keypress while recording (waits for a real key)', () => {
    const onRebind = vi.fn();
    createKeyboardSettings(host, deps({ onRebind }));
    rebindBtn('paste').click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true, bubbles: true }));
    expect(onRebind).not.toHaveBeenCalled();
  });

  it('blocks a chord already bound to another action, naming the conflict, with no rebind', () => {
    const onRebind = vi.fn();
    createKeyboardSettings(host, deps({ onRebind }));
    rebindBtn('paste').click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', metaKey: true, bubbles: true })); // ⌘C = Copy
    expect(onRebind).not.toHaveBeenCalled();
    expect(row('paste').textContent).toMatch(/already maps to Copy/i);
  });

  it('shows Reset on an overridden row and calls onReset', () => {
    const onReset = vi.fn();
    createKeyboardSettings(host, deps({ getOverrides: () => ({ toggleDrawer: [{ key: ' ', alt: true }] }), onReset }));
    const r = row('toggleDrawer');
    expect(r.classList.contains('mod')).toBe(true);
    const btn = r.querySelector('button') as HTMLButtonElement;
    expect(btn.textContent).toMatch(/reset/i);
    btn.click();
    expect(onReset).toHaveBeenCalledWith('toggleDrawer');
  });

  it('refresh() re-reads the profile so an async hydrate is reflected', () => {
    let profile: 'auto' | 'mac' | 'pc' = 'auto';
    const ui = createKeyboardSettings(host, deps({ getProfile: () => profile }));
    const seg = () => host.querySelector('[role="group"]') as HTMLElement;
    expect((seg().querySelector('[aria-pressed="true"]') as HTMLElement).textContent).toMatch(/auto/i);
    profile = 'mac';
    ui.refresh();
    expect((seg().querySelector('[aria-pressed="true"]') as HTMLElement).textContent).toMatch(/mac/i);
  });

  it('builds its DOM from the host document, not the ambient global (relocatable)', () => {
    const foreign = document.implementation.createHTMLDocument('foreign');
    const foreignHost = foreign.createElement('div');
    foreign.body.appendChild(foreignHost);
    createKeyboardSettings(foreignHost, deps());
    expect(foreignHost.querySelector('[data-action="copy"]')?.ownerDocument).toBe(foreign);
  });

  it('renders identically across two host placements (relocation, §3.3)', () => {
    const a = document.createElement('section');
    const b = document.createElement('aside');
    document.body.append(a, b);
    createKeyboardSettings(a, deps());
    createKeyboardSettings(b, deps());
    const caps = (h: HTMLElement) =>
      [...(h.querySelector('[data-action="copy"]') as HTMLElement).querySelectorAll('.kc')].map((k) => k.textContent);
    expect(caps(a)).toEqual(caps(b));
    expect(a.querySelectorAll('[data-action]').length).toBe(b.querySelectorAll('[data-action]').length);
  });
});
