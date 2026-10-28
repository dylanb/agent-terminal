// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControllerTerminal } from '../../src/shared/ipc';
import { bringForwardIn, cardHeaderIn, cardsIn, controlName, directoryPattern, headerLabels, showsName, unshownCounts, windowHeaderIn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { directoryConflictFixture, STATUS_CASES, statusService, workStatus } from '../helpers/controllerStatusFixture';

const { members, unrelated } = directoryConflictFixture();
const directory = members[0].launchDirectory;
const matching = (host: HTMLElement) => cardsIn(host).filter(card => directoryPattern(directory).test(controlName(card)));
const text = (host: HTMLElement) => matching(host).map(card => card.textContent).join('\n');
const header = (host: HTMLElement) => matching(host)[0] && cardHeaderIn(matching(host)[0], directory);
const action = (host: HTMLElement) => matching(host)[0] && bringForwardIn(matching(host)[0]);
afterEach(() => document.body.replaceChildren());

describe('directory conflict presentation', () => {
  it.each([2, 3])('represents %i connections once, separately from another worktree of the same repository', count => {
    const { host, dispose } = mountControllerPanes({ terminals: [...members.slice(0, count), unrelated] });
    try {
      expect.soft(matching(host)).toHaveLength(1);
      expect.soft(cardsIn(host)).toHaveLength(2);
      expect.soft(text(host)).toMatch(new RegExp(`\\b${count} (?:live )?(?:instances|terminals|connections)\\b`, 'i'));
      expect.soft(text(host)).toContain('Duplicate directory');
      expect.soft(text(host)).toMatch(/(?:close|reduce|keep|leave)[\s\S]*(?:one|1|extra|other)/i);
      expect.soft(showsName(matching(host)[0], directory, 'repository')).toBe(true);
      expect.soft(action(host)?.textContent).toBe(count === 2 ? 'Bring both forward' : 'Bring 3 terminals forward');
      expect.soft(controlName(action(host))).toContain(directory);
      expect.soft(controlName(action(host))).toContain('repository');
    } finally { dispose(); }
  });

  it.each([null, '/different/repo'])('uses the directory name when roots have no common identity (%s)', root => {
    const { host, dispose } = mountControllerPanes({ terminals: [members[0], { ...members[1], repositoryRoot: root }] });
    try {
      expect.soft(matching(host).map(card => showsName(card, directory, 'shared'))).toEqual([true]);
      expect.soft(matching(host).some(card => showsName(card, directory, 'repository'))).toBe(false);
    } finally { dispose(); }
  });

  it.each(['populated', 'loading', 'oversized', 'three'] as const)('suppresses all member information for %s status and restores the current survivor', state => {
    const second: ControllerTerminal = state === 'loading' ? { ...members[1], work: undefined }
      : state === 'oversized' ? { ...members[1], work: STATUS_CASES.oversized.terminal.work } : members[1];
    const { host, service, dispose } = mountControllerPanes({ terminals: [members[0], second, ...(state === 'three' ? [members[2]] : []), unrelated] });
    try {
      expect.soft(text(host)).not.toMatch(/Ticket amber|Ticket blue|Ticket coral|#271|#272|#273|flow-amber|flow-blue|flow-coral|step-amber|step-blue|step-coral|Approve|Error amber|Error blue|Error coral|Human needed|Loading|Status unavailable|too large|Active|Completed/i);
      const current = { ...members[1], work: workStatus({ ticket: { availability: 'known', number: 991, title: { availability: 'known', text: 'Current survivor' } }, error: { reason: 'Current error' }, attention: { status: 'review', reasons: ['Current request'] } }) };
      service.publish([current, unrelated]);
      expect.soft(text(host)).toContain('Current survivor');
      expect.soft(text(host)).toContain('Current error');
      expect.soft(text(host)).toContain('Current request');
      expect.soft(text(host)).not.toMatch(/Duplicate directory|Ticket amber|Approve amber/);
      expect.soft(action(host)?.textContent).toBe('Bring forward');
      service.publish([{ ...current, work: second.work }, unrelated]);
      expect.soft(text(host)).toContain({ populated: 'Ticket blue', three: 'Ticket blue', loading: 'Loading', oversized: 'Status unavailable' }[state]);
    } finally { dispose(); }
  });

  it('counts a conflict once as an error, never again as human attention', () => {
    const working = { ...unrelated, work: workStatus() };
    const { host, service, dispose } = mountControllerPanes({ terminals: [...members, working] });
    try {
      const labels = headerLabels(label => label === 'errors' || label === 'working' ? 1 : 0, 2, 2).map(([label, count]) => [label.startsWith('total|') ? 'cards?' : label, count] as const);
      expect.soft(unshownCounts(windowHeaderIn(host)?.textContent ?? '', labels)).toEqual([]);
      service.publish([]);
      expect.soft(unshownCounts(windowHeaderIn(host)?.textContent ?? '', labels.map(([label]) => [label, 0]))).toEqual([]);
      expect.soft(host.textContent).toMatch(/no terminals connected/i);
    } finally { dispose(); }
  });

  it.each([false, true])('keeps directory collapse choice across a different survivor and resets after zero (one column %s)', oneColumn => {
    const { host, service, dispose } = mountControllerPanes({ terminals: members.slice(0, 2), oneColumn });
    try {
      expect.soft(header(host)?.getAttribute('aria-expanded')).toBe('true');
      header(host)?.click();
      expect.soft(header(host)?.textContent).toContain('Duplicate directory');
      expect.soft(header(host)?.textContent).toMatch(/2 (?:live )?(?:instances|terminals|connections)/i);
      expect.soft(header(host)?.textContent).not.toMatch(/human|unavailable/i);
      service.publish([members[1]]);
      expect.soft(header(host)?.getAttribute('aria-expanded')).toBe('false');
      service.publish([members[1], members[2]]);
      expect.soft(header(host)?.getAttribute('aria-expanded')).toBe('false');
      service.publish([{ ...members[2], status: 'disconnected' }]);
      expect.soft(header(host)?.getAttribute('aria-expanded')).toBe('false');
      service.publish([{ ...members[0], id: 'replacement' }, members[1]]);
      expect.soft(header(host)?.getAttribute('aria-expanded')).toBe('true');
      expect.soft(service.activated).toEqual([]);
    } finally { dispose(); }
  });

  it('preserves a manual expansion when the quiet survivor would otherwise collapse', () => {
    const first = { ...members[0], work: workStatus({ activity: 'quiet' }) };
    const second = { ...members[1], work: workStatus({ activity: 'quiet' }) };
    const { host, service, dispose } = mountControllerPanes({ terminals: [first], oneColumn: true });
    try {
      expect.soft(header(host)?.getAttribute('aria-expanded')).toBe('false');
      header(host)?.click();
      service.publish([first, second]);
      expect.soft(header(host)?.getAttribute('aria-expanded')).toBe('true');
      service.publish([second]);
      expect.soft(header(host)?.getAttribute('aria-expanded')).toBe('true');
      expect.soft(text(host)).toContain('Idle');
    } finally { dispose(); }
  });

  it('announces conflict entry and clearance, suppressing member changes and departed reasons', () => {
    const { host, service, dispose } = mountControllerPanes({ terminals: [members[0]] });
    try {
      const region = host.querySelector('[role="status"]');
      service.publish(members.slice(0, 2));
      expect.soft(region?.textContent).toContain(directory);
      expect.soft(region?.textContent).toContain('Duplicate directory');
      expect.soft(region?.textContent).not.toMatch(/Approve|Error amber|Error blue/);
      const before = region?.textContent;
      const observer = new MutationObserver(() => {});
      observer.observe(region!, { childList: true, subtree: true, characterData: true });
      service.publish([members[0], { ...members[1], work: workStatus({ attention: { status: 'review', reasons: ['HIDDEN NEW REASON'] }, error: { reason: 'HIDDEN NEW ERROR' } }) }]);
      expect.soft(region?.textContent).toBe(before);
      expect.soft(observer.takeRecords()).toEqual([]);
      observer.disconnect();
      service.publish([members[1]]);
      expect.soft(region?.textContent).toContain(directory);
      expect.soft(region?.textContent).toMatch(/(?:duplicate|conflict).*clear/i);
      expect.soft(region?.textContent).toContain('Approve blue');
      expect.soft(region?.textContent).not.toMatch(/Approve amber|HIDDEN NEW/);
    } finally { dispose(); }
  });
});

describe('activation of captured directory connections', () => {
  it.each(['activated', 'unavailable', 'rejected'] as const)('attempts every original target after first result %s', outcome => {
    const service = statusService([...members, unrelated], { activation: async id => {
      if (id !== members[0].id) return 'activated';
      if (outcome === 'rejected') throw new Error('closed');
      return outcome;
    } });
    const { host, dispose } = mountControllerPanes({ controller: service.api });
    action(host)?.click();
    return vi.waitFor(() => expect([...service.activated].sort()).toEqual(members.map(member => member.id).sort())).finally(dispose);
  });

  it('keeps the original denominator across replacement and retries only current members', async () => {
    let finish!: (value: 'unavailable') => void;
    const held = new Promise<'unavailable'>(resolve => { finish = resolve; });
    const service = statusService([...members.slice(0, 2), unrelated], { activation: id => id === members[0].id ? held : Promise.resolve('activated') });
    const { host, dispose } = mountControllerPanes({ controller: service.api });
    try {
      action(host)?.click();
      service.publish([members[1], members[2], unrelated]);
      finish('unavailable');
      await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/Terminal unavailable/i));
      expect.soft(host.querySelector('[role="alert"]')?.textContent).toMatch(/1 (?:of|out of) 2/);
      expect.soft([...service.activated].sort()).toEqual(members.slice(0, 2).map(member => member.id).sort());
      service.activated.length = 0;
      action(host)?.click();
      await vi.waitFor(() => expect([...service.activated].sort()).toEqual(members.slice(1).map(member => member.id).sort()));
    } finally { dispose(); }
  });
  it('does not let an old action overwrite a newer action result', async () => {
    let completeOld!: (value: 'unavailable') => void;
    const old = new Promise<'unavailable'>(resolve => { completeOld = resolve; });
    const service = statusService([...members.slice(0, 2), unrelated], { activation: id => id === unrelated.id ? Promise.resolve('activated') : old });
    const { host, dispose } = mountControllerPanes({ controller: service.api });
    try {
      action(host)?.click();
      const other = cardsIn(host).find(card => !matching(host).includes(card));
      (other && bringForwardIn(other))?.click();
      await Promise.resolve();
      await Promise.resolve();
      completeOld('unavailable');
      await old;
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(host.querySelector('[role="alert"]')?.textContent ?? '').not.toMatch(/unavailable/i);
    } finally { dispose(); }
  });

  it('keeps confirmed success after departure and reports only the unconfirmed captured attempt', async () => {
    let complete!: (value: 'unavailable') => void;
    const pending = new Promise<'unavailable'>(resolve => { complete = resolve; });
    const service = statusService(members.slice(0, 2), { activation: id => id === members[1].id ? pending : Promise.resolve('activated') });
    const { host, dispose } = mountControllerPanes({ controller: service.api });
    try {
      action(host)?.click();
      await Promise.resolve();
      service.publish([members[1]]);
      complete('unavailable');
      await pending;
      await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/1 (?:of|out of) 2/));
      expect.soft(matching(host)).toHaveLength(1);
      expect.soft(text(host)).not.toContain('Disconnected');
    } finally { dispose(); }
  });

  it('reports two failed attempts among three, then clears feedback after a successful retry', async () => {
    let retry = false;
    const service = statusService(members, { activation: async id => retry || id === members[1].id ? 'activated' : 'unavailable' });
    const { host, dispose } = mountControllerPanes({ controller: service.api });
    try {
      action(host)?.click();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect.soft(host.querySelector('[role="alert"]')?.textContent).toMatch(/2 (?:of|out of) 3/);
      const feedback = host.querySelector<HTMLElement>('[role="alert"]');
      const announcedFeedback = `${feedback?.textContent ?? ''} ${controlName(feedback)}`;
      expect.soft(announcedFeedback).not.toMatch(/connection-(?:amber|blue|coral)|(?:terminal|instance)\s*[123]|Ticket (?:amber|blue|coral)/i);
      retry = true;
      action(host)?.click();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect.soft(host.querySelector('[role="alert"]')?.textContent ?? '').not.toMatch(/unavailable/i);
      expect.soft(service.activated.filter(id => id === members[0].id)).toHaveLength(2);
      expect.soft(service.activated.filter(id => id === members[1].id)).toHaveLength(2);
      expect.soft(service.activated.filter(id => id === members[2].id)).toHaveLength(2);
    } finally { dispose(); }
  });

});

it('announces that the directory conflict cleared when its last connections depart', () => {
  const { host, service, dispose } = mountControllerPanes({ terminals: members.slice(0, 2) });
  try {
    service.publish([{ ...members[1], status: 'disconnected' }]);
    const announcement = host.querySelector('[role="status"]')?.textContent;
    expect(announcement).toContain(directory);
    expect(announcement).toMatch(/(?:duplicate|conflict).*clear/i);
    expect(announcement).not.toMatch(/Approve|Error blue/);
  } finally { dispose(); }
});
