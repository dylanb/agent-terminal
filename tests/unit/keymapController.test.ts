import { describe, it, expect, vi } from 'vitest';
import { createKeymapController, resolveBase } from '../../src/renderer/src/keymapController';
import { matchChord } from '../../src/shared/keymap';

// The renderer's active-keymap holder (§7.7): resolves the user's profile setting against the host OS
// (auto → mac on darwin, else pc; mac/pc force it), persists changes, and re-resolves live.
const keydown = (key: string, mods: { ctrl?: boolean; shift?: boolean; meta?: boolean }) => ({
  type: 'keydown',
  key,
  ctrlKey: !!mods.ctrl,
  altKey: false,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta,
});

describe('keymap controller — resolveBase (§7.7)', () => {
  it('auto follows the OS, mac/pc force the profile', () => {
    expect(resolveBase('auto', 'darwin')).toBe('mac');
    expect(resolveBase('auto', 'linux')).toBe('pc');
    expect(resolveBase('mac', 'linux')).toBe('mac'); // a Mac keyboard on Linux
    expect(resolveBase('pc', 'darwin')).toBe('pc');
  });
});

describe('keymap controller — live profile switch (§7.7)', () => {
  it('resolves the auto profile from the platform and re-resolves on setProfile, persisting', () => {
    const persist = vi.fn();
    const c = createKeymapController({ platform: 'linux', initial: 'auto', persist });
    // auto on Linux → PC: copy is Ctrl+Shift+C, Meta+C is unbound.
    expect(matchChord(keydown('c', { ctrl: true, shift: true }), c.current())).toBe('copy');
    expect(matchChord(keydown('c', { meta: true }), c.current())).toBeNull();

    c.setProfile('mac');
    expect(persist).toHaveBeenCalledWith('mac');
    expect(c.profile()).toBe('mac');
    // now macOS-style: Meta+C copies, Ctrl+Shift+C no longer does.
    expect(matchChord(keydown('c', { meta: true }), c.current())).toBe('copy');
    expect(matchChord(keydown('c', { ctrl: true, shift: true }), c.current())).toBeNull();
  });

  it('fires onChange when the profile changes', () => {
    const onChange = vi.fn();
    createKeymapController({ platform: 'linux', initial: 'auto', persist: vi.fn(), onChange }).setProfile('pc');
    expect(onChange).toHaveBeenCalled();
  });
});

describe('keymap controller — per-action overrides (§7.7)', () => {
  it('applies initial overrides over the base profile', () => {
    const c = createKeymapController({
      platform: 'linux',
      initial: 'auto',
      persist: vi.fn(),
      initialOverrides: { copy: [{ key: 'k', ctrl: true }] },
      persistOverrides: vi.fn(),
    });
    expect(matchChord(keydown('k', { ctrl: true }), c.current())).toBe('copy'); // overridden
    expect(matchChord(keydown('c', { ctrl: true, shift: true }), c.current())).toBeNull(); // base replaced
  });

  it('setOverride re-resolves live and persists the merged overrides', () => {
    const persistOverrides = vi.fn();
    const c = createKeymapController({ platform: 'linux', initial: 'auto', persist: vi.fn(), persistOverrides });
    c.setOverride('copy', [{ key: 'j', meta: true }]);
    expect(matchChord(keydown('j', { meta: true }), c.current())).toBe('copy');
    expect(persistOverrides).toHaveBeenCalledWith({ copy: [{ key: 'j', meta: true }] });
    expect(c.overrides()).toEqual({ copy: [{ key: 'j', meta: true }] });
  });

  it('clearOverride restores the default binding, drops the override, and persists', () => {
    const persistOverrides = vi.fn();
    const c = createKeymapController({
      platform: 'linux',
      initial: 'auto',
      persist: vi.fn(),
      initialOverrides: { copy: [{ key: 'j', meta: true }] },
      persistOverrides,
    });
    c.clearOverride('copy');
    // back to the PC default (Ctrl+Shift+C); the custom Meta+J no longer copies.
    expect(matchChord(keydown('c', { ctrl: true, shift: true }), c.current())).toBe('copy');
    expect(matchChord(keydown('j', { meta: true }), c.current())).toBeNull();
    expect(c.overrides()).toEqual({});
    expect(persistOverrides).toHaveBeenLastCalledWith({});
  });
});
