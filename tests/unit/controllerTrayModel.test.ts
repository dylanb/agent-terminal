import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import {
  controllerTrayIcon, controllerTrayMenu, controllerTrayMenuMode, controllerTrayView, watchTrayView,
  type ControllerTrayView, type TrayBadge,
} from '../../src/main/controllerTrayModel';
import { resolveWindowIconPath } from '../../src/main/appIcon';
import { cardCounts, statusSummary } from '../../src/shared/controllerCardStatus';
import { directoryCards } from '../../src/shared/controllerCards';
import type { ControllerTerminal } from '../../src/shared/ipc';
import { directoryConflictFixture, distinctAttentionMix, STATUS_CASES, workStatus } from '../helpers/controllerStatusFixture';

const at = (id: string, launchDirectory: string, overrides: Partial<ControllerTerminal> = {}): ControllerTerminal =>
  ({ id, launchDirectory, repositoryRoot: launchDirectory, work: workStatus({ activity: 'active' }), ...overrides });
const working = (id: string, launchDirectory: string) => at(id, launchDirectory);
const needingHuman = (id: string, launchDirectory: string) => at(id, launchDirectory, { work: workStatus({ attention: { status: 'needs a human', reasons: ['Approve the plan'] } }) });
const failing = (id: string, launchDirectory: string) => at(id, launchDirectory, { work: workStatus({ error: { reason: 'Step exited 1' } }) });
const disconnected = (id: string, launchDirectory: string) => at(id, launchDirectory, { status: 'disconnected' });

/** Six cards whose compared counts all differ: connected 5, errors 3 (1 disconnected), needs a human 2. */
function conflictMix(): ControllerTerminal[] {
  const { members, unrelated } = directoryConflictFixture();
  return [...members, unrelated, STATUS_CASES['needs-human'].terminal, STATUS_CASES.oversized.terminal, STATUS_CASES.disconnected.terminal, STATUS_CASES.working.terminal];
}

describe('the tray view', () => {
  it('counts connected cards, errors with their disconnected share, and cards needing a human, as the window header counts them', () => {
    const mix = distinctAttentionMix();
    const view = (terminals: readonly ControllerTerminal[]) => {
      const { connected, errors, disconnectedErrors, needsHuman } = controllerTrayView(terminals, true);
      return { connected, errors, disconnectedErrors, needsHuman };
    };
    expect({ mix: view(mix.terminals), conflict: view(conflictMix()) }).toEqual({
      mix: { connected: mix.counts.connected, errors: mix.counts.errors, disconnectedErrors: mix.counts.disconnected, needsHuman: mix.counts.needsHuman },
      conflict: { connected: 5, errors: 3, disconnectedErrors: 1, needsHuman: 2 },
    });
  });

  it('gives the same error and needs-a-human counts as the window summary, and the same connected and disconnected counts as its header', () => {
    const sets: Record<string, readonly ControllerTerminal[]> = {
      ...Object.fromEntries(Object.entries(STATUS_CASES).map(([key, { terminal }]) => [key, [terminal]])),
      'every status case': Object.values(STATUS_CASES).map(({ terminal }) => terminal),
      'directory conflict': conflictMix(),
    };
    const mismatches = Object.entries(sets).flatMap(([key, terminals]) => {
      const cards = directoryCards(terminals);
      const summary = Object.fromEntries(statusSummary(cards).map(({ statusClass, count }) => [statusClass, count]));
      const counts = cardCounts(cards);
      const expected = { errors: summary.error, needsHuman: summary['needs-human'], connected: counts.connected, disconnectedErrors: counts.disconnected };
      const { errors, needsHuman, connected, disconnectedErrors } = controllerTrayView(terminals, false);
      const actual = { errors, needsHuman, connected, disconnectedErrors };
      return JSON.stringify(actual) === JSON.stringify(expected) ? [] : [`${key}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`];
    });
    expect(mismatches).toEqual([]);
  });

  it('shows no badge, amber for a human, and red for any error whether or not a human is also needed', () => {
    const badge = (terminals: readonly ControllerTerminal[]) => controllerTrayView(terminals, true).badge;
    const c = STATUS_CASES;
    expect({
      'no terminals': badge([]),
      'nothing needs attention': badge([c.working.terminal, c.idle.terminal, c.completed.terminal]),
      'needs a human': badge([c['needs-human'].terminal, c.working.terminal]),
      'status unavailable': badge([c.oversized.terminal]),
      'flow error': badge([c['flow-error'].terminal]),
      'error and human on separate cards': badge([c['flow-error'].terminal, c['needs-human'].terminal]),
      'error and human on one card': badge([c['flow-error-and-human'].terminal]),
      disconnected: badge([c.disconnected.terminal, c['needs-human'].terminal]),
      'shared directory': badge(directoryConflictFixture().members.map(member => ({ ...member, work: workStatus() }))),
    }).toEqual({
      'no terminals': 'none',
      'nothing needs attention': 'none',
      'needs a human': 'needs-human',
      'status unavailable': 'needs-human',
      'flow error': 'error',
      'error and human on separate cards': 'error',
      'error and human on one card': 'error',
      disconnected: 'error',
      'shared directory': 'error',
    });
  });

  it('carries the always-on-top value it is given', () => {
    expect([controllerTrayView([], true).alwaysOnTop, controllerTrayView([], false).alwaysOnTop]).toEqual([true, false]);
  });
});

