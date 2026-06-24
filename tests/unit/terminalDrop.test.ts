// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { formatDroppedPaths, wireTerminalDrop } from '../../src/renderer/src/terminal';
import { PASTE_END } from '../../src/shared/paste';

// §7.8 drop-to-paste: a file dropped on the terminal pane pastes its single-quoted path at the prompt
// (no submit), reusing the §7.5/§9.3 sanitized paste seam. The handler's observable boundary is the
// paste call (the text handed to the terminal) and the drag-over affordance class on the container.

const dropEvent = (files: File[]): Event => {
  const e = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'dataTransfer', { value: { files } });
  return e;
};

describe('formatDroppedPaths (§7.8 single-quoting)', () => {
  it('single-quotes each path and joins with a space', () => {
    expect(formatDroppedPaths(['/tmp/a.png', '/tmp/b.txt'])).toBe("'/tmp/a.png' '/tmp/b.txt'");
  });

  it('keeps a path with spaces intact inside the quotes', () => {
    expect(formatDroppedPaths(['/tmp/my shot.png'])).toBe("'/tmp/my shot.png'");
  });

  it('escapes an embedded single quote POSIX-style so the path survives', () => {
    expect(formatDroppedPaths(["/tmp/it's.png"])).toBe("'/tmp/it'\\''s.png'");
  });

  it('strips embedded control characters so a hostile filename cannot submit a line (§7.8)', () => {
    // A POSIX filename may legally contain CR/LF; term.paste normalizes \n→\r, which submits the line
    // when bracketed-paste is off — breaking §7.8's "no submit". No C0 control may reach the paste seam.
    expect(formatDroppedPaths(['/tmp/a\r\nrm -rf ~/\n'])).toBe("'/tmp/arm -rf ~/'");
  });
});

describe('wireTerminalDrop (§7.8 drop → paste path)', () => {
  const deps = (pathForFile: (f: File) => string) => {
    const paste = vi.fn();
    return { paste, opts: { pathForFile, paste } };
  };

  it('pastes every dropped file path, single-quoted and space-joined (any file type, no submit)', () => {
    const host = document.createElement('div');
    const { paste, opts } = deps((f) => `/drop/${f.name}`);
    wireTerminalDrop(host, opts);

    host.dispatchEvent(dropEvent([new File([], 'a.png'), new File([], 'notes.txt')]));

    expect(paste).toHaveBeenCalledTimes(1);
    expect(paste).toHaveBeenCalledWith("'/drop/a.png' '/drop/notes.txt'");
  });

  it('skips drag items with no filesystem path (pathForFile returns empty)', () => {
    const host = document.createElement('div');
    const { paste, opts } = deps((f) => (f.name === 'real.png' ? '/drop/real.png' : ''));
    wireTerminalDrop(host, opts);

    host.dispatchEvent(dropEvent([new File([], 'real.png'), new File([], 'fromweb')]));

    expect(paste).toHaveBeenCalledWith("'/drop/real.png'");
  });

  it('does not paste when nothing droppable resolves to a path', () => {
    const host = document.createElement('div');
    const { paste, opts } = deps(() => '');
    wireTerminalDrop(host, opts);
    host.dispatchEvent(dropEvent([new File([], 'x')]));
    expect(paste).not.toHaveBeenCalled();
  });

  it('neutralizes an embedded ESC[201~ paste-breakout from a hostile filename (§9.3)', () => {
    // Stripping C0 controls removes the ESC byte itself, so no bracketed-paste breakout can form; the
    // residual literal `[201~` is harmless printable text.
    const host = document.createElement('div');
    const { paste, opts } = deps(() => `/drop/evil${PASTE_END}name.png`);
    wireTerminalDrop(host, opts);
    host.dispatchEvent(dropEvent([new File([], 'evil')]));
    const pasted = paste.mock.calls[0][0] as string;
    expect(pasted).not.toContain(PASTE_END);
    expect(pasted).toBe("'/drop/evil[201~name.png'");
  });

  it('preventDefaults the drop so the webview does not navigate to the file', () => {
    const host = document.createElement('div');
    const { opts } = deps(() => '/drop/a');
    wireTerminalDrop(host, opts);
    const e = dropEvent([new File([], 'a')]);
    host.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it('shows the drag-over affordance while a drag is over the pane and clears it on leave/drop', () => {
    const host = document.createElement('div');
    const { opts } = deps(() => '/drop/a');
    wireTerminalDrop(host, opts);

    host.dispatchEvent(new Event('dragenter', { bubbles: true, cancelable: true }));
    expect(host.classList.contains('drag-over')).toBe(true);

    host.dispatchEvent(new Event('dragleave', { bubbles: true }));
    expect(host.classList.contains('drag-over')).toBe(false);

    host.dispatchEvent(new Event('dragenter', { bubbles: true, cancelable: true }));
    host.dispatchEvent(dropEvent([new File([], 'a')]));
    expect(host.classList.contains('drag-over')).toBe(false);
  });

  it('keeps the affordance while the drag crosses nested elements, clearing only when fully left (§7.8)', () => {
    // The pane wraps nested xterm elements; dragenter/dragleave fire per child boundary, so a depth
    // counter must keep the outline up until the drag has truly left (depth back to 0), not flicker.
    const host = document.createElement('div');
    const { opts } = deps(() => '/drop/a');
    wireTerminalDrop(host, opts);

    host.dispatchEvent(new Event('dragenter', { bubbles: true, cancelable: true }));
    host.dispatchEvent(new Event('dragenter', { bubbles: true, cancelable: true }));
    host.dispatchEvent(new Event('dragleave', { bubbles: true }));
    expect(host.classList.contains('drag-over')).toBe(true); // depth 2→1: still over

    host.dispatchEvent(new Event('dragleave', { bubbles: true }));
    expect(host.classList.contains('drag-over')).toBe(false); // depth 1→0: fully left
  });

  it('dragover is preventDefaulted so the pane is a valid drop target', () => {
    const host = document.createElement('div');
    const { opts } = deps(() => '/drop/a');
    wireTerminalDrop(host, opts);
    const e = new Event('dragover', { bubbles: true, cancelable: true });
    host.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it('dispose() removes the listeners so a later drop pastes nothing', () => {
    const host = document.createElement('div');
    const { paste, opts } = deps(() => '/drop/a');
    const dispose = wireTerminalDrop(host, opts);
    dispose();
    host.dispatchEvent(dropEvent([new File([], 'a')]));
    expect(paste).not.toHaveBeenCalled();
  });
});
