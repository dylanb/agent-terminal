// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { fakeLayout, mountControllerPanes } from '../helpers/controllerMount';
import { STATUS_CASES, statusService } from '../helpers/controllerStatusFixture';

afterEach(() => document.body.replaceChildren());

describe('the controller mount helper', () => {
  it('mounts the organism on the shared fake, in the body or a chosen parent, and disposes it', () => {
    const view = mountControllerPanes();
    expect(view.host.parentElement).toBe(document.body);
    expect(view.host.textContent).toContain('/fixed/worktree');

    const parent = document.createElement('section');
    document.body.append(parent);
    const placed = mountControllerPanes({ terminals: [STATUS_CASES.working.terminal], parent });
    expect(placed.host.parentElement).toBe(parent);
    expect(placed.host.textContent).toContain(STATUS_CASES.working.terminal.launchDirectory);

    placed.dispose();
    expect(placed.host.isConnected).toBe(false);
    placed.service.publish([STATUS_CASES.completed.terminal]);
    expect(placed.host.textContent).not.toContain(STATUS_CASES.completed.terminal.launchDirectory);
  });

  it('uses an overriding controller service', () => {
    const service = statusService([STATUS_CASES.idle.terminal]);
    const view = mountControllerPanes({ controller: service.api });
    service.publish([STATUS_CASES.completed.terminal]);
    expect(view.host.textContent).toContain(STATUS_CASES.completed.terminal.launchDirectory);
    expect(view.service).toBeUndefined();
    // @ts-expect-error a test that injects its own controller cannot also list terminals the mount would ignore
    mountControllerPanes({ controller: service.api, terminals: [STATUS_CASES.idle.terminal] }).dispose();
  });
});

describe('the layout fake', () => {
  it('starts multi-column unless told otherwise', () => {
    expect(fakeLayout().layout.oneColumn()).toBe(false);
    expect(fakeLayout(true).layout.oneColumn()).toBe(true);
  });

  it('notifies a listener of each change until it unsubscribes', () => {
    const fake = fakeLayout();
    const seen: boolean[] = [];
    const unsubscribe = fake.layout.onChange(() => seen.push(fake.layout.oneColumn()));
    fake.set(true);
    fake.set(false);
    unsubscribe();
    fake.set(true);
    expect(seen).toEqual([true, false]);
  });
});