/** A terminals source and an always-on-top owner the test drives, shaped as the registry and owner deliver them. */
function traySources(initial: ControllerTerminal[], alwaysOnTop: boolean) {
  const terminalListeners = new Set<(terminals: ControllerTerminal[]) => void>();
  const alwaysOnTopListeners = new Set<(on: boolean) => void>();
  let terminals = initial;
  let on = alwaysOnTop;
  return {
    sources: {
      subscribeTerminals(listener: (terminals: ControllerTerminal[]) => void) {
        terminalListeners.add(listener);
        listener(structuredClone(terminals));
        return () => { terminalListeners.delete(listener); };
      },
      alwaysOnTop: {
        current: () => on,
        subscribe(listener: (on: boolean) => void) {
          alwaysOnTopListeners.add(listener);
          return () => { alwaysOnTopListeners.delete(listener); };
        },
      },
    },
    publish(next: ControllerTerminal[]) {
      terminals = next;
      terminalListeners.forEach(listener => listener(structuredClone(next)));
    },
    setAlwaysOnTop(next: boolean) {
      on = next;
      alwaysOnTopListeners.forEach(listener => listener(next));
    },
  };
}

describe('watching the tray view', () => {
  it('moves the badge with every condition the cards show: gate, flow error, disconnect, re-register and a shared directory', () => {
    const dir = '/watched/worktree';
    const source = traySources([working('a', dir)], true);
    const views: ControllerTrayView[] = [];
    const stop = watchTrayView(source.sources, view => { views.push(view); });
    const badges: (TrayBadge | undefined)[] = [views.at(-1)?.badge];
    const step = (terminals: ControllerTerminal[]) => { source.publish(terminals); badges.push(views.at(-1)?.badge); };
    step([needingHuman('a', dir)]);
    step([working('a', dir)]);
    step([failing('a', dir)]);
    step([working('a', dir)]);
    step([disconnected('a', dir)]);
    step([needingHuman('b', dir)]);
    step([needingHuman('b', dir), working('c', dir)]);
    step([needingHuman('b', dir)]);
    step([working('b', dir)]);
    stop();
    expect(badges).toEqual(['none', 'needs-human', 'none', 'error', 'none', 'error', 'needs-human', 'error', 'needs-human', 'none']);
  });

  it('gives a fresh view on a status change, a connect, a disconnect, a dismissal and an always-on-top change', () => {
    const source = traySources([working('a', '/watched/a')], true);
    const views: ControllerTrayView[] = [];
    const stop = watchTrayView(source.sources, view => { views.push(view); });
    const seen: (ControllerTrayView | undefined)[] = [views.at(-1)];
    source.publish([needingHuman('a', '/watched/a')]);
    seen.push(views.at(-1));
    source.publish([needingHuman('a', '/watched/a'), working('d', '/watched/d'), working('e', '/watched/e')]);
    seen.push(views.at(-1));
    source.publish([needingHuman('a', '/watched/a'), working('d', '/watched/d'), disconnected('e', '/watched/e')]);
    seen.push(views.at(-1));
    source.publish([needingHuman('a', '/watched/a'), working('d', '/watched/d')]);
    seen.push(views.at(-1));
    source.setAlwaysOnTop(false);
    seen.push(views.at(-1));
    stop();
    const view = (badge: TrayBadge, connected: number, errors: number, disconnectedErrors: number, needsHuman: number, alwaysOnTop: boolean) =>
      ({ badge, connected, errors, disconnectedErrors, needsHuman, alwaysOnTop });
    expect(seen).toEqual([
      view('none', 1, 0, 0, 0, true),
      view('needs-human', 1, 0, 0, 1, true),
      view('needs-human', 3, 0, 0, 1, true),
      view('error', 2, 1, 1, 1, true),
      view('needs-human', 2, 0, 0, 1, true),
      view('needs-human', 2, 0, 0, 1, false),
    ]);
  });

  it('gives no view after it is stopped', () => {
    const source = traySources([working('a', '/watched/a')], true);
    const views: ControllerTrayView[] = [];
    const stop = watchTrayView(source.sources, view => { views.push(view); });
    const before = views.length;
    stop();
    source.publish([failing('a', '/watched/a')]);
    source.setAlwaysOnTop(false);
    expect({ watched: before > 0, afterStop: views.length - before }).toEqual({ watched: true, afterStop: 0 });
  });
});

