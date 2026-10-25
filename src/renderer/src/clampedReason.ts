export interface ClampedReasonDeps {
  text: string;
  full: boolean;
  onToggle(full: boolean): void;
}

export interface ClampedReason {
  dispose(): void;
}

export function createClampedReason(host: HTMLElement, deps: ClampedReasonDeps): ClampedReason {
  void host;
  void deps;
  return { dispose() {} };
}
