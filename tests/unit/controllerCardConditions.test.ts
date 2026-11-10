import { describe, expect, it } from 'vitest';
import { attentionText, attentionUpdate } from '../../src/renderer/src/controllerCardConditions';
import { CONTROLLER_OVERSIZED_STATUS_TEXT } from '../../src/shared/controllerStatus';
import { statusTerminal } from '../helpers/controllerStatusFixture';

describe('controller attention text', () => {
  it('words a terminal\'s attention and error as its card words them, each condition\'s title before its reasons', () => {
    expect(attentionText(statusTerminal({ attention: { status: 'error', reasons: ['Check failed', 'Lint failed'] }, error: { reason: 'Broken build' } }).work))
      .toBe('Human needed: error. Check failed. Lint failed. Error. Broken build');
  });

  it('words the latest loop message after the flow\'s own error, as a loop error or a notice by its kind', () => {
    expect([
      attentionText(statusTerminal({ error: { reason: 'Broken build' }, loopMessage: { id: 'm1', kind: 'error', reason: 'the turn stalled' } }).work),
      attentionText(statusTerminal({ loopMessage: { id: 'm2', kind: 'notice', reason: 'nothing to commit' } }).work),
    ]).toEqual(['Error. Broken build. Loop error. the turn stalled', 'Notice. nothing to commit']);
  });

  it('is empty when nothing needs attention, and the oversized-status text when the status could not be read', () => {
    const unread = statusTerminal();
    expect([attentionText(statusTerminal().work), attentionText({ ...unread.work, unavailableReason: 'message-too-large' })])
      .toEqual(['', CONTROLLER_OVERSIZED_STATUS_TEXT]);
  });
});

describe('controller attention announcement', () => {
  it('announces nothing when attention is unchanged, the new text when it changes, and which kind of clearing happened', () => {
    const blocked = attentionText(statusTerminal({ attention: { status: 'complete', reasons: ['Review required'] } }).work);
    const unread = statusTerminal();
    const oversized = attentionText({ ...unread.work, unavailableReason: 'message-too-large' });
    expect([attentionUpdate('', ''), attentionUpdate(blocked, blocked), attentionUpdate('', blocked), attentionUpdate(blocked, ''), attentionUpdate(oversized, '')])
      .toEqual([undefined, undefined, blocked, 'Attention and error cleared', 'Status available: no attention or error reported']);
  });
});
