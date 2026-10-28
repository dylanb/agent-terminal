// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Theme } from '../../src/shared/ipc';
import { alwaysOnTopIn, alwaysOnTopOn, themeControlIn, windowHeaderIn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusService } from '../helpers/controllerStatusFixture';

afterEach(() => document.body.replaceChildren());

const switchState = (host: HTMLElement) => (alwaysOnTopIn(host) ? (alwaysOnTopOn(host) ? 'on' : 'off') : 'missing');

/** Waits for the Always on top switch to appear; a switch that never appears is left for the caller's check. */
const shown = (host: HTMLElement) => vi.waitFor(() => {
  if (!alwaysOnTopIn(host)) throw new Error('no Always on top switch yet');
}).catch(() => undefined);

/** Lets every reply already in flight reach the organism before the test reads the screen. */
const settled = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the header Always on top switch', () => {
  it.each([[true, 'on'], [false, 'off']] as const)('shows main\'s always-on-top value %s as %s', async (alwaysOnTop, state) => {
    const { host, dispose } = mountControllerPanes({ alwaysOnTop });
    try {
      await shown(host);
      expect(switchState(host)).toBe(state);
    } finally { dispose(); }
  });

  it('shows always-on-top on when main\'s value cannot be read', async () => {
    const { host, dispose } = mountControllerPanes({ alwaysOnTop: 'unreadable' });
    try {
      await shown(host);
      expect(switchState(host)).toBe('on');
    } finally { dispose(); }
  });

  it('asks main for the other value on each use and shows the value main replies', async () => {
    const { host, service, dispose } = mountControllerPanes({ alwaysOnTop: true });
    try {
      await shown(host);
      alwaysOnTopIn(host)?.click();
      await settled();
      const first = { requested: [...service.requestedAlwaysOnTop], state: switchState(host) };
      alwaysOnTopIn(host)?.click();
      await settled();
      expect({ first, second: { requested: service.requestedAlwaysOnTop, state: switchState(host) } }).toEqual({
        first: { requested: [false], state: 'off' },
        second: { requested: [false, true], state: 'on' },
      });
    } finally { dispose(); }
  });

  it.each(['refused', 'rejected'] as const)('keeps showing main\'s value when main has %s the request', async alwaysOnTopReply => {
    const { host, service, dispose } = mountControllerPanes({ alwaysOnTop: false, alwaysOnTopReply });
    try {
      await shown(host);
      alwaysOnTopIn(host)?.click();
      await settled();
      expect({ requested: service.requestedAlwaysOnTop, state: switchState(host) }).toEqual({ requested: [true], state: 'off' });
    } finally { dispose(); }
  });

  it.each(['always-on-top', 'theme'] as const)('sits before the theme control in the header when the %s reply arrives first', async first => {
    const service = statusService();
    let replyAlwaysOnTop!: (on: boolean) => void;
    let replyTheme!: (theme: Theme) => void;
    const alwaysOnTop = new Promise<boolean>(done => { replyAlwaysOnTop = done; });
    const theme = new Promise<Theme>(done => { replyTheme = done; });
    const { host, dispose } = mountControllerPanes({ controller: { ...service.api, getAlwaysOnTop: () => alwaysOnTop, getTheme: () => theme } });
    try {
      if (first === 'always-on-top') { replyAlwaysOnTop(false); await settled(); replyTheme('dark'); }
      else { replyTheme('dark'); await settled(); replyAlwaysOnTop(false); }
      await settled();
      const header = windowHeaderIn(host);
      const control = header && alwaysOnTopIn(header);
      const themeControl = header && themeControlIn(header);
      expect({
        switch: Boolean(control),
        theme: Boolean(themeControl),
        switchFirst: Boolean(control && themeControl && control.compareDocumentPosition(themeControl) & Node.DOCUMENT_POSITION_FOLLOWING),
      }).toEqual({ switch: true, theme: true, switchFirst: true });
    } finally { dispose(); }
  });
});

it('keeps showing the value main last accepted when a later request is rejected', async () => {
  const service = statusService(undefined, { alwaysOnTop: true });
  let requests = 0;
  const setAlwaysOnTop = async (next: boolean) => {
    requests += 1;
    if (requests > 1) throw new Error('always-on-top not set');
    return next;
  };
  const { host, dispose } = mountControllerPanes({ controller: { ...service.api, setAlwaysOnTop } });
  try {
    await shown(host);
    alwaysOnTopIn(host)?.click();
    await settled();
    alwaysOnTopIn(host)?.click();
    await settled();
    expect({ requests, state: switchState(host) }).toEqual({ requests: 2, state: 'off' });
  } finally { dispose(); }
});

describe('always-on-top changed outside the window', () => {
  it('shows a value main pushes before its first read replies, over that reply', async () => {
    const service = statusService(undefined, { alwaysOnTop: true });
    let reply!: (on: boolean) => void;
    const read = new Promise<boolean>(done => { reply = done; });
    const { host, dispose } = mountControllerPanes({ controller: { ...service.api, getAlwaysOnTop: () => read } });
    try {
      service.pushAlwaysOnTop(false);
      reply(true);
      await shown(host);
      await settled();
      expect(switchState(host)).toBe('off');
    } finally { dispose(); }
  });

  it('follows each value main pushes later, in both directions, without asking main to change it', async () => {
    const { host, service, dispose } = mountControllerPanes({ alwaysOnTop: true });
    try {
      await shown(host);
      service.pushAlwaysOnTop(false);
      await settled();
      const off = switchState(host);
      service.pushAlwaysOnTop(true);
      await settled();
      expect({ states: [off, switchState(host)], requested: service.requestedAlwaysOnTop }).toEqual({ states: ['off', 'on'], requested: [] });
    } finally { dispose(); }
  });
});
