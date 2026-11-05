import type { SetupStatusReply } from '../../shared/ipc';
import type { SetupConditionEntry } from '../../shared/setupCheck';
import { createModalShell } from './modalShell';

export interface SetupCheckDialogDeps {
  status(repoKey: string): Promise<SetupStatusReply>;
  /** Lands focus when the dialog closes after the element that opened it has left the page. */
  onFocusLost(): void;
  /** Whether another app dialog is open, so this one waits instead of opening over it. */
  blockingDialogOpen(): boolean;
  /** Calls `cb` when another app dialog closes; returns its unsubscribe. */
  onBlockingDialogClosed(cb: () => void): () => void;
}

export interface SetupCheckDialog {
  /** Asks for `repoKey`'s setup status and, when it lists any condition, opens the popup naming it. */
  check(repoKey: string): Promise<void>;
  dispose(): void;
}

type FailureOf<C extends SetupConditionEntry['condition']> = Extract<SetupConditionEntry, { condition: C }>['failure'];

const CAPABILITIES_MESSAGES: Record<FailureOf<'capabilities'>, string> = {
  absent: 'There is no loop-capabilities.yaml, so agent loops do not know how to run its tests and build.',
  malformed: 'Its loop-capabilities.yaml cannot be used: the app could not read it as a valid capabilities file.',
  confinement: 'Its loop-capabilities.yaml is a symbolic link or leaves the repository, so the app refuses to read it.',
};

const IGNORE_MESSAGES: Record<FailureOf<'ignore'>, string> = {
  'not-ignored': 'Git does not ignore the .agent-terminal/ folder, so the files agent loops write there could be committed.',
  unchecked: 'The app could not check whether git ignores the .agent-terminal/ folder.',
};

function entryMessage(entry: SetupConditionEntry): string {
  switch (entry.condition) {
    case 'capabilities':
      return CAPABILITIES_MESSAGES[entry.failure];
    case 'ignore':
      return IGNORE_MESSAGES[entry.failure];
  }
}

export function createSetupCheckDialog(host: HTMLElement, deps: SetupCheckDialogDeps): SetupCheckDialog {
  let closed: (() => void) | null = null;
  const settle = (): void => {
    const done = closed;
    closed = null;
    done?.();
  };
  const shell = createModalShell(host, 'setup-check-title', settle, { onFocusLost: () => deps.onFocusLost() });
  const checked = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  let disposed = false;
  let stopWaiting: (() => void) | null = null;

  async function otherDialogsClosed(): Promise<void> {
    while (!disposed && deps.blockingDialogOpen()) {
      await new Promise<void>((resolve) => {
        const off = deps.onBlockingDialogClosed(() => stop());
        const stop = (): void => {
          off();
          stopWaiting = null;
          resolve();
        };
        stopWaiting = stop;
      });
    }
  }

  function show(repoKey: string, entries: SetupConditionEntry[]): Promise<void> {
    const shown = new Promise<void>((resolve) => (closed = resolve));
    shell.render(({ doc, titleId, close: dismiss, presses }) => {
      const card = doc.createElement('div');
      card.className = 'card';
      const title = doc.createElement('h3');
      title.className = 'serif';
      title.id = titleId;
      title.textContent = 'This repository is not set up for agent loops';
      const body = doc.createElement('div');
      const intro = doc.createElement('p');
      intro.className = 'ph';
      intro.id = `${titleId}-intro`;
      intro.textContent = `${repoKey} fails these checks:`;
      const list = doc.createElement('ul');
      list.className = 'cd-resources';
      list.id = `${titleId}-entries`;
      for (const entry of entries) {
        const item = doc.createElement('li');
        item.textContent = entryMessage(entry);
        list.append(item);
      }
      body.append(intro, list);
      const foot = doc.createElement('div');
      foot.className = 'mfoot';
      const close = doc.createElement('button');
      close.type = 'button';
      close.className = 'pill';
      close.textContent = 'Close';
      presses.bind(close, dismiss);
      foot.append(close);
      card.append(title, body, foot);
      return { card, initialFocus: null, describedById: `${intro.id} ${list.id}`, grow: body, scroll: body };
    });
    return shown;
  }

  async function evaluate(repoKey: string): Promise<void> {
    if (disposed || checked.has(repoKey)) return;
    const reply = await deps.status(repoKey).catch(() => null);
    if (reply?.ok !== true) return;
    checked.add(repoKey);
    if (reply.entries.length === 0) return;
    await otherDialogsClosed();
    if (disposed) return;
    await show(reply.repoKey, reply.entries);
  }

  return {
    check(repoKey) {
      const run = queue.then(() => evaluate(repoKey));
      queue = run.catch(() => {});
      return run;
    },
    dispose() {
      disposed = true;
      stopWaiting?.();
      shell.dispose();
      settle();
    },
  };
}
