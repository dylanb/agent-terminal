import { describe, expect, it } from 'vitest';
import { attentionText, attentionUpdate } from '../../src/renderer/src/controllerCardConditions';
import { CONTROLLER_OVERSIZED_STATUS_TEXT } from '../../src/shared/controllerStatus';
import { statusTerminal } from '../helpers/controllerStatusFixture';

describe('controller attention text', () => {
  it('words a terminal\'s attention and error as its card words them, each condition\'s title before its reasons', () => {
    expect(attentionText(statusTerminal({ attention: { status: 'error', reasons: ['Check failed', 'Lint failed'] }, error: { reason: 'Broken build' } })))
      .toBe('Human needed: error. Check failed. Lint failed. Error. Broken build');
  });

  it('is empty when nothing needs attention, and the oversized-status text when the status could not be read', () => {
    const unread = statusTerminal();
    expect([attentionText(statusTerminal()), attentionText({ ...unread, work: { ...unread.work, unavailableReason: 'message-too-large' } })])
      .toEqual(['', CONTROLLER_OVERSIZED_STATUS_TEXT]);
  });
});

describe('controller attention announcement', () => {
  it('announces nothing when attention is unchanged, the new text when it changes, and which kind of clearing happened', () => {
    const blocked = attentionText(statusTerminal({ attention: { status: 'complete', reasons: ['Review required'] } }));
    const unread = statusTerminal();
    const oversized = attentionText({ ...unread, work: { ...unread.work, unavailableReason: 'message-too-large' } });
    expect([attentionUpdate('', ''), attentionUpdate(blocked, blocked), attentionUpdate('', blocked), attentionUpdate(blocked, ''), attentionUpdate(oversized, '')])
      .toEqual([undefined, undefined, blocked, 'Attention and error cleared', 'Status available: no attention or error reported']);
  });
});
