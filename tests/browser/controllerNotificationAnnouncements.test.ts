import { expect, it } from 'vitest';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusTerminal } from '../helpers/controllerStatusFixture';

it.each(['body', 'nested'] as const)('announces received arrivals with unchanged live status in %s placement', placement => {
  const parent = document.createElement('section');
  if (placement === 'nested') document.body.append(parent);
  const terminal = statusTerminal({ attention: { status: 'complete', reasons: ['Review pending'] } });
  const outside = document.createElement('button');
  document.body.append(outside);
  const { host, service, dispose } = mountControllerPanes({ parent: placement === 'nested' ? parent : document.body, terminals: [terminal] });
  const live = host.querySelector('[role="status"]')!;
  const observer = new MutationObserver(() => {});
  try {
    outside.focus();
    const received = { ...terminal, latestNotification: { message: 'Review release proposal', receivedAt: 1000 } };
    service.publish([received]);
    expect.soft(live.textContent).toContain(terminal.launchDirectory);
    expect.soft(live.textContent).toContain('Review release proposal');
    expect.soft(document.activeElement).toBe(outside);
    observer.observe(live, { childList: true, subtree: true, characterData: true });
    service.publish([structuredClone(received)]);
    expect.soft(observer.takeRecords(), 'unchanged received history is not announced again').toEqual([]);
    const repeated = { ...received, latestNotification: { ...received.latestNotification, receivedAt: 2000 } };
    service.publish([repeated]);
    expect.soft(observer.takeRecords(), 'a new receipt can announce the same text').not.toEqual([]);
    const next = { ...repeated, latestNotification: { message: 'Review the second proposal', receivedAt: 2000 } };
    service.publish([next]);
    expect.soft(live.textContent).toContain('Review the second proposal');
    observer.takeRecords();
    const peer = { ...terminal, id: 'overlapping-terminal' };
    service.publish([next, peer]);
    expect.soft(live.textContent).not.toContain('Review the second proposal');
    observer.takeRecords();
    service.publish([{ ...next, latestNotification: { message: 'Hidden during overlap', receivedAt: 3000 } }, peer]);
    expect.soft(observer.takeRecords(), 'conflicting member notifications stay silent').toEqual([]);
    service.publish([next]);
    expect.soft(live.textContent, 'unchanged history after conflict is not a fresh receipt').not.toContain('Review the second proposal');
    expect.soft(document.activeElement).toBe(outside);
    expect(service.activated).toEqual([]);
  } finally { observer.disconnect(); dispose(); outside.remove(); parent.remove(); }
});
