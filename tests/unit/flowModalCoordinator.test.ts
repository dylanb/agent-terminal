// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfirmDialog } from '../../src/renderer/src/confirmDialog';
import { createErrorDialog } from '../../src/renderer/src/errorDialog';
import { createFlowModalCoordinator } from '../../src/renderer/src/flowModalCoordinator';
import { handleTerminateRepoChange } from '../../src/renderer/src/terminateConfirm';

describe('flow modal coordinator', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div id="errors"></div><div id="confirmations"></div>';
  });

  it('replaces an open error with a conflict confirmation', () => {
    const errors = createErrorDialog(document.getElementById('errors')!);
    const confirmations = createConfirmDialog(
      document.getElementById('confirmations')!,
    );
    const cancelPendingConfirmation = vi.fn();
    const coordinator = createFlowModalCoordinator({
      errors,
      confirmations,
      cancelPendingConfirmation,
    });
    coordinator.showError({ title: 'Bootstrap failed', message: 'reason' });
    cancelPendingConfirmation.mockClear();

    coordinator.showConfirmation({
      title: 'Branch already exists',
      message: 'Wipe and retry?',
      confirmLabel: 'Wipe and retry',
      onConfirm: vi.fn(),
    });

    expect(document.querySelector('#errors [aria-modal="true"]')).toBeNull();
    expect(
      document.querySelector('#confirmations [aria-modal="true"]'),
    ).not.toBeNull();
    expect(cancelPendingConfirmation).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
  });

  it('semantically cancels an open confirmation before showing an error', () => {
    const onCancel = vi.fn();
    const errors = createErrorDialog(document.getElementById('errors')!);
    const confirmations = createConfirmDialog(
      document.getElementById('confirmations')!,
    );
    const cancelPendingConfirmation = vi.fn();
    const coordinator = createFlowModalCoordinator({
      errors,
      confirmations,
      cancelPendingConfirmation,
    });
    coordinator.showConfirmation({
      title: 'Branch already exists',
      message: 'Wipe and retry?',
      confirmLabel: 'Wipe and retry',
      onConfirm: vi.fn(),
      onCancel,
    });
    cancelPendingConfirmation.mockClear();

    coordinator.showError({ title: 'Bootstrap failed', message: 'reason' });

    expect(cancelPendingConfirmation).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('#confirmations [aria-modal="true"]'),
    ).toBeNull();
    expect(document.querySelector('#errors [aria-modal="true"]')).not.toBeNull();
    expect(document.querySelectorAll('[aria-modal="true"]')).toHaveLength(1);
  });

  it('cancels a conflict before repository teardown lands focus', () => {
    document.body.innerHTML =
      '<div id="flow"><button id="opener">Terminate</button></div>' +
      '<button id="fallback">View 1</button>' +
      '<div id="errors"></div><div id="confirmations"></div>';
    const flow = document.getElementById('flow')!;
    const opener = document.getElementById('opener') as HTMLButtonElement;
    const fallback = document.getElementById(
      'fallback',
    ) as HTMLButtonElement;
    const errors = createErrorDialog(document.getElementById('errors')!);
    const confirmations = createConfirmDialog(
      document.getElementById('confirmations')!,
    );
    const onCancel = vi.fn();
    const coordinator = createFlowModalCoordinator({
      errors,
      confirmations,
      cancelPendingConfirmation: vi.fn(),
    });
    opener.focus();
    coordinator.showConfirmation({
      title: 'Branch already exists',
      message: 'Wipe and retry?',
      confirmLabel: 'Wipe and retry',
      onConfirm: vi.fn(),
      onCancel,
    });

    coordinator.cancelConfirmation();
    handleTerminateRepoChange(undefined, '/repo-b', () => {
      flow.replaceChildren();
    }, {
      isAffected: () => flow.contains(document.activeElement),
      land: () => fallback.focus(),
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(
      document.querySelector('#confirmations [aria-modal="true"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(fallback);
  });
});
