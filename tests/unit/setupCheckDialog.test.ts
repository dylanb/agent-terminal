// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSetupCheckDialog, type SetupCheckDialog } from '../../src/renderer/src/setupCheckDialog';
import { ENTRY, REPO, fakeSetupDeps, repoStatus } from '../helpers/setupCheckFixtures';
import { recordSetupDialogs, setupCheckScreen } from '../helpers/setupCheckScreen';

// The setup-check popup lists each condition the checked repository fails, in plain words, one message per
// failure kind.

const mounted: SetupCheckDialog[] = [];

function mountDialog(fake: ReturnType<typeof fakeSetupDeps>) {
  const host = document.body.appendChild(document.createElement('div'));
  const dialog = createSetupCheckDialog(host, fake.deps);
  mounted.push(dialog);
  return { host, dialog, screen: setupCheckScreen(host) };
}

/** Waits until the open dialog is the one raised for `repoKey`. */
const shownFor = (screen: ReturnType<typeof setupCheckScreen>, repoKey: string): Promise<void> =>
  vi.waitFor(() => {
    expect(screen.isOpen(), `a setup dialog is open for ${repoKey}`).toBe(true);
    expect(`${screen.title()} ${screen.description()}`).toContain(repoKey);
  });

beforeEach(() => document.body.replaceChildren());
afterEach(() => {
  for (const dialog of mounted.splice(0)) dialog.dispose();
});

describe('a check whose status lists conditions', () => {
  it('opens a dialog naming the repository with one entry per listed condition', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored, ENTRY.absent]));
    const { dialog, screen } = mountDialog(fake);

    void dialog.check(REPO.alpha);
    await shownFor(screen, REPO.alpha);

    expect(screen.entries()).toHaveLength(2);
  });

  it('gives each failure kind its own message (AC1, AC2, AC3, AC6)', async () => {
    const kinds = [ENTRY.absent, ENTRY.malformed, ENTRY.confinement, ENTRY.notIgnored, ENTRY.unchecked];
    const messages: string[] = [];
    for (const entry of kinds) {
      const fake = fakeSetupDeps();
      fake.answer(REPO.bravo, repoStatus(REPO.bravo, [entry]));
      const { dialog, screen } = mountDialog(fake);
      void dialog.check(REPO.bravo);
      await shownFor(screen, REPO.bravo);
      messages.push(...screen.entries());
    }

    expect(
      { count: messages.length, distinct: new Set(messages.filter((m) => m.length > 0)).size },
      `messages: ${JSON.stringify(messages)}`,
    ).toEqual({ count: kinds.length, distinct: kinds.length });
  });
});

describe('a check whose status lists nothing', () => {
  it('opens no dialog: the next failing repository raises the first dialog shown', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, []));
    fake.answer(REPO.charlie, repoStatus(REPO.charlie, [ENTRY.malformed]));
    const { host, dialog, screen } = mountDialog(fake);
    const seen = recordSetupDialogs(host);

    void dialog.check(REPO.alpha);
    void dialog.check(REPO.charlie);
    await shownFor(screen, REPO.charlie);

    expect(seen()[0]).toContain(REPO.charlie);
  });
});
