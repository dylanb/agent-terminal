// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { bringForwardIn, cardIn, statusRowIn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusService, statusTerminal, type WorkStatus } from '../helpers/controllerStatusFixture';

afterEach(() => document.body.replaceChildren());

const DIRECTORY = statusTerminal().launchDirectory;

function mount(work: Partial<WorkStatus> = {}, tag = 'main') {
  const parent = document.createElement(tag);
  document.body.append(parent);
  const { host, service, dispose } = mountControllerPanes({ terminals: [statusTerminal(work)], parent });
  const card = () => cardIn(host, DIRECTORY);
  return { host, service, component: { dispose }, card, text: () => card()?.textContent ?? '', status: () => { const c = card(); return c ? statusRowIn(c)?.textContent?.trim() : undefined; } };
}

describe.each(['main', 'aside'])('live status in %s', tag => {
  it('identifies current work without replacing its fixed identity', () => {
    const { text, component } = mount({}, tag);
    try {
      expect.soft(text()).toContain('/fixed/worktree');
      expect.soft(text()).toContain('repository');
      expect.soft(text()).toContain('feature-dev');
      expect.soft(text()).toContain('implement');
      expect.soft(text()).toContain('#219');
      expect.soft(text()).toContain('Show live controller status');
    } finally { component.dispose(); }
  });

  it.each([
    ['unassigned', 'Unassigned', /no flow run started/i], ['assigned', 'Working', /no ticket/i],
    ['completed', 'Completed', /no ticket/i], ['unavailable', 'Status unknown', /no ticket/i],
  ] as const)('shows %s independently of activity and missing ticket', (assignment, statusText, ticketLine) => {
    const { text, status, component } = mount({ flow: { availability: 'known', name: 'delivery', step: 'work', assignment }, ticket: { availability: 'none' } }, tag);
    try {
      expect.soft(status()).toBe(statusText);
      expect.soft(text()).toMatch(/\bactive\b/i);
      expect.soft(text()).toMatch(ticketLine);
      if (assignment !== 'unassigned') expect.soft(text()).not.toMatch(/unassigned/i);
    } finally { component.dispose(); }
  });

  it.each(['loading', 'unavailable'] as const)('does not infer unassigned or no ticket from %s information', availability => {
    const { text, status, component } = mount({ flow: { availability }, ticket: { availability }, activity: 'quiet' }, tag);
    try {
      expect.soft(status()).toBe('Status unknown');
      expect.soft(text()).toMatch(new RegExp(`flow ${availability}`, 'i'));
      expect.soft(text()).toMatch(new RegExp(`ticket ${availability}`, 'i'));
      expect.soft(text()).toMatch(/\bidle\b/i);
      expect.soft(text()).not.toMatch(/unassigned|no ticket|needs? (?:a )?human/i);
    } finally { component.dispose(); }
  });

  it.each(['loading', 'unavailable'] as const)('keeps the known issue number when its title is %s', availability => {
    const { text, component } = mount({ ticket: { availability: 'known', number: 219, title: { availability } } }, tag);
    try {
      expect.soft(text()).toContain('#219');
      expect.soft(text()).toMatch(new RegExp(`title ${availability}`, 'i'));
      expect.soft(text()).toContain('implement');
    } finally { component.dispose(); }
  });

  it('retains attention and error alongside completed work and quiet activity', () => {
    const { text, status, component } = mount({
      flow: { availability: 'known', name: 'delivery', step: 'review', assignment: 'completed' }, activity: 'quiet',
      attention: { status: 'awaiting-human', reasons: ['Review the failing checks', 'Automatic approval halted'] },
      error: { reason: 'The work turn failed' },
    }, tag);
    try {
      expect.soft(status()).toBe('Flow error');
      expect.soft(text()).toMatch(/\bidle\b/i);
      expect.soft(text()).toContain('Human needed: awaiting-human');
      expect.soft(text()).toContain('Review the failing checks');
      expect.soft(text()).toContain('Automatic approval halted');
      expect.soft(text()).toContain('The work turn failed');
    } finally { component.dispose(); }
  });

  it('keeps malformed flow errors visible without asserting assignment', () => {
    const { text, status, component } = mount({ flow: { availability: 'unavailable' }, error: { reason: 'Malformed flow definition' } }, tag);
    try {
      expect.soft(status()).toBe('Flow error');
      expect.soft(text()).toContain('Malformed flow definition');
      expect.soft(text()).not.toMatch(/unassigned/i);
    } finally { component.dispose(); }
  });

  it('bringing forward leaves the current human request visible and targets only its terminal', async () => {
    const attention = { status: 'complete', reasons: ['Choose approve or request changes'] };
    const { card, text, service, component } = mount({ attention }, tag);
    try {
      const current = card();
      (current && bringForwardIn(current))?.click();
      await Promise.resolve();
      expect.soft(service.activated).toEqual(['terminal-a']);
      expect.soft(text()).toContain('Human needed: complete');
      expect.soft(text()).toContain(attention.reasons[0]);
    } finally { component.dispose(); }
  });

  it('replaces work and clears obsolete reasons without hiding the new state', () => {
    const { text, status, service, component } = mount({ attention: { status: 'error', reasons: ['Old halt'] }, error: { reason: 'Old error' } }, tag);
    try {
      service.publish([statusTerminal({
        flow: { availability: 'known', name: 'new-flow', step: 'verify', assignment: 'assigned' },
        ticket: { availability: 'known', number: 220, title: { availability: 'known', text: 'New issue' } },
        attention: null, error: null, activity: 'quiet',
      })]);
      expect.soft(status()).toBe('Idle');
      expect.soft(text()).toContain('new-flow');
      expect.soft(text()).toContain('verify');
      expect.soft(text()).toContain('#220');
      expect.soft(text()).toContain('New issue');
      expect.soft(text()).not.toMatch(/Old halt|Old error|#219|feature-dev|implement|human/i);
    } finally { component.dispose(); }
  });

  it('shows a replacement human reason rather than the previous gate reason', () => {
    const { text, service, component } = mount({ attention: { status: 'complete', reasons: ['Old reason'] } }, tag);
    try {
      service.publish([statusTerminal({ attention: { status: 'error', reasons: ['New reason'] } })]);
      expect.soft(text()).toContain('New reason');
      expect.soft(text()).toContain('Human needed: error');
      expect.soft(text()).not.toContain('Old reason');
    } finally { component.dispose(); }
  });

  it('renders title and reasons as text without interpreting markup', () => {
    const title = '<img src=x onerror=alert(1)>';
    const { host, text, component } = mount({ ticket: { availability: 'known', number: 219, title: { availability: 'known', text: title } }, attention: { status: 'complete', reasons: ['<script>wrong()</script>'] } }, tag);
    try {
      expect.soft(text()).toContain(title);
      expect.soft(text()).toContain('<script>wrong()</script>');
      expect.soft(host.querySelector('img, script')).toBeNull();
    } finally { component.dispose(); }
  });

  it('preserves equivalent focus and external focus on status updates, then unsubscribes', () => {
    const { host, card, status, service, component } = mount({}, tag);
    const bringForward = () => { const current = card(); return current ? bringForwardIn(current) : undefined; };
    const outside = document.createElement('button');
    document.body.append(outside);
    bringForward()?.focus();
    service.publish([statusTerminal({ activity: 'quiet' })]);
    expect.soft(document.activeElement).toBe(bringForward());
    expect.soft(status()).toBe('Idle');
    outside.focus();
    service.publish([statusTerminal({ activity: 'active' })]);
    expect.soft(document.activeElement).toBe(outside);
    expect.soft(status()).toBe('Working');
    component.dispose();
    service.publish([statusTerminal()]);
    expect(host.childElementCount).toBe(0);
  });
});

it('initial registration without a current snapshot shows loading rather than absence', () => {
  const service = statusService([]);
  const { host, dispose } = mountControllerPanes({ controller: {
    ...service.api,
    subscribeTerminals(listener) {
      listener([{ id: 'new-terminal', launchDirectory: '/new', repositoryRoot: null }]);
      return () => {};
    },
  } });
  try {
    const card = cardIn(host, '/new');
    expect.soft(card ? statusRowIn(card)?.textContent?.trim() : undefined).toBe('Loading');
    expect.soft(card?.textContent ?? '').not.toMatch(/unassigned|no ticket/i);
  } finally { dispose(); }
});
