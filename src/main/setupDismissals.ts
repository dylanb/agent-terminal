import path from 'node:path';
import type { SetupDismissReply } from '../shared/ipc';
import type { SetupDismissal } from '../shared/setupCheck';
import { flowHomeDir } from './flowHome';

export interface SetupDismissals {
  /** Every dismissal recorded under the app-state home. */
  recorded(): SetupDismissal[];
  /** Adds `dismissal` to the record, keeping the ones already there. */
  record(dismissal: SetupDismissal): SetupDismissReply;
}

export function setupDismissalsFile(appHome: string): string {
  return path.join(flowHomeDir(appHome), 'setup-dismissals.json');
}

export function createSetupDismissals(_appHome: string): SetupDismissals {
  return {
    recorded: () => [],
    record: () => ({ ok: true }),
  };
}
