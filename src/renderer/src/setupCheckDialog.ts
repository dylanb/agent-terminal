import type {
  HostedAgentState,
  InstallExamplesPreview,
  InstallExamplesResult,
  InstallPreviewId,
  SetupDismissReply,
  SetupStatusReply,
} from '../../shared/ipc';
import { silencedBy, type SetupConditionEntry, type SetupDismissal } from '../../shared/setupCheck';
import { asksBeforeInstall, createInstallConsent, type InstallChoice, type InstallPreview } from './installConsent';
import { createModalShell } from './modalShell';
import type { PressGroup } from './pressable';
import type { SetupFlowRun } from './setupFlowRun';

export interface SetupCheckDialogDeps {
  status(repoKey: string): Promise<SetupStatusReply>;
  dismiss(dismissal: SetupDismissal): Promise<SetupDismissReply>;
  previewExamples(): Promise<InstallExamplesPreview>;
  installExamples(previewId: InstallPreviewId, choice: InstallChoice): Promise<InstallExamplesResult>;
  /** Runs the repo-setup flow in `repoKey`; settles once its start has. */
  runSetupFlow(repoKey: string): Promise<SetupFlowRun>;
  /** The agent at the terminal's prompt, which the setup loop needs. */
  agentState(): HostedAgentState;
  /** Calls `cb` when the agent at the prompt changes state; returns its unsubscribe. */
  onAgentStateChanged(cb: (state: HostedAgentState) => void): () => void;
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

const EXAMPLES_MESSAGES: Record<FailureOf<'examples'>, string> = {
  stale: "The app's bundled examples are missing or out of date on this machine, so agent loops may run old flows and loops.",
  unchecked: "The app could not check whether this machine's installed examples match the app's bundled ones.",
};

const IGNORE_MESSAGES: Record<FailureOf<'ignore'>, string> = {
  'not-ignored': 'Git does not ignore the .agent-terminal/ folder, so the files agent loops write there could be committed.',
  unchecked: 'The app could not check whether git ignores the .agent-terminal/ folder.',
};

/** The entries the repo-setup flow fixes; it leaves a rejected loop-capabilities.yaml untouched. */
const fixedBySetupFlow = (entry: SetupConditionEntry): boolean =>
  (entry.condition === 'ignore' && entry.failure === 'not-ignored') || (entry.condition === 'capabilities' && entry.failure === 'absent');

const DISMISSAL_NOT_SAVED = 'The dismissal could not be saved:';
const START_AGENT_TO_RETURN =
  'To run the setup loop, close this and start Claude Code or Codex in the terminal. This popup comes back when it starts.';
const START_AGENT = 'To run the setup loop, start Claude Code or Codex in the terminal.';

type StatusOk = Extract<SetupStatusReply, { ok: true }>;

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function footButton(doc: Document, foot: HTMLElement, presses: PressGroup, label: string, action: () => unknown): HTMLButtonElement {
  const control = doc.createElement('button');
  control.type = 'button';
  control.className = 'pill';
  control.textContent = label;
  presses.bind(control, action);
  foot.append(control);
  return control;
}

function entryMessage(entry: SetupConditionEntry): string {
  switch (entry.condition) {
    case 'examples':
      return EXAMPLES_MESSAGES[entry.failure];
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
  let onOperatorClose: (() => void) | null = null;
  const shell = createModalShell(
    host,
    'setup-check-title',
    () => {
      onOperatorClose?.();
      settle();
    },
    { onFocusLost: () => deps.onFocusLost() },
  );
  /** Redraws the open entry list, when nothing it started is still running. */
  let redrawList: (() => void) | null = null;
  const awaitingAgent = new Set<string>();
  const checked = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  let startup = true;
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

  /** Shows the popup for `first`; settles once it has closed, with whether the operator closed it while the setup
   *  loop waited for an agent and `comesBack` let it return when one starts. */
  function show(first: StatusOk, comesBack: boolean): Promise<boolean> {
    const { repoKey, isRepository, appVersion } = first;
    let waitingForAgent = false;
    let closedWaiting = false;
    onOperatorClose = () => {
      closedWaiting = waitingForAgent && comesBack;
    };
    const shown = new Promise<boolean>((resolve) => (closed = () => resolve(closedWaiting))).finally(() => {
      onOperatorClose = null;
      redrawList = null;
    });
    let alertLine: HTMLElement;
    let setupStarted = false;
    const unfixed = (entries: SetupConditionEntry[]): SetupConditionEntry[] =>
      setupStarted ? entries.filter((entry) => !fixedBySetupFlow(entry)) : entries;

    async function installAndReread(reply: StatusOk, confirm: () => void, previewId: InstallPreviewId, choice: InstallChoice): Promise<void> {
      const installFailure = await deps
        .installExamples(previewId, choice)
        .then((result) => (result.ok ? null : result.error), reasonOf);
      const reread = await deps.status(repoKey).catch((e: unknown): SetupStatusReply => ({ ok: false, reason: reasonOf(e) }));
      if (disposed) return;
      if (!reread.ok) return renderList(reply, true, installFailure ?? reread.reason);
      if (installFailure === null && unfixed(reread.entries).length === 0) {
        confirm();
        settle();
        return;
      }
      renderList(reread, true, installFailure ?? undefined);
    }

    async function previewAndInstall(reply: StatusOk, confirm: () => void): Promise<void> {
      const preview = await deps.previewExamples().catch((e: unknown): InstallExamplesPreview => ({ ok: false, error: reasonOf(e) }));
      if (disposed) return;
      if (!preview.ok) {
        alertLine.textContent = preview.error;
        return;
      }
      if (asksBeforeInstall(preview)) return renderQuestion(reply, preview);
      return installAndReread(reply, confirm, preview.previewId, { replace: [], removeRetired: false });
    }

    function renderQuestion(reply: StatusOk, preview: InstallPreview): void {
      redrawList = null;
      shell.render(({ doc, titleId, close, confirm, presses }) => {
        const consent = createInstallConsent(doc, titleId, preview);
        const foot = doc.createElement('div');
        foot.className = 'mfoot';
        const install = footButton(doc, foot, presses, 'Install', () =>
          installAndReread(reply, confirm, preview.previewId, consent.choice()),
        );
        footButton(doc, foot, presses, 'Back to the list', () => renderList(reply, true));
        footButton(doc, foot, presses, 'Close', close);
        return consent.card(foot, install);
      });
    }

    const renderList = (reply: StatusOk, focusFirstAction: boolean, reason?: string): void => {
      const entries = unfixed(reply.entries);
      const agentPresent = deps.agentState() !== 'absent';
      const offersSetupLoop = reply.setupFlowInstalled && entries.some(fixedBySetupFlow);
      waitingForAgent = offersSetupLoop && !agentPresent;
      shell.render(({ doc, titleId, close: dismiss, confirm, presses }) => {
        redrawList = () => {
          if (!presses.busy) renderList(reply, false);
        };
        const card = doc.createElement('div');
        card.className = 'card';
        const title = doc.createElement('h3');
        title.className = 'serif';
        title.id = titleId;
        title.textContent = isRepository ? 'This repository is not set up for agent loops' : 'Agent loops are not fully set up';
        const body = doc.createElement('div');
        const intro = doc.createElement('p');
        intro.className = 'ph';
        intro.id = `${titleId}-intro`;
        intro.textContent = isRepository ? `${repoKey} fails these checks:` : 'This machine fails these checks:';
        const list = doc.createElement('ul');
        list.className = 'cd-resources';
        list.id = `${titleId}-entries`;
        for (const entry of entries) {
          const item = doc.createElement('li');
          item.textContent = entryMessage(entry);
          list.append(item);
        }
        const error = doc.createElement('p');
        error.className = 'ph';
        error.setAttribute('role', 'alert');
        error.id = `${titleId}-error`;
        if (reason !== undefined) error.textContent = reason;
        alertLine = error;
        const agentHint = doc.createElement('p');
        agentHint.className = 'ph';
        agentHint.id = `${titleId}-agent`;
        if (waitingForAgent) agentHint.textContent = comesBack ? START_AGENT_TO_RETURN : START_AGENT;
        else agentHint.hidden = true;
        body.append(intro, list, agentHint, error);
        const foot = doc.createElement('div');
        foot.className = 'mfoot';
        const button = (label: string, action: () => unknown): HTMLButtonElement => footButton(doc, foot, presses, label, action);
        const lists = (dismissal: SetupDismissal): boolean =>
          entries.some((entry) => silencedBy(dismissal).includes(entry.condition));
        const dismissWith = (dismissal: SetupDismissal) => (): Promise<void> =>
          deps.dismiss(dismissal).then(
            (saved) => {
              if (disposed) return;
              if (!saved.ok) {
                error.textContent = `${DISMISSAL_NOT_SAVED} ${saved.reason}`;
                return;
              }
              const remaining = entries.filter((entry) => !silencedBy(dismissal).includes(entry.condition));
              if (remaining.length > 0) return renderList({ ...reply, entries: remaining }, true);
              confirm();
              settle();
            },
            (e: unknown) => {
              error.textContent = `${DISMISSAL_NOT_SAVED} ${e instanceof Error ? e.message : String(e)}`;
            },
          );
        const actions: HTMLButtonElement[] = [];
        if (entries.some((entry) => entry.condition === 'examples')) {
          actions.push(button('Install/update examples', () => previewAndInstall(reply, confirm)));
        }
        const forRepo: SetupDismissal = { kind: 'repo', repoKey };
        if (lists(forRepo)) actions.push(button("Don't show again for this repo", dismissWith(forRepo)));
        const untilUpdate: SetupDismissal = { kind: 'examples', appVersion };
        if (lists(untilUpdate)) actions.push(button("Don't show again until the app updates", dismissWith(untilUpdate)));
        const runSetupLoop = async (): Promise<void> => {
          confirm();
          const run = await deps.runSetupFlow(repoKey).catch((e: unknown): SetupFlowRun => ({ ok: false, reason: reasonOf(e) }));
          await otherDialogsClosed();
          if (disposed) return;
          setupStarted ||= run.ok;
          if (unfixed(reply.entries).length === 0) return settle();
          renderList(reply, true, run.ok ? undefined : run.reason);
        };
        if (offersSetupLoop && agentPresent) actions.push(button('Run setup loop', runSetupLoop));
        button('Close', dismiss);
        card.append(title, body, foot);
        const initialFocus = focusFirstAction ? (actions[0] ?? null) : null;
        return { card, initialFocus, describedById: `${intro.id} ${list.id} ${waitingForAgent ? `${agentHint.id} ` : ''}${error.id}`, grow: body, scroll: body };
      });
    };
    renderList(first, false);
    return shown;
  }

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  };

  async function comeBack(repoKey: string): Promise<void> {
    if (disposed) return;
    const reply = await deps.status(repoKey).catch(() => null);
    if (disposed || reply?.ok !== true) return;
    const entries = reply.entries.filter(fixedBySetupFlow);
    if (!reply.setupFlowInstalled || entries.length === 0) return;
    await otherDialogsClosed();
    if (disposed) return;
    await show({ ...reply, entries }, false);
  }

  const offPresence = deps.onAgentStateChanged((state) => {
    if (disposed) return;
    redrawList?.();
    if (state !== 'idle') return;
    for (const repoKey of [...awaitingAgent]) {
      awaitingAgent.delete(repoKey);
      void enqueue(() => comeBack(repoKey));
    }
  });

  async function evaluate(repoKey: string, atStartup: boolean): Promise<void> {
    if (disposed || checked.has(repoKey)) return;
    const reply = await deps.status(repoKey).catch(() => null);
    if (reply?.ok !== true) return;
    checked.add(repoKey);
    if (reply.entries.length === 0 || !(atStartup || reply.isRepository)) return;
    await otherDialogsClosed();
    if (disposed) return;
    if (!(await show(reply, true)) || disposed) return;
    if (deps.agentState() === 'idle') void enqueue(() => comeBack(repoKey));
    else awaitingAgent.add(repoKey);
  }

  return {
    check(repoKey) {
      const atStartup = startup;
      startup = false;
      return enqueue(() => evaluate(repoKey, atStartup));
    },
    dispose() {
      disposed = true;
      offPresence();
      stopWaiting?.();
      shell.dispose();
      settle();
    },
  };
}
