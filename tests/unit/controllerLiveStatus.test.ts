// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { createControllerPanes } from '../../src/renderer/src/controllerPanes';
import { statusService, statusTerminal, type WorkStatus } from '../helpers/controllerStatusFixture';

afterEach(() => document.body.replaceChildren());

function mount(work: Partial<WorkStatus> = {}, tag = 'main') {
  const host = document.createElement(tag);
  document.body.append(host);
  const service = statusService([statusTerminal(work)]);
  const component = createControllerPanes(host, { controller: service.api });
  return { host, service, component };
}

describe.each(['main', 'aside'])('live status in %s', tag => {
  it('identifies current work without replacing its fixed identity', () => {
    const { host, component } = mount({}, tag);
    try {
      expect.soft(host.textContent).toContain('/fixed/worktree');
      expect.soft(host.textContent).toContain('/fixed/repository');
      expect.soft(host.textContent).toContain('feature-dev');
      expect.soft(host.textContent).toContain('implement');
      expect.soft(host.textContent).toContain('#219');
      expect.soft(host.textContent).toContain('Show live controller status');
    } finally { component.dispose(); }
  });

  it.each([
    ['unassigned', /unassigned/i], ['assigned', /assigned/i], ['completed', /completed/i], ['unavailable', /unavailable/i],
  ] as const)('shows %s independently of activity and missing ticket', (assignment, label) => {
    const { host, component } = mount({ flow: { availability: 'known', name: 'delivery', step: 'work', assignment }, ticket: { availability: 'none' } }, tag);
    try {
      expect.soft(host.textContent).toMatch(label);
      expect.soft(host.textContent).toMatch(/active/i);
      expect.soft(host.textContent).toMatch(/no ticket/i);
      if (assignment !== 'unassigned') expect.soft(host.textContent).not.toMatch(/unassigned/i);
    } finally { component.dispose(); }
  });

  it.each(['loading', 'unavailable'] as const)('does not infer unassigned or no ticket from %s information', availability => {
    const { host, component } = mount({ flow: { availability }, ticket: { availability }, activity: 'quiet' }, tag);
    try {
      expect.soft(host.textContent).toMatch(new RegExp(availability, 'i'));
      expect.soft(host.textContent).toMatch(/idle|quiet/i);
      expect.soft(host.textContent).not.toMatch(/unassigned|no ticket|needs? (?:a )?human/i);
    } finally { component.dispose(); }
  });

  it.each(['loading', 'unavailable'] as const)('keeps the known issue number when its title is %s', availability => {
    const { host, component } = mount({ ticket: { availability: 'known', number: 219, title: { availability } } }, tag);
    try {
      expect.soft(host.textContent).toContain('#219');
      expect.soft(host.textContent).toMatch(new RegExp(`title.*${availability}|${availability}.*title`, 'i'));
      expect.soft(host.textContent).toContain('implement');
    } finally { component.dispose(); }
  });

  it('retains attention and error alongside completed work and quiet activity', () => {
    const { host, component } = mount({
      flow: { availability: 'known', name: 'delivery', step: 'review', assignment: 'completed' }, activity: 'quiet',
      attention: { status: 'awaiting-human', reasons: ['Review the failing checks', 'Automatic approval halted'] },
      error: { reason: 'The work turn failed' },
    }, tag);
    try {
      expect.soft(host.textContent).toMatch(/completed/i);
      expect.soft(host.textContent).toMatch(/idle|quiet/i);
      expect.soft(host.textContent).toMatch(/needs? (?:a )?human|human.*needed/i);
      expect.soft(host.textContent).toContain('awaiting-human');
      expect.soft(host.textContent).toContain('Review the failing checks');
      expect.soft(host.textContent).toContain('Automatic approval halted');
      expect.soft(host.textContent).toMatch(/error/i);
      expect.soft(host.textContent).toContain('The work turn failed');
    } finally { component.dispose(); }
  });

  it('keeps malformed flow errors visible without asserting assignment', () => {
    const { host, component } = mount({ flow: { availability: 'unavailable' }, error: { reason: 'Malformed flow definition' } }, tag);
    try {
      expect.soft(host.textContent).toContain('Malformed flow definition');
      expect.soft(host.textContent).toMatch(/error/i);
      expect.soft(host.textContent).not.toMatch(/unassigned/i);
    } finally { component.dispose(); }
  });

  it('activation leaves the current human request visible and targets only its terminal', async () => {
    const attention = { status: 'complete', reasons: ['Choose approve or request changes'] };
    const { host, service, component } = mount({ attention }, tag);
    try {
      host.querySelector('button')!.click();
      await Promise.resolve();
      expect.soft(service.activated).toEqual(['terminal-a']);
      expect.soft(host.textContent).toMatch(/needs? (?:a )?human|human.*needed/i);
      expect.soft(host.textContent).toContain(attention.reasons[0]);
    } finally { component.dispose(); }
  });

  it('replaces work and clears obsolete reasons without hiding the new state', () => {
    const { host, service, component } = mount({ attention: { status: 'error', reasons: ['Old halt'] }, error: { reason: 'Old error' } }, tag);
    try {
      service.publish([statusTerminal({
        flow: { availability: 'known', name: 'new-flow', step: 'verify', assignment: 'assigned' },
        ticket: { availability: 'known', number: 220, title: { availability: 'known', text: 'New issue' } },
        attention: null, error: null, activity: 'quiet',
      })]);
      expect.soft(host.textContent).toContain('new-flow');
      expect.soft(host.textContent).toContain('verify');
      expect.soft(host.textContent).toContain('#220');
      expect.soft(host.textContent).toContain('New issue');
      expect.soft(host.textContent).toMatch(/idle|quiet/i);
      expect.soft(host.textContent).not.toMatch(/Old halt|Old error|#219|feature-dev|implement|human/i);
    } finally { component.dispose(); }
  });

  it('shows a replacement human reason rather than the previous gate reason', () => {
    const { host, service, component } = mount({ attention: { status: 'complete', reasons: ['Old reason'] } }, tag);
    try {
      service.publish([statusTerminal({ attention: { status: 'error', reasons: ['New reason'] } })]);
      expect.soft(host.textContent).toContain('New reason');
      expect.soft(host.textContent).toContain('error');
      expect.soft(host.textContent).not.toContain('Old reason');
    } finally { component.dispose(); }
  });

  it('renders title and reasons as text without interpreting markup', () => {
    const title = '<img src=x onerror=alert(1)>';
    const { host, component } = mount({ ticket: { availability: 'known', number: 219, title: { availability: 'known', text: title } }, attention: { status: 'complete', reasons: ['<script>wrong()</script>'] } }, tag);
    try {
      expect.soft(host.textContent).toContain(title);
      expect.soft(host.textContent).toContain('<script>wrong()</script>');
      expect.soft(host.querySelector('img, script')).toBeNull();
    } finally { component.dispose(); }
  });

  it('preserves equivalent focus and external focus on status updates, then unsubscribes', () => {
    const { host, service, component } = mount({}, tag);
    const outside = document.createElement('button');
    document.body.append(outside);
    host.querySelector('button')!.focus();
    service.publish([statusTerminal({ activity: 'quiet' })]);
    expect.soft(document.activeElement).toBe(host.querySelector('button'));
    expect.soft(host.textContent).toMatch(/idle|quiet/i);
    outside.focus();
    service.publish([statusTerminal({ activity: 'active' })]);
    expect.soft(document.activeElement).toBe(outside);
    expect.soft(host.textContent).toMatch(/active/i);
    component.dispose();
    service.publish([statusTerminal()]);
    expect(host.childElementCount).toBe(0);
  });
});

it('initial registration without a current snapshot shows loading rather than absence', () => {
  const host = document.createElement('main');
  const service = statusService([]);
  const component = createControllerPanes(host, { controller: {
    ...service.api,
    subscribeTerminals(listener) {
      listener([{ id: 'new-terminal', launchDirectory: '/new', repositoryRoot: null }]);
      return () => {};
    },
  } });
  try {
    expect.soft(host.textContent).toMatch(/loading|unavailable/i);
    expect.soft(host.textContent).not.toMatch(/unassigned|no ticket/i);
  } finally { component.dispose(); }
});