/** Matches a label holding every part: a number as a whole word, a string anywhere, case-insensitively. */
const mentions = (...parts: (string | number)[]) =>
  expect.stringMatching(new RegExp(`^${parts.map(part => typeof part === 'number' ? `(?=.*\\b${part}\\b)` : `(?=.*${part})`).join('')}`, 'is'));
const labels = (menu: readonly MenuItemConstructorOptions[]) => menu.filter(item => item.type !== 'separator').map(item => item.label);
const itemLabelled = (menu: readonly MenuItemConstructorOptions[], label: string) => menu.find(item => item.label === label);
const click = (item: MenuItemConstructorOptions | undefined) => item?.click?.(undefined as never, undefined, undefined as never);

function recordingActions() {
  const calls: string[] = [];
  return { calls, actions: { open() { calls.push('open'); }, setAlwaysOnTop(on: boolean) { calls.push(`setAlwaysOnTop ${on}`); }, quit() { calls.push('quit'); } } };
}

describe('the tray menu', () => {
  it('lists the app name, the connected count, the errors and needs-a-human lines, Open, Always on top, Quit and the note, in order', () => {
    const { terminals, counts } = distinctAttentionMix();
    const menu = controllerTrayMenu(controllerTrayView(terminals, true), recordingActions().actions);
    const note = menu.filter(item => item.type !== 'separator').at(-1);
    expect({
      labels: labels(menu),
      alwaysOnTop: { type: itemLabelled(menu, 'Always on top')?.type, checked: itemLabelled(menu, 'Always on top')?.checked },
      noteActionable: Boolean(note?.click || note?.role),
      attentionLinesCarryIcons: menu.filter(item => /error|human/i.test(item.label ?? '')).some(item => item.icon !== undefined),
      namesADirectory: terminals.some(terminal => JSON.stringify(menu).includes(terminal.launchDirectory)),
    }).toEqual({
      labels: [
        mentions('agent terminal controller'),
        mentions(counts.connected, 'connected'),
        mentions(counts.errors, 'error', counts.disconnected, 'disconnected'),
        mentions(counts.needsHuman, 'human'),
        'Open Controller',
        'Always on top',
        'Quit Controller',
        mentions('terminal'),
      ],
      alwaysOnTop: { type: 'checkbox', checked: true },
      noteActionable: false,
      attentionLinesCarryIcons: false,
      namesADirectory: false,
    });
  });

  it('leaves out the errors and needs-a-human lines when there are none, and shows Always on top unchecked when it is off', () => {
    const terminals = [working('a', '/menu/a'), working('b', '/menu/b'), working('c', '/menu/c')];
    const menu = controllerTrayMenu(controllerTrayView(terminals, false), recordingActions().actions);
    expect({ labels: labels(menu), checked: itemLabelled(menu, 'Always on top')?.checked }).toEqual({
      labels: [mentions('agent terminal controller'), mentions(3, 'connected'), 'Open Controller', 'Always on top', 'Quit Controller', mentions('terminal')],
      checked: false,
    });
  });

  it('shows the errors line without a needs-a-human line, and the needs-a-human line without an errors line', () => {
    const menuLabels = (terminals: ControllerTerminal[]) => labels(controllerTrayMenu(controllerTrayView(terminals, true), recordingActions().actions));
    expect({
      errorsOnly: menuLabels([failing('a', '/menu/a'), working('b', '/menu/b'), working('c', '/menu/c')]),
      humanOnly: menuLabels([needingHuman('a', '/menu/a'), needingHuman('b', '/menu/b'), working('c', '/menu/c')]),
    }).toEqual({
      errorsOnly: [mentions('agent terminal controller'), mentions(3, 'connected'), mentions(1, 'error'), 'Open Controller', 'Always on top', 'Quit Controller', mentions('terminal')],
      humanOnly: [mentions('agent terminal controller'), mentions(3, 'connected'), mentions(2, 'human'), 'Open Controller', 'Always on top', 'Quit Controller', mentions('terminal')],
    });
  });

  it('leaves the disconnected share out of the errors line when no error card is disconnected', () => {
    const terminals = [failing('a', '/menu/a'), failing('b', '/menu/b'), needingHuman('c', '/menu/c'), working('d', '/menu/d')];
    const errorsLine = labels(controllerTrayMenu(controllerTrayView(terminals, true), recordingActions().actions))[2];
    expect({ errorsLine, mentionsDisconnected: /disconnected/i.test(errorsLine ?? '') }).toEqual({ errorsLine: mentions(2, 'error'), mentionsDisconnected: false });
  });

  it('opens the window, asks for the other always-on-top value and quits from its three items', () => {
    const outcome = (alwaysOnTop: boolean) => {
      const { calls, actions } = recordingActions();
      const menu = controllerTrayMenu(controllerTrayView([working('a', '/menu/a')], alwaysOnTop), actions);
      for (const label of ['Open Controller', 'Always on top', 'Quit Controller']) click(itemLabelled(menu, label));
      return calls;
    };
    expect({ on: outcome(true), off: outcome(false) }).toEqual({
      on: ['open', 'setAlwaysOnTop false', 'quit'],
      off: ['open', 'setAlwaysOnTop true', 'quit'],
    });
  });

  it('is attached to the icon on Linux, so a host that delivers no click still shows it, and pops up on right-click on macOS', () => {
    expect({ linux: controllerTrayMenuMode('linux'), darwin: controllerTrayMenuMode('darwin') }).toEqual({ linux: 'attached', darwin: 'popup-on-right-click' });
  });
});

