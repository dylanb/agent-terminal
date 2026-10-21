// #180 — the app side of the runner-to-app launch contract: from the launch value the runner set and the resolved
// launch root, the ports that hold the launched folder's flow inside its span and end the app when the span ends.

import { writeFileSync } from 'node:fs';
import type { AppLoopEntry } from './appLoopEngine';
import type { FlowSpanPort } from './flow';
import { errMsg } from './errno';
import { decodeBenchLaunch, serializeBenchSpanEnd, type BenchAppEnding } from '../shared/benchLaunch';

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

export function setupBenchLaunch(encoded: string | undefined, launchRoot: string, quit: () => void): BenchLaunchSetup {
  if (encoded === undefined) return { ok: true, ports: null };
  const read = decodeBenchLaunch(encoded);
  if (!read.ok) return { ok: false, error: 'launch-undecodable' };
  const { workingFolder, span, spanEndFile } = read.launch;
  if (workingFolder !== launchRoot) return { ok: false, error: 'launch-folder-mismatch' };

  let ended = false;
  const end = (ending: BenchAppEnding): void => {
    if (ended) return;
    ended = true;
    try {
      writeFileSync(spanEndFile, serializeBenchSpanEnd(ending));
    } catch (e) {
      console.error('the span-end file could not be written:', errMsg(e));
    }
    quit();
  };
  const launched = (repoKey: string): boolean => repoKey === workingFolder;
  return {
    ok: true,
    ports: {
      span: {
        spanFor: (repoKey) => (launched(repoKey) ? span : null),
        ended: (repoKey, ending) => {
          if (launched(repoKey)) end(ending);
        },
      },
      startEntryFor: (repoKey) => (launched(repoKey) ? 'chain-advance' : null),
      terminated: (repoKey) => {
        if (launched(repoKey)) end('terminated');
      },
      windowClosed: () => end('window closed'),
    },
  };
}
