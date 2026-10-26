import type { ChannelSpecs, SessionId } from './session';
import type { StartupApi } from './startup';

export const TERMINAL_CHANNELS = {
  ptyData: {
    name: 'pty:data',
    does: 'Main sends shell output for the terminal to draw.',
  },
  ptyInput: {
    name: 'pty:input',
    does: 'The renderer sends keystrokes or pasted text to write to the shell.',
  },
  ptyResize: {
    name: 'pty:resize',
    does: 'The renderer resizes the shell and its shadow screen to new columns and rows.',
  },
  ptyExit: {
    name: 'pty:exit',
    does: 'Main reports that the shell exited, before it ends the app.',
  },
  clipboardWrite: {
    name: 'term:clipboardWrite',
    does: 'The renderer asks main to put text on the OS clipboard, with no sessionId because the clipboard is app-wide.',
  },
  clipboardRead: {
    name: 'term:clipboardRead',
    does: 'The renderer asks main for the OS clipboard text for the sanitized paste path, with no sessionId.',
  },
  menuEdit: {
    name: 'menu:edit',
    does: 'Main forwards a macOS Edit-menu copy, paste or select-all for the renderer to route by focus.',
  },
} as const satisfies ChannelSpecs;

/** Copy payload (§7.7): clipboard is an OS resource owned by main, so the renderer routes through it.
 *  App-global like UiSettings — no sessionId. */
export interface ClipboardWriteMsg {
  text: string;
}

/** The three clipboard editing actions the macOS Edit menu routes to the renderer (§7.7). */
export type EditAction = 'copy' | 'paste' | 'selectAll';

/** menu:edit broadcast (§7.7): a macOS Edit-menu item fired; the renderer routes by focus. */
export interface MenuEditMsg {
  action: EditAction;
}

export interface PtyDataMsg {
  sessionId: SessionId;
  data: string;
}

export interface PtyInputMsg {
  sessionId: SessionId;
  data: string;
}

export interface PtyResizeMsg {
  sessionId: SessionId;
  cols: number;
  rows: number;
}

export interface PtyExitMsg {
  sessionId: SessionId;
  code: number;
}

/** Host OS, exposed to the renderer so it can resolve the `auto` keymap profile (§7.7). */
export type OsPlatform = 'darwin' | 'win32' | 'linux';

export interface TermApi {
  startup: StartupApi;
  onData(cb: (data: string) => void): () => void;
  onExit(cb: (msg: PtyExitMsg) => void): () => void;
  input(data: string): void;
  resize(size: { cols: number; rows: number }): void;
  /** Write text to the OS clipboard — backs the Copy action (§7.7). */
  clipboardWrite(text: string): void;
  /** Read text from the OS clipboard — backs the Paste action (§7.7). */
  clipboardRead(): Promise<string>;
  /** The host OS, for resolving the `auto` keymap profile in the renderer (§7.7). */
  platform: OsPlatform;
  /** Subscribe to macOS Edit-menu actions (§7.7); the renderer routes them by focus. */
  onMenuAction(cb: (action: EditAction) => void): () => void;
  /** Absolute filesystem path of a dropped `File` (§7.8) — `File.path` is gone under contextIsolation,
   *  so the renderer routes through the preload's `webUtils`. Returns `''` for a non-file drag item. */
  pathForFile(file: File): string;
}
