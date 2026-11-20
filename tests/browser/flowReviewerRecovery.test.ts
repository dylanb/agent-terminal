import { afterEach, expect, it, vi } from 'vitest';
import { createFlowStrip } from '../../src/renderer/src/flowStrip';
import type { FlowStateView } from '../../src/shared/ipc';

afterEach(() => document.body.replaceChildren());

it.each(['start', 'restart'] as const)('retries failed reviewer installation through %s and can cancel it', async (operation) => {
  const host = document.createElement('section');
  const other = document.createElement('aside');
  document.body.append(host, other);
  const base: FlowStateView = { stepName: 'work', runStarted: 'never-started', steps: ['work'], stepRuns: ['runs'], decisions: {}, position: 1, total: 1, status: operation === 'start' ? 'not_started' : 'done' };
  const failed = { ...base, installationRetry: operation, notice: 'Restore the reviewer and Retry.' };
  const repaired: FlowStateView = { ...base, status: 'in_progress' };
  const strip = createFlowStrip(host, {
    state: async () => failed,
    start: async () => repaired, restart: async () => repaired,
    advance: vi.fn(), undo: vi.fn(), provideInput: vi.fn(),
    terminate: async () => base,
    onStatusBar: vi.fn(), onStateChanged: () => () => {},
  });
  strip.onRepoChanged('/repo');
  const button = async (label: string) => vi.waitFor(() => {
    const found = [...host.querySelectorAll('button')].find((node) => node.textContent === label);
    expect(found).toBeDefined();
    return found!;
  });
  (await button(`Retry ${operation === 'start' ? 'Start' : 'Restart'}`)).click();
  await button('Advance');
  other.append(host);
  await strip.refresh();
  (await button('Cancel')).click();
  await button(operation === 'start' ? 'Start' : 'Restart');
  expect(host.textContent).not.toContain('Restore the reviewer');
  strip.dispose();
});

it('keeps a pending Restart as the recovery action and excludes Undo even if status changes', async () => {
  const host = document.createElement('section');
  document.body.append(host);
  let status: FlowStateView['status'] = 'done';
  const base: FlowStateView = { stepName: 'last', runStarted: 'started', steps: ['first', 'last'], stepRuns: ['runs', 'runs'], decisions: {}, position: 2, total: 2, status: 'done' };
  const strip = createFlowStrip(host, {
    state: async () => ({ ...base, status, installationRetry: 'restart' }),
    start: vi.fn(), advance: async () => base, undo: vi.fn(), provideInput: vi.fn(), terminate: vi.fn(),
    restart: async () => ({ ...base, status: 'in_progress', stepName: 'first', position: 1 }),
    onStatusBar: vi.fn(), onStateChanged: () => () => {},
  });
  strip.onRepoChanged('/repo');
  await vi.waitFor(() => expect(host.textContent).toContain('Retry Restart'));
  expect.soft([...host.querySelectorAll('button')].some((node) => node.textContent === 'Undo')).toBe(false);
  status = 'in_progress';
  await strip.refresh();
  const retry = host.querySelector<HTMLButtonElement>('.flow-control')!;
  expect.soft(retry.textContent).toBe('Retry Restart');
  retry.click();
  await vi.waitFor(() => expect(host.querySelector('.flow-control')?.textContent).toBe('Advance'));
  expect(host.querySelector('.flow-undo')).toBeNull();
  strip.dispose();
});
