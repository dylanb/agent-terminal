/** True when a shell exit should terminate the app: the shell ran at least the startup-grace
 *  window. A shorter uptime is a startup failure (§5) — the caller keeps the window open so the
 *  exit diagnostic stays visible instead of the app vanishing undiagnosably. */
export function shouldTerminateOnShellExit(uptimeMs: number, graceMs: number): boolean {
  return uptimeMs >= graceMs;
}
