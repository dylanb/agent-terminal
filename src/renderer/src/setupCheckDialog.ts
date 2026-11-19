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
import { createPressGroup, type PressGroup } from './pressable';
import type { SetupFlowRun } from './setupFlowRun';

export interface SetupCheckDialogDeps {
  status(repoKey: string): Promise<SetupStatusReply>;
  dismiss(dismissal: SetupDismissal): Promise<SetupDismissReply>;
  previewExamples(): Promise<InstallExamplesPreview>;
  installExamples(previewId: InstallPreviewId, choice: InstallChoice): Promise<InstallExamplesResult>;
  /** Runs the repo-setup flow in `repoKey`; settles once its start has. */
  runSetupFlow(repoKey: string): Promise<SetupFlowRun>;
  /** Shows why the setup loop the operator asked for did not start. */
  onSetupLoopFailed(reason: string): void;
  /** The agent at the terminal's prompt, which the setup loop needs. */
  agentState(): HostedAgentState;
  /** Calls `cb` when the agent at the prompt changes state; returns its unsubscribe. */
  onAgentStateChanged(cb: (state: HostedAgentState) => void): () => void;
  /** Lands focus when the element that had it leaves the page. */
  onFocusLost(): void;
}

export interface SetupCheckHosts {
  /** Where the setup needed button goes. */
  button: HTMLElement;
  /** Where the popup opens. */
  dialog: HTMLElement;
}

export interface SetupCheckDialog {
  /** Reads `repoKey`'s setup status and shows the setup needed button while it lists any condition. */
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
const START_AGENT = 'To run the setup loop, start Claude Code or Codex in the terminal.';

type StatusOk = Extract<SetupStatusReply, { ok: true }>;
type Outcome = 'closed' | 'setup';

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

export function createSetupCheckDialog(hosts: SetupCheckHosts, deps: SetupCheckDialogDeps): SetupCheckDialog {
  const doc = hosts.button.ownerDocument;
  let closed: ((outcome: Outcome) => void) | null = null;
  const settle = (outcome: Outcome): void => {
    const done = closed;
    closed = null;
    done?.(outcome);
  };
  const shell = createModalShell(hosts.dialog, 'setup-check-title', () => settle('closed'), { onFocusLost: () => deps.onFocusLost() });
  /** Redraws the open entry list, when nothing it started is still running. */
  let redrawList: (() => void) | null = null;
  const setupStarted = new Set<string>();
  let current: string | null = null;
  let shown: StatusOk | null = null;
  let checks = 0;
  let disposed = false;

  const listed = (reply: StatusOk): StatusOk =>
    setupStarted.has(reply.repoKey) ? { ...reply, entries: reply.entries.filter((entry) => !fixedBySetupFlow(entry)) } : reply;

  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'sb-setup';
  button.textContent = 'setup needed';
  button.setAttribute('aria-haspopup', 'dialog');
  button.hidden = true;
  hosts.button.replaceChildren(button);

  function showButtonFor(reply: StatusOk | null): void {
    shown = reply !== null && reply.entries.length > 0 ? reply : null;
    const hadFocus = doc.activeElement === button;
    button.hidden = shown === null;
    if (button.hidden && hadFocus) deps.onFocusLost();
  }

  async function check(repoKey: string): Promise<void> {
    if (disposed) return;
    current = repoKey;
    const asked = ++checks;
    const reply = await deps.status(repoKey).catch(() => null);
    if (disposed || asked !== checks) return;
    showButtonFor(reply?.ok === true ? listed(reply) : null);
  }

  createPressGroup().bind(button, async () => {
    if (shown === null) return;
    const reply = shown;
    if ((await show(reply)) === 'setup') {
      const run = await deps.runSetupFlow(reply.repoKey).catch((e: unknown): SetupFlowRun => ({ ok: false, reason: reasonOf(e) }));
      if (disposed) return;
      if (run.ok) setupStarted.add(reply.repoKey);
      else deps.onSetupLoopFailed(run.reason);
    }
    if (current !== null) await check(current);
  });

  /** Shows the popup for `first`; settles once it has closed, with whether the operator asked for the setup loop. */
  function show(first: StatusOk): Promise<Outcome> {
    const { repoKey, isRepository, appVersion } = first;
    const outcome = new Promise<Outcome>((resolve) => (closed = resolve)).finally(() => {
      redrawList = null;
    });
    let alertLine: HTMLElement;

    async function installAndReread(reply: StatusOk, confirm: () => void, previewId: InstallPreviewId, choice: InstallChoice): Promise<void> {
      const installFailure = await deps
        .installExamples(previewId, choice)
        .then((result) => (result.ok ? null : result.error), reasonOf);
      const reread = await deps.status(repoKey).catch((e: unknown): SetupStatusReply => ({ ok: false, reason: reasonOf(e) }));
      if (disposed) return;
      if (!reread.ok) return renderList(reply, true, installFailure ?? reread.reason);
      const now = listed(reread);
      if (installFailure === null && now.entries.length === 0) {
        confirm();
        settle('closed');
        return;
      }
      renderList(now, true, installFailure ?? undefined);
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
      }, button);
    }

    const renderList = (reply: StatusOk, focusFirstAction: boolean, reason?: string): void => {
      const { entries } = reply;
      const agentPresent = deps.agentState() !== 'absent';
      const offersSetupLoop = reply.setupFlowInstalled && entries.some(fixedBySetupFlow);
      const waitingForAgent = offersSetupLoop && !agentPresent;
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
        if (waitingForAgent) agentHint.textContent = START_AGENT;
        else agentHint.hidden = true;
        body.append(intro, list, agentHint, error);
        const foot = doc.createElement('div');
        foot.className = 'mfoot';
        const control = (label: string, action: () => unknown): HTMLButtonElement => footButton(doc, foot, presses, label, action);
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
              settle('closed');
            },
            (e: unknown) => {
              error.textContent = `${DISMISSAL_NOT_SAVED} ${reasonOf(e)}`;
            },
          );
        const actions: HTMLButtonElement[] = [];
        if (entries.some((entry) => entry.condition === 'examples')) {
          actions.push(control('Install/update examples', () => previewAndInstall(reply, confirm)));
        }
        const forRepo: SetupDismissal = { kind: 'repo', repoKey };
        if (lists(forRepo)) actions.push(control("Don't show again for this repo", dismissWith(forRepo)));
        const untilUpdate: SetupDismissal = { kind: 'examples', appVersion };
        if (lists(untilUpdate)) actions.push(control("Don't show again until the app updates", dismissWith(untilUpdate)));
        if (offersSetupLoop && agentPresent) {
          actions.push(
            control('Run setup loop', () => {
              confirm();
              settle('setup');
            }),
          );
        }
        control('Close', dismiss);
        card.append(title, body, foot);
        const initialFocus = focusFirstAction ? (actions[0] ?? null) : null;
        return { card, initialFocus, describedById: `${intro.id} ${list.id} ${waitingForAgent ? `${agentHint.id} ` : ''}${error.id}`, grow: body, scroll: body };
      }, button);
    };
    renderList(first, false);
    return outcome;
  }

  const offPresence = deps.onAgentStateChanged(() => {
    if (!disposed) redrawList?.();
  });

  return {
    check,
    dispose() {
      disposed = true;
      offPresence();
      shell.dispose();
      settle('closed');
      hosts.button.replaceChildren();
    },
  };
}
