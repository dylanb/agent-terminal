// Launch-root resolution (§23.4): the single per-process anchor the four spawn-cwd surfaces read.

export interface LaunchRootProbe {
  realpathSync(p: string): string;
  statSync(p: string): { isDirectory(): boolean };
  accessSync(p: string, mode: number): void;
}

/**
 * The validated launch root (§23.4): the caller-supplied `target` resolved to its real path when it
 * is an enterable directory, else `fallback` (F) returned verbatim. Resolves once per process so the
 * shell cwd (§5), viewer root (§20.1), flow global dir (§18.1), and todo scope (§16.3) cannot drift.
 */
export function resolveLaunchRoot(
  target: string | undefined,
  fallback: string,
  probe?: LaunchRootProbe,
): string {
  throw new Error('not implemented');
}
