// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAlwaysOnTopControl } from '../../src/renderer/src/alwaysOnTopControl';
import { alwaysOnTopIn, alwaysOnTopOn } from '../helpers/controllerCards';
import { statusService } from '../helpers/controllerStatusFixture';

afterEach(() => document.body.replaceChildren());

type Service = ReturnType<typeof statusService>;

function mount(service: Service, controller = service.api) {
  const host = document.createElement('span');
  document.body.append(host);
  const control = createAlwaysOnTopControl(host, { controller });
  return { host, dispose: () => control.dispose() };
}

const state = (host: HTMLElement) => (alwaysOnTopIn(host) ? (alwaysOnTopOn(host) ? 'on' : 'off') : 'missing');
const shown = (host: HTMLElement) => vi.waitFor(() => {
  if (!alwaysOnTopIn(host)) throw new Error('no Always on top switch yet');
}).catch(() => undefined);
const settled = () => new Promise(resolve => setTimeout(resolve, 0));

describe('the Always on top control', () => {
  it('shows main\'s value, and on when main\'s value cannot be read', async () => {
    const states = [];
    for (const alwaysOnTop of [true, false, 'unreadable'] as const) {
      const { host, dispose } = mount(statusService(undefined, { alwaysOnTop }));
      await shown(host);
      states.push(state(host));
      dispose();
    }
    expect(states).toEqual(['on', 'off', 'on']);
  });

  it('asks main for the other value and shows main\'s reply, keeping main\'s value when the request is refused or rejected', async () => {
    const outcome = async (alwaysOnTopReply: 'applied' | 'refused' | 'rejected') => {
      const service = statusService(undefined, { alwaysOnTop: true, alwaysOnTopReply });
      const { host, dispose } = mount(service);
      await shown(host);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      alwaysOnTopIn(host)?.click();
      await settled();
      const result = { requested: [...service.requestedAlwaysOnTop], state: state(host) };
      dispose();
      return result;
    };
    expect({ applied: await outcome('applied'), refused: await outcome('refused'), rejected: await outcome('rejected') }).toEqual({
      applied: { requested: [false], state: 'off' },
      refused: { requested: [false], state: 'on' },
      rejected: { requested: [false], state: 'on' },
    });
  });

  it('ignores a second press and shows busy until main answers the first, then accepts presses again', async () => {
    const service = statusService(undefined, { alwaysOnTop: true });
    let answer!: () => void;
    const answered = new Promise<void>(done => { answer = done; });
    const { host, dispose } = mount(service, {
      ...service.api,
      setAlwaysOnTop: next => answered.then(() => service.api.setAlwaysOnTop(next)),
    });
    await shown(host);
    alwaysOnTopIn(host)?.click();
    alwaysOnTopIn(host)?.click();
    await settled();
    const pending = { busy: alwaysOnTopIn(host)?.getAttribute('aria-busy') ?? null, requests: service.requestedAlwaysOnTop.length };
    answer();
    await settled();
    const after = { busy: alwaysOnTopIn(host)?.getAttribute('aria-busy') ?? null, state: state(host) };
    alwaysOnTopIn(host)?.click();
    await settled();
    expect({ pending, after, requested: service.requestedAlwaysOnTop }).toEqual({
      pending: { busy: 'true', requests: 0 },
      after: { busy: null, state: 'off' },
      requested: [false, true],
    });
    dispose();
  });

  it('shows a value main pushes before its first read replies, and follows later pushes', async () => {
    const service = statusService(undefined, { alwaysOnTop: true });
    let reply!: (on: boolean) => void;
    const read = new Promise<boolean>(done => { reply = done; });
    const { host, dispose } = mount(service, { ...service.api, getAlwaysOnTop: () => read });
    service.pushAlwaysOnTop(false);
    reply(true);
    await shown(host);
    await settled();
    const early = state(host);
    service.pushAlwaysOnTop(true);
    await settled();
    expect({ states: [early, state(host)], requested: service.requestedAlwaysOnTop }).toEqual({ states: ['off', 'on'], requested: [] });
    dispose();
  });

  it('removes the switch and stops following pushes once disposed', async () => {
    const service = statusService(undefined, { alwaysOnTop: true });
    const { host, dispose } = mount(service);
    await shown(host);
    const mounted = { switch: state(host), following: service.followingAlwaysOnTop() };
    dispose();
    expect({ mounted, disposed: { switch: state(host), following: service.followingAlwaysOnTop() } }).toEqual({
      mounted: { switch: 'on', following: true },
      disposed: { switch: 'missing', following: false },
    });
  });
});
