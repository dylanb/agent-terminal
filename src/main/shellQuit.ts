export interface QuittingShell {
  exited(): boolean;
  onExit(run: () => void): void;
  forceKill(): void;
}

export type QuitTimer = (ms: number, run: () => void) => void;

export function holdQuitForShell(
  _shell: QuittingShell,
  _graceMs: number,
  _after: QuitTimer,
  _quit: () => void,
): (event: { preventDefault(): void }) => void {
  return () => {};
}
