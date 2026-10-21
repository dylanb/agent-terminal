// #180 — the app side of the runner-to-app launch contract: from the launch value the runner set and the resolved
// launch root, the ports that hold the launched folder's flow inside its span and end the app when the span ends.

import type { AppLoopEntry } from './appLoopEngine';
import type { FlowSpanPort } from './flow';

/** Why a present launch value cannot be honoured: it does not decode, or it names another folder than the app opened. */
export type BenchLaunchError = 'launch-undecodable' | 'launch-folder-mismatch';

export interface BenchSpanPorts {
  span: FlowSpanPort;
  /** The loop entry a Start maps to for `repoKey`: `chain-advance` for the launched folder, null for any other. */
  startEntryFor(repoKey: string): AppLoopEntry | null;
  terminated(repoKey: string): void;
  /** The operator closed the window. */
  windowClosed(): void;
}

export type BenchLaunchSetup = { ok: true; ports: BenchSpanPorts | null } | { ok: false; error: BenchLaunchError };

export function setupBenchLaunch(encoded: string | undefined, _launchRoot: string, _quit: () => void): BenchLaunchSetup {
  if (encoded === undefined) return { ok: true, ports: null };
  return {
    ok: true,
    ports: {
      span: { spanFor: () => null, ended: () => undefined },
      startEntryFor: () => null,
      terminated: () => undefined,
      windowClosed: () => undefined,
    },
  };
}
