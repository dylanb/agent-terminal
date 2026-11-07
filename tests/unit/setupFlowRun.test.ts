import { describe, expect, it } from 'vitest';
import type { ActiveFlowWriteResult } from '../../src/shared/ipc';
import { REPO_SETUP_FLOW_ID } from '../../src/shared/setupCheck';
import { createSetupFlowRun } from '../../src/renderer/src/setupFlowRun';

const REPO = '/work/kestrel-basin';
const PREVIOUS_FLOW = 'flow-selected-before';

/** The two flow requests: a selection is written unless `selection` refuses or rejects it, and a start runs the
 *  flow its repository has selected, `PREVIOUS_FLOW` when nothing was, once `releaseStart` runs. */
function flowRequests(selection: ActiveFlowWriteResult | { reject: string } = { ok: true }) {
  const selected = new Map<string, string>();
  const started = new Map<string, string>();
  let releaseStart: () => void = () => {};
  const startHeld = new Promise<void>((resolve) => (releaseStart = resolve));
  return {
    deps: {
      setActiveFlow: async (repoKey: string, id: string): Promise<ActiveFlowWriteResult> => {
        if ('reject' in selection) throw new Error(selection.reject);
        if (selection.ok) selected.set(repoKey, id);
        return selection;
      },
      start: async (repoKey: string): Promise<void> => {
        await startHeld;
        started.set(repoKey, selected.get(repoKey) ?? PREVIOUS_FLOW);
      },
    },
    releaseStart: () => releaseStart(),
    started: (): Record<string, string> => Object.fromEntries(started),
  };
}

describe('running the setup flow for a repository', () => {
  it('starts the repo-setup flow in that repository, and answers ok only once the start has settled', async () => {
    const requests = flowRequests();
    let settled = false;
    const run = createSetupFlowRun(requests.deps)(REPO).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const settledBeforeStart = settled;
    requests.releaseStart();

    expect({ settledBeforeStart, result: await run, started: requests.started() }).toEqual({
      settledBeforeStart: false,
      result: { ok: true },
      started: { [REPO]: REPO_SETUP_FLOW_ID },
    });
  });

  it("answers the selection's refusal with its reason, and starts nothing", async () => {
    const requests = flowRequests({ ok: false, reason: 'scripted begun-run refusal' });
    requests.releaseStart();

    const result = await createSetupFlowRun(requests.deps)(REPO);

    expect({ result, started: requests.started() }).toEqual({
      result: { ok: false, reason: 'scripted begun-run refusal' },
      started: {},
    });
  });

  it('answers a rejected selection as not ok, naming the rejection, and starts nothing', async () => {
    const requests = flowRequests({ reject: 'scripted selection rejection' });
    requests.releaseStart();

    const result = await createSetupFlowRun(requests.deps)(REPO);

    expect({
      ok: result.ok,
      namesRejection: !result.ok && result.reason.includes('scripted selection rejection'),
      started: requests.started(),
    }).toEqual({ ok: false, namesRejection: true, started: {} });
  });

  it('answers a rejected start as not ok, naming the rejection', async () => {
    const requests = flowRequests();
    const run = createSetupFlowRun({
      ...requests.deps,
      start: async () => {
        throw new Error('scripted start rejection');
      },
    });

    const result = await run(REPO).catch((e: unknown) => ({ rejected: e instanceof Error ? e.message : String(e) }));

    expect({
      ok: 'ok' in result ? result.ok : 'rejected',
      namesRejection: 'ok' in result && !result.ok && result.reason.includes('scripted start rejection'),
    }).toEqual({ ok: false, namesRejection: true });
  });
});
