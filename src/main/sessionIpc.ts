// Per-window IPC wiring with symmetric teardown (§4G). ipcMain is a process-global
// singleton; listeners registered per window must be removed when the window closes,
// or they keep the dead window's PTY closures reachable and (once a second window can
// exist) stack so every keystroke writes to every PTY ever spawned.

export type IpcListener = (...args: unknown[]) => void;
export type IpcHandler = (...args: unknown[]) => unknown;

export interface IpcLike {
  on(channel: string, listener: IpcListener): unknown;
  removeListener(channel: string, listener: IpcListener): unknown;
  handle(channel: string, listener: IpcHandler): unknown;
  removeHandler(channel: string): unknown;
}

/** Registers send-listeners and invoke-handlers; returns a disposer that removes them all. */
export function registerIpcListeners(
  ipc: IpcLike,
  listeners: Record<string, IpcListener>,
  handlers: Record<string, IpcHandler>,
): () => void {
  for (const [channel, listener] of Object.entries(listeners)) ipc.on(channel, listener);
  for (const [channel, handler] of Object.entries(handlers)) ipc.handle(channel, handler);

  return () => {
    for (const [channel, listener] of Object.entries(listeners)) ipc.removeListener(channel, listener);
    for (const channel of Object.keys(handlers)) ipc.removeHandler(channel);
  };
}