const ROOT = resolve(__dirname, '../..');

/** The light-theme (`:root`) value of a colour token in tokens.css, as `rrggbb`, following `var()` references. */
function lightToken(name: string): string {
  const css = readFileSync(resolve(ROOT, 'src/renderer/src/tokens.css'), 'utf8');
  const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  const value = (token: string): string => {
    const raw = new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(root)?.[1].trim() ?? '';
    const reference = /^var\((--[\w-]+)\)$/.exec(raw);
    return reference ? value(reference[1]) : raw;
  };
  return value(name).replace('#', '').toLowerCase();
}

/** Every fully opaque colour in a PNG, as `rrggbb`. */
function opaqueColours(file: string): Set<string> {
  const { data } = PNG.sync.read(readFileSync(file));
  const colours = new Set<string>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 255) colours.add([data[i], data[i + 1], data[i + 2]].map(channel => channel.toString(16).padStart(2, '0')).join(''));
  }
  return colours;
}

describe('the tray icon', () => {
  it('is a different icon for no badge, a human and an error', () => {
    const badges: TrayBadge[] = ['none', 'needs-human', 'error'];
    expect(new Set(badges.map(controllerTrayIcon)).size).toBe(3);
  });

  it('shows the cards\' light-theme amber for a human and red for an error, and neither when nothing needs attention', () => {
    const amber = lightToken('--status-needs-human');
    const red = lightToken('--status-error');
    const colours = (badge: TrayBadge) => {
      const shown = opaqueColours(resolveWindowIconPath({ packaged: false, appPath: ROOT }, controllerTrayIcon(badge)));
      return { amber: shown.has(amber), red: shown.has(red) };
    };
    expect({ none: colours('none'), 'needs-human': colours('needs-human'), error: colours('error') }).toEqual({
      none: { amber: false, red: false },
      'needs-human': { amber: true, red: false },
      error: { amber: false, red: true },
    });
  });
});

describe('watching the tray view as it changes', () => {
  it('keeps the current always-on-top value in views given after the terminals change', () => {
    const source = traySources([working('a', '/watched/a')], true);
    const views: ControllerTrayView[] = [];
    const stop = watchTrayView(source.sources, view => { views.push(view); });
    source.setAlwaysOnTop(false);
    source.publish([working('a', '/watched/a'), working('b', '/watched/b')]);
    stop();
    expect({ connected: views.at(-1)?.connected, alwaysOnTop: views.at(-1)?.alwaysOnTop }).toEqual({ connected: 2, alwaysOnTop: false });
  });

  it('gives no new view for an update that changes nothing the tray shows, and one for an update that does', () => {
    const source = traySources([working('a', '/watched/a')], true);
    const views: ControllerTrayView[] = [];
    const stop = watchTrayView(source.sources, view => { views.push(view); });
    const first = views.length;
    source.publish([at('a', '/watched/a', { work: workStatus({ activity: 'quiet' }) })]);
    const afterActivity = views.length;
    source.publish([needingHuman('a', '/watched/a')]);
    stop();
    expect({ afterActivity: afterActivity - first, afterGate: views.length - afterActivity, badge: views.at(-1)?.badge })
      .toEqual({ afterActivity: 0, afterGate: 1, badge: 'needs-human' });
  });
});
