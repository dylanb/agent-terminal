// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wireMonitorPane } from '../../src/renderer/src/monitor';
import type { CommandSummary, MonitorEvent } from '../../src/shared/ipc';

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeEvent(over: Partial<MonitorEvent>): MonitorEvent {
  return {
    id: 'e1',
    sessionId: 's1',
    type: 'capture',
    source: 'selection',
    text: 'hello',
    range: null,
    truncated: false,
    capturedAt: '2026-06-12T10:00:00.000Z',
    ...over,
  };
}

function makeCommand(over: Partial<CommandSummary>): CommandSummary {
  return {
    id: 'c1',
    sessionId: 's1',
    command: 'ls',
    exitCode: 0,
    running: false,
    startedAt: 0,
    truncated: false,
    ...over,
  };
}

describe('monitor pane DOM (§9/§15.6 — talks only to window.monitor.*)', () => {
  let handlers: {
    event?: (e: MonitorEvent) => void;
    update?: (m: unknown) => void;
    exit?: () => void;
  };
  let monitor: {
    onEvent: ReturnType<typeof vi.fn>;
    onUpdate: ReturnType<typeof vi.fn>;
    onExit: ReturnType<typeof vi.fn>;
    replay: ReturnType<typeof vi.fn>;
    commands: ReturnType<typeof vi.fn>;
    captureCommand: ReturnType<typeof vi.fn>;
    inject: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="monitor-status"></div>
      <div id="command-history"></div>
      <div id="monitor-blocks"></div>`;
    handlers = {};
    monitor = {
      onEvent: vi.fn((cb) => (handlers.event = cb)),
      onUpdate: vi.fn((cb) => (handlers.update = cb)),
      onExit: vi.fn((cb) => (handlers.exit = cb)),
      replay: vi.fn(async () => []),
      commands: vi.fn(async () => []),
      captureCommand: vi.fn(),
      inject: vi.fn(),
    };
    (window as unknown as { monitor: typeof monitor }).monitor = monitor;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const blocks = () => document.getElementById('monitor-blocks')!;
  const history = () => document.getElementById('command-history')!;

  it('renders a known type with a type badge', async () => {
    wireMonitorPane();
    handlers.event!(makeEvent({ type: 'agent-question', text: 'Continue?' }));
    const badge = blocks().querySelector('.capture-badge') as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.dataset.type).toBe('agent-question');
    expect(blocks().querySelector('.capture-text')!.textContent).toBe('Continue?');
  });

  it('renders an unknown future type generically, never dropped', async () => {
    wireMonitorPane();
    handlers.event!(makeEvent({ type: 'mystery-type' as MonitorEvent['type'], text: 'x' }));
    const badge = blocks().querySelector('.capture-badge') as HTMLElement;
    expect(blocks().querySelectorAll('.capture-block').length).toBe(1);
    expect(badge.textContent).toContain('mystery-type');
  });

  it('renders command-history entries with exit chips and a Capture button', async () => {
    monitor.commands.mockResolvedValueOnce([
      makeCommand({ id: 'c1', command: 'ls', exitCode: 0 }),
      makeCommand({ id: 'c2', command: 'sleep 5', running: true, exitCode: null }),
    ]);
    wireMonitorPane();
    await flush();
    const entries = history().querySelectorAll('.command-entry');
    expect(entries.length).toBe(2);
    expect(entries[0].querySelector('.command-text')!.textContent).toBe('ls');
    expect(entries[0].textContent).toContain('exit 0');
    expect(entries[1].textContent?.toLowerCase()).toContain('running');
    expect(entries[0].querySelector('button')!.textContent).toContain('Capture');
  });

  it('Capture click calls captureCommand(id) and renders no block optimistically (fail-closed)', async () => {
    monitor.commands.mockResolvedValueOnce([makeCommand({ id: 'cX', command: 'whoami' })]);
    wireMonitorPane();
    await flush();
    const before = blocks().querySelectorAll('.capture-block').length;
    (history().querySelector('.command-entry button') as HTMLButtonElement).click();
    expect(monitor.captureCommand).toHaveBeenCalledWith('cX');
    expect(blocks().querySelectorAll('.capture-block').length).toBe(before);
  });

  it('re-pulls commands on each monitor:update tick (liveness)', async () => {
    wireMonitorPane();
    await flush();
    const callsAfterLoad = monitor.commands.mock.calls.length;
    handlers.update!({ sessionId: 's1', altScreen: false, bracketedPaste: false, agentState: 'quiet', quietSince: 1 });
    await flush();
    expect(monitor.commands.mock.calls.length).toBeGreaterThan(callsAfterLoad);
  });

  it('a command-output block gets the standard Insert / Insert & submit actions', async () => {
    wireMonitorPane();
    handlers.event!(makeEvent({ type: 'command-output', source: 'shell-integration', text: 'hi' }));
    const buttons = blocks().querySelectorAll('.capture-block button');
    expect(buttons.length).toBe(2);
    (buttons[1] as HTMLButtonElement).click();
    expect(monitor.inject).toHaveBeenCalledWith({ text: 'hi', submit: true });
  });

  it('renders HTML metacharacters inert (textContent only, never innerHTML)', async () => {
    monitor.commands.mockResolvedValueOnce([makeCommand({ id: 'c1', command: '<b>&amp;</b>' })]);
    wireMonitorPane();
    await flush();
    handlers.event!(makeEvent({ text: '<script>alert(1)</script> & <img>' }));
    expect(blocks().querySelector('script')).toBeNull();
    expect(blocks().querySelector('.capture-text')!.textContent).toBe('<script>alert(1)</script> & <img>');
    expect(history().querySelector('b')).toBeNull();
    expect(history().querySelector('.command-text')!.textContent).toBe('<b>&amp;</b>');
  });
});
