// Correlate a flow-injected bootstrap command (`agent-loop pickup …`, §18.3) with the OSC-133 command
// span that ran it, so the audit record can carry its exit code (§25.5 `command`). The injected text
// and the span's extracted command line are the join key; once a span is recorded it is never
// re-matched. Pure so the join logic is unit-tested, not hidden behind the live tracker + PTY.

/** A bootstrap command that was injected (submit:false) and is awaiting its run's exit. */
export interface PendingBootstrap {
  repoKey: string;
  cmd: string;
}

/** The slice of a command span the matcher reads (a subset of CommandSpanSummary). */
export interface FinishedSpan {
  id: string;
  command: string;
  exitCode: number | null;
  running: boolean;
}

export interface BootstrapMatch {
  spanId: string;
  repoKey: string;
  cmd: string;
  exit: number | null;
}

// The shell may add a trailing space or echo artifacts; the extracted command line still begins with
// the injected text, so a trimmed equality OR prefix is the join (the injected text is a full line).
function commandMatches(cmd: string, spanCommand: string): boolean {
  const a = cmd.trim();
  const b = spanCommand.trim();
  return b === a || b.startsWith(a);
}

/** Finished, not-yet-recorded spans matched to pending bootstraps — each pending entry and each span
 *  used at most once. The caller records the matches, marks the span ids, and drops the pendings. */
export function matchBootstrapCommands(
  pending: PendingBootstrap[],
  spans: FinishedSpan[],
  recorded: Set<string>,
): BootstrapMatch[] {
  const matches: BootstrapMatch[] = [];
  const remaining = [...pending];
  for (const s of spans) {
    if (s.running || recorded.has(s.id)) continue;
    const i = remaining.findIndex((p) => commandMatches(p.cmd, s.command));
    if (i < 0) continue;
    matches.push({ spanId: s.id, repoKey: remaining[i].repoKey, cmd: remaining[i].cmd, exit: s.exitCode });
    remaining.splice(i, 1);
  }
  return matches;
}

/** The command-span source the correlator reads — the CommandTracker's `summaries`/`onChange` slice. */
export interface BootstrapCommandTrackerDeps {
  summaries(): FinishedSpan[];
  onChange(cb: () => void): () => void;
  recordCommand(repoKey: string, cmd: string, exit: number | null): void;
}

export interface BootstrapCommandTracker {
  /** Mark a just-injected bootstrap command awaiting its run's exit (§25.5). */
  notePending(repoKey: string, cmd: string): void;
}

/** Subscribe to command-span changes and, on each finished span matching a pending bootstrap, record
 *  its exit exactly once (§25.5). Holds the pending list and the already-recorded span ids so a span
 *  is never double-recorded across the many change events one command emits. */
export function createBootstrapCommandTracker(deps: BootstrapCommandTrackerDeps): BootstrapCommandTracker {
  const pending: PendingBootstrap[] = [];
  const recorded = new Set<string>();
  deps.onChange(() => {
    for (const m of matchBootstrapCommands(pending, deps.summaries(), recorded)) {
      deps.recordCommand(m.repoKey, m.cmd, m.exit);
      recorded.add(m.spanId);
      const i = pending.findIndex((p) => p.repoKey === m.repoKey && p.cmd === m.cmd);
      if (i >= 0) pending.splice(i, 1);
    }
  });
  return {
    notePending(repoKey, cmd) {
      pending.push({ repoKey, cmd });
    },
  };
}
