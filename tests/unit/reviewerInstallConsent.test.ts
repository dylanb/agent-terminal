// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createInstallConsent } from '../../src/renderer/src/installConsent';
import { installExamplesScreen, reviewerInstallPreview } from '../helpers/installExamplesScreen';

describe('reviewer replacement consent', () => {
  it('keeps the two platform choices independent', () => {
    const consent = createInstallConsent(document, 'reviewer-consent', reviewerInstallPreview());
    const foot = document.createElement('div');
    const fallback = document.createElement('button');
    const { card } = consent.card(foot, fallback);
    const screen = installExamplesScreen(card);
    expect(consent.choice()).toEqual({ replace: [], removeRetired: false });
    screen.checkbox('Codex reviewer agents — 2 files').click();
    expect(consent.choice()).toEqual({ replace: ['codexAgents'], removeRetired: false });
    screen.checkbox('Claude Code reviewer agents — 1 file').click();
    screen.checkbox('Codex reviewer agents — 2 files').click();
    expect(consent.choice()).toEqual({ replace: ['agents'], removeRetired: false });
  });
});
