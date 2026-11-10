import { expect, it } from 'vitest';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusTerminal } from '../helpers/controllerStatusFixture';
import { notificationItem, statusItem } from '../helpers/controllerHistory';

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
    const received = { ...terminal, timeline: [notificationItem('Review release proposal', 1000)] };
    service.publish([received]);
    expect.soft(live.textContent).toContain(terminal.launchDirectory);
    expect.soft(live.textContent).toContain('Review release proposal');
    expect.soft(document.activeElement).toBe(outside);
    observer.observe(live, { childList: true, subtree: true, characterData: true });
    service.publish([structuredClone(received)]);
    expect.soft(observer.takeRecords(), 'unchanged received history is not announced again').toEqual([]);
    const repeated = { ...received, timeline: [notificationItem('Review release proposal', 2000)] };
    service.publish([repeated]);
    expect.soft(observer.takeRecords(), 'a new receipt can announce the same text').not.toEqual([]);
    const next = { ...repeated, timeline: [notificationItem('Review the second proposal', 2000)] };
    service.publish([next]);
    expect.soft(live.textContent).toContain('Review the second proposal');
    observer.takeRecords();
    const peer = { ...terminal, id: 'overlapping-terminal' };
    service.publish([next, peer]);
    expect.soft(live.textContent).not.toContain('Review the second proposal');
    observer.takeRecords();
    service.publish([{ ...next, timeline: [notificationItem('Hidden during overlap', 3000)] }, peer]);
    expect.soft(observer.takeRecords(), 'conflicting member notifications stay silent').toEqual([]);
    service.publish([next]);
    expect.soft(live.textContent, 'unchanged history after conflict is not a fresh receipt').not.toContain('Review the second proposal');
    expect.soft(document.activeElement).toBe(outside);
    expect(service.activated).toEqual([]);
  } finally { observer.disconnect(); dispose(); outside.remove(); parent.remove(); }
});

it('announces nothing when a status entry is inserted above an already announced notification', () => {
  const terminal = statusTerminal();
  const { host, service, dispose } = mountControllerPanes({ terminals: [terminal] });
  const live = host.querySelector('[role="status"]')!;
  const observer = new MutationObserver(() => {});
  try {
    const announced = notificationItem('Review release proposal', 1000);
    service.publish([{ ...terminal, timeline: [announced] }]);
    expect.soft(live.textContent).toContain('Review release proposal');
    observer.observe(live, { childList: true, subtree: true, characterData: true });
    service.publish([{ ...terminal, timeline: [statusItem('Went quiet', 2000), announced] }]);
    expect.soft(observer.takeRecords(), 'a status entry above it is not an arrival').toEqual([]);
    expect.soft(live.textContent).not.toContain('Went quiet');
  } finally { observer.disconnect(); dispose(); }
});

it('never announces a status entry, and announces a new notification that sits below a newer status entry', () => {
  const terminal = statusTerminal();
  const { host, service, dispose } = mountControllerPanes({ terminals: [terminal] });
  const live = host.querySelector('[role="status"]')!;
  try {
    service.publish([{ ...terminal, timeline: [statusItem('Went quiet and said so loudly', 1000)] }]);
    expect.soft(live.textContent).not.toContain('Went quiet and said so loudly');
    service.publish([{ ...terminal, timeline: [statusItem('Went quiet and said so loudly', 1000), notificationItem('Review the late proposal', 900)] }]);
    expect.soft(live.textContent).toContain('Review the late proposal');
    expect.soft(live.textContent).not.toContain('Went quiet and said so loudly');
  } finally { dispose(); }
});
