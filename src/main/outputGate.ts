// Renderer-output gate (§4 Flow A / §8.1). The PTY can emit bytes (rc-file echo,
// motd, early agent output) before the renderer has registered its pty:data
// listener. Those bytes must reach the renderer once it is ready, or the visible
// screen diverges from the shadow. Buffer until open(), then pass through.

export interface OutputGate {
  send(data: string): void;
  /** Flush the buffer (in order) and switch to pass-through. Idempotent. */
  open(): void;
}

export function createOutputGate(emit: (data: string) => void): OutputGate {
  let opened = false;
  const queued: string[] = [];
  return {
    send(data) {
      if (opened) emit(data);
      else queued.push(data);
    },
    open() {
      if (opened) return;
      opened = true;
      for (const d of queued) emit(d);
      queued.length = 0;
    },
  };
}
