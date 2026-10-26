import { describe, expect, it } from 'vitest';
import { isControllerWorkStatus } from '../../src/shared/controllerStatus';
import { CONTROLLER_MAX_STATUS_BYTES, encodeControllerMessage, parseControllerMessage } from '../../src/shared/controllerProtocol';
import { workStatus } from '../helpers/controllerStatusFixture';
import type { ControllerTerminal } from '../../src/shared/ipc';
import { STATUSES } from '../helpers/designTokens';
import { STATUS_CASES, SUMMARY_LABELS, statusService, statusTerminal } from '../helpers/controllerStatusFixture';

const cases = Object.values(STATUS_CASES);

describe('the status-case table', () => {
  it('covers every status class and every summary label', () => {
    expect(new Set(cases.map(c => c.statusClass))).toEqual(new Set(STATUSES));
    expect(new Set(cases.map(c => c.summary))).toEqual(new Set(SUMMARY_LABELS));
  });

  it('gives each case its own id and a directory no other case\'s directory contains', () => {
    const ids = cases.map(c => c.terminal.id);
    expect(new Set(ids).size).toBe(ids.length);
    const directories = cases.map(c => c.terminal.launchDirectory);
    const overlapping = directories.filter((dir, i) => directories.some((other, j) => i !== j && other.includes(dir)));
    expect(overlapping).toEqual([]);
  });

  it('pins every status that outranks Working on an active terminal, so an activity-first classifier fails', () => {
    const activityBound = new Set(['Working', 'Idle', 'Loading', 'Status unavailable']);
    const unpinned = [...new Set(cases.map(c => c.text))]
      .filter(text => !activityBound.has(text))
      .filter(text => !cases.some(c => c.text === text && c.terminal.work?.activity === 'active'));
    expect(unpinned).toEqual([]);
  });

  it('builds only terminals the controller could receive', () => {
    const invalid = cases.filter(c => c.terminal.work !== undefined && !isControllerWorkStatus(c.terminal.work));
    expect(invalid.map(c => c.terminal.id)).toEqual([]);
    expect(STATUS_CASES.loading.terminal.work).toBeUndefined();
    expect(STATUS_CASES.disconnected.terminal.status).toBe('disconnected');
  });

  it('gives the oversized case the work the protocol sends for a status too large to carry', () => {
    const tooLarge = workStatus({ attention: { status: 'blocked', reasons: ['x'.repeat(CONTROLLER_MAX_STATUS_BYTES)] } });
    const received = parseControllerMessage(encodeControllerMessage({ version: 2, type: 'status', work: tooLarge }));
    expect(received.type === 'status' && received.work).toEqual(STATUS_CASES.oversized.terminal.work);
  });
});

describe('the shared controller fake', () => {
  it('records a dismissal and publishes the snapshot without that terminal', async () => {
    const gone: ControllerTerminal = { ...STATUS_CASES.disconnected.terminal };
    const service = statusService([gone, statusTerminal()]);
    const seen: string[][] = [];
    service.api.subscribeTerminals(items => seen.push(items.map(item => item.id)));
    await service.api.dismissTerminal(gone.id);
    expect(service.dismissed).toEqual([gone.id]);
    expect(seen.at(-1)).toEqual(['terminal-a']);
  });

  it('answers activation with the outcome it was given', async () => {
    expect(await statusService().api.activateTerminal('terminal-a')).toBe('activated');
    expect(await statusService([statusTerminal()], { activation: 'unavailable' }).api.activateTerminal('terminal-a')).toBe('unavailable');
    const failing = statusService([statusTerminal()], { activation: 'rejected' });
    await expect(failing.api.activateTerminal('terminal-a')).rejects.toThrow();
    expect(failing.activated).toEqual(['terminal-a']);
  });
});
