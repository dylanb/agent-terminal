import type { ActiveFlowWriteResult } from '../../shared/ipc';
import { REPO_SETUP_FLOW_ID } from '../../shared/setupCheck';

export type SetupFlowRun = { ok: true } | { ok: false; reason: string };

export interface SetupFlowRunDeps {
  setActiveFlow(repoKey: string, id: string): Promise<ActiveFlowWriteResult>;
  /** Starts `repoKey`'s selected flow; settles once that has finished. */
  start(repoKey: string): Promise<void>;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Selects the repo-setup flow for a repository and starts it. Settles once the start has, with the reason when
 *  the flow could not be selected or started. */
export function createSetupFlowRun(deps: SetupFlowRunDeps): (repoKey: string) => Promise<SetupFlowRun> {
  return async (repoKey) => {
    let selected: ActiveFlowWriteResult;
    try {
      selected = await deps.setActiveFlow(repoKey, REPO_SETUP_FLOW_ID);
    } catch (e: unknown) {
      return { ok: false, reason: `The setup flow could not be selected: ${message(e)}` };
    }
    if (!selected.ok) return { ok: false, reason: selected.reason };
    try {
      await deps.start(repoKey);
    } catch (e: unknown) {
      return { ok: false, reason: `The setup flow could not be started: ${message(e)}` };
    }
    return { ok: true };
  };
}
