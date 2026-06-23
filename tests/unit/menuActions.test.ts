// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runMenuEditAction, type TerminalClipboard } from '../../src/renderer/src/menuActions';

// macOS Edit-menu routing (§7.7): a menu action runs the TERMINAL clipboard action when the terminal
// surface is focused (the app-owned selection §7 + sanitized paste), else the focused input's native
// editing — so text fields keep ⌘C/⌘V/⌘A on macOS while the terminal gets ours.
function term(): TerminalClipboard {
  return { copy: vi.fn(), paste: vi.fn(), selectAll: vi.fn() };
}

describe('menuActions (§7.7)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('routes to the terminal action when the terminal textarea is focused', () => {
    document.body.innerHTML = '<div id="terminal"><textarea class="xterm-helper-textarea"></textarea></div>';
    (document.querySelector('.xterm-helper-textarea') as HTMLElement).focus();
    const t = term();
    runMenuEditAction('paste', document, t, async () => '');
    expect(t.paste).toHaveBeenCalled();
  });

  it('routes to the terminal action when nothing is focused (the primary surface)', () => {
    const t = term();
    runMenuEditAction('copy', document, t, async () => '');
    expect(t.copy).toHaveBeenCalled();
  });

  it('falls back to native copy / select-all for a focused non-terminal input', () => {
    document.body.innerHTML = '<input id="f">';
    (document.getElementById('f') as HTMLInputElement).focus();
    const exec = vi.fn().mockReturnValue(true);
    (document as unknown as { execCommand: unknown }).execCommand = exec; // jsdom does not implement it
    const t = term();
    runMenuEditAction('copy', document, t, async () => '');
    runMenuEditAction('selectAll', document, t, async () => '');
    expect(t.copy).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledWith('copy');
    expect(exec).toHaveBeenCalledWith('selectAll');
  });

  it('pastes into a focused input via the OS clipboard + insertText', async () => {
    document.body.innerHTML = '<input id="f">';
    (document.getElementById('f') as HTMLInputElement).focus();
    const exec = vi.fn().mockReturnValue(true);
    (document as unknown as { execCommand: unknown }).execCommand = exec; // jsdom does not implement it
    const t = term();
    runMenuEditAction('paste', document, t, async () => 'hello');
    await Promise.resolve();
    await Promise.resolve();
    expect(t.paste).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledWith('insertText', false, 'hello');
  });
});
