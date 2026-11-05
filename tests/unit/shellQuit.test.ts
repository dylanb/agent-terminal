import { describe, expect, it } from 'vitest';
import { holdQuitForShell } from '../../src/main/shellQuit';

function harness(alive = true) {
  const state = { exited: !alive, killed: 0, quits: 0 };
  const exitListeners: Array<() => void> = [];
  const timers: Array<{ ms: number; run: () => void }> = [];
  const listener = holdQuitForShell(
    {
      exited: () => state.exited,
      onExit: (run) => { exitListeners.push(run); },
      forceKill: () => { state.killed += 1; },
    },
    500,
    (ms, run) => { timers.push({ ms, run }); },
    () => { state.quits += 1; },
  );
  const willQuit = () => {
    let prevented = false;
    listener({ preventDefault: () => { prevented = true; } });
    return prevented;
  };
  const shellExits = () => {
    state.exited = true;
    for (const run of exitListeners.splice(0)) run();
  };
  const elapse = () => {
    for (const timer of timers.splice(0)) timer.run();
  };
  return { state, willQuit, shellExits, elapse, timers };
}

describe('holding the app quit until the hosted shell has exited (§5)', () => {
  it('lets the quit through when the shell has already exited', () => {
    const h = harness(false);
    expect(h.willQuit()).toBe(false);
    expect(h.state).toEqual({ exited: true, killed: 0, quits: 0 });
  });

  it('holds the quit while the shell runs, and quits once its exit is delivered', () => {
    const h = harness();
    expect(h.willQuit()).toBe(true);
    expect(h.state.quits).toBe(0);
    h.shellExits();
    expect(h.state.quits).toBe(1);
    expect(h.willQuit()).toBe(false);
    expect(h.state.killed).toBe(0);
  });

  it('holds a repeated quit request without waiting twice', () => {
    const h = harness();
    expect(h.willQuit()).toBe(true);
    expect(h.willQuit()).toBe(true);
    h.shellExits();
    expect(h.state.quits).toBe(1);
  });

  it('kills a shell that has not exited within the grace, then quits on its exit', () => {
    const h = harness();
    h.willQuit();
    expect(h.timers.map(timer => timer.ms)).toEqual([500]);
    h.elapse();
    expect(h.state.killed).toBe(1);
    expect(h.state.quits).toBe(0);
    h.shellExits();
    expect(h.state.quits).toBe(1);
  });

  it('quits anyway when even the killed shell reports no exit within a second grace', () => {
    const h = harness();
    h.willQuit();
    h.elapse();
    expect(h.timers.map(timer => timer.ms)).toEqual([500]);
    h.elapse();
    expect(h.state.quits).toBe(1);
    expect(h.willQuit()).toBe(false);
  });

  it('does not kill a shell whose exit arrived before the grace ran out', () => {
    const h = harness();
    h.willQuit();
    h.shellExits();
    h.elapse();
    expect(h.state).toEqual({ exited: true, killed: 0, quits: 1 });
  });
});
