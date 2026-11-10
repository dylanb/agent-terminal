## 30. Claude Code window tools

### 30.1 Purpose and installation

After the operator explicitly installs the Claude Code integration in Settings, Claude Code sessions in an
agent-terminal window can read and operate that window through the `agent-terminal` MCP server. This includes
sessions driven by the loop engine and interactive sessions nested in the terminal. Codex and summaries of
other windows are outside this feature (#323 and #324).

Install registers a user-scope MCP server through Claude Code's own CLI and adds the integration's hooks to
its user settings, honoring `CLAUDE_CONFIG_DIR`. Reinstall does not duplicate entries. Remove deletes only
this integration's entries. Other user configuration is preserved; missing Claude Code or unreadable/invalid
settings fail with a visible reason. No repository configuration or `.gitignore` is written. The app-owned
launcher follows app updates and moves. No shell wrapper or shell rc modification is required.

Outside an agent-terminal window the installed server lists no tools and hooks exit silently without waiting
for an app. Inside a window, its inherited endpoint and build identify that window alone. A closed window
cannot redirect calls to a different window. The endpoint lives in app-owned storage, outside repositories,
with the controller socket's ownership protections. Failure to set up the integration must not prevent the
terminal from opening.

### 30.2 Server and results

The server uses the official MCP SDK over stdio. Names match `^[a-zA-Z0-9_-]{1,128}$`.
`src/shared/mcp.ts` defines the names; `src/main/mcpTools.ts` defines arguments and results. Acting tools name
the window and repository, plus the current step, turn or todo where applicable. Unknown tools and malformed
arguments fail before reaching an operation.

A successful tool result has `isError: false`; refusals and outcomes that are neither success nor refusal have
`isError: true`. Text content carries the result and a message suitable for relaying to the operator. A failed
approve side effect at a human gate keeps it waiting, names the failure and says that retrying reruns every
side effect. A decision that advanced despite a failed side effect reports both facts. A pending blocking
dialog is shown in the window and the result names what waits at the machine.

`APP_MCP_ACK_TIMEOUT_MS` bounds acknowledgement that an operation can begin (default 5000 ms); it does not
bound a running operation. A connection lost after acknowledgement yields `result-unknown`: the action may
have run, so the caller should read state again. A build mismatch is app unreachable and runs nothing.

### 30.3 Tools and UI effects

| Tools | Effect | Human-started turn required |
|---|---|---|
| `read_state` | Own window's repository, flow, step and run state, gate options and reason, notification, stalled turn, latest round report, todos, selectable flows and termination todo count | No |
| `approve`, `request_changes`, `redo`, `polish` | The matching gate action, including GitHub side effects; approve also advances a manual step gate | Yes |
| `retry`, `dismiss_loop_message` | Retry the named stalled turn or dismiss the current named message | Yes |
| `choose_flow`, `start` | Select an available flow/loop before the run, then start with supplied typed inputs, including ticket pickup | Yes |
| `terminate` | The UI's Terminate operation for stopping or abandoning; the supplied expected todo deletion count must still match | Yes |
| `todo_create`, `todo_edit`, `todo_reorder`, `todo_complete`, `todo_delete` | The matching mutation in the current repository's todo list, reflected in the overlay | No |
| `todo_send` | Accept one todo for Insert & submit after the calling turn ends and its session is idle | Yes |
| `capture_report` | Capture last report, preserving the prior capture when no report is detected | No |

The MCP and UI paths share the underlying operations. They do not act through the controller. Starting and
approving validate required typed inputs and preserve pickup/branch-conflict/epic-preview dialogs. Changing
selection or starting after a run has begun is refused.

At most one todo send is accepted per calling turn; a second names the already accepted todo and is refused.
Acceptance marks the todo in progress but means accepted for delivery, not submitted. Delivery uses live
bracketed-paste mode, strips `ESC[201~`, and submits only to the original session's input. Closing the terminal,
ending/stopping the calling session, losing the recipient, or a new prompt/app injection before delivery drops
the send. App injections never wait for a send. A send starts a nonhuman turn even though Claude Code may
label the pasted text human.

### 30.4 Guard and refusal order

A human-started turn begins with the operator's typed, pasted, dropped or Remote Control prompt. App injections
(including Insert later submitted with Enter), engine work, gate questions and sent todos are not human.
Neither are command-line launch prompts, print/SDK prompts, scheduled or `/loop` prompts, subagent reports,
peer messages or autonomous continuations. A prompt joining an engine turn does not change its origin.

The guard and audit use the same origin classifier in main, using hook reports, the session process and
Claude Code's transcript. Unknown origin, unreadable evidence and lost reports fail closed. Known app
injection or noninteractive launch evidence remains nonhuman even if the transcript is unavailable. An
unsubmitted Insert edited before submission cannot be distinguished from typed input: it can cost the next
prompt one undetermined refusal, then later typed prompts recover. Paste chords and file drops are typed input.

Refusals are checked in this order, first applicable reason wins:

1. App unreachable (all tools).
2. Not this session's window (acting tools).
3. Turn origin could not be determined (guarded tools).
4. Not a human-started turn (guarded tools).
5. No gate waiting (approve, request changes, redo, polish).
6. Not valid in the current state (acting tools), naming the changed target, missing input, invalid option,
   unavailable action or mismatched termination count.

Checks precede a gate decision, so refusals change no gate, run, todo or capture state and post no loop message.
Retry and Dismiss do not require a waiting gate. A refused call never queues for a future valid state.

Accepted operator boundaries (2026-11-07): calls are attributed to the session's **current turn**, whoever
issued them. Background work from an earlier turn can therefore act during a later human turn and is attributed
to that prompt. A terminal nested inside the window, including tmux or script, counts as the window's terminal.
These are inside the trusted-operator boundary of §27.9.1; the guard prevents a loop mistakenly deciding its
own gate, not an adversarial agent or every action the operator did not request. The operator reaffirmed on
2026-11-10 that human-turn eligibility is not per-action consent: untrusted content encountered during that
turn may influence an action, and the guard does not distinguish it from an explicitly requested action.

### 30.5 Audit

Accepted limitation (operator decision 2026-11-10): **secrets must not be entered into prompts**. The audit
stores full prompt text without secret detection or redaction. A secret entered accidentally can therefore
persist in the audit; preventing secrets from entering prompts is the operator's responsibility.

While a §25 run is open, every human-started prompt is appended with its full text, identity and original
submission time, including prompts with no tool calls. Transcript origin may arrive after the prompt hook;
recording can therefore occur later when it can be classified. A crash or forced kill before that record is
written can lose it; this is an accepted best-effort limit. Reaching done keeps the record open; Terminate
finalizes it.

`src/shared/audit.ts` is the shared serialized vocabulary:

- `mcp.prompt` holds `id`, `text`, `ts`.
- The `mcp` annotation holds a unique `callId`, `tool`, result `outcome`, `origin` (`human`, `not-human` or
  `undetermined`), optional `promptId` and the exact refusal/neither `reason`.
- An existing action event (todo mutation, gate decision command, `flow.started`, step-gate transition) carries
  that annotation and is the call's only entry. Otherwise `mcp.call` is appended.
- `mcp.delivery` holds the send call's `sendId`, `submitted` or `dropped` outcome, and a drop reason. It is not a
  second call or a human prompt.

Every call in a human turn references its prompt. Entries with that reference, in append order, are its call
list; no earlier prompt is rewritten. A run opened by MCP Start records the prompt first, retaining its original
time. Terminate's call comes before `flow.terminated`; later calls write nothing. UI actions have no MCP mark.
Guarded refusals record their reason and distinguish nonhuman from undetermined. Successful todo and capture
actions are recorded in every turn. Reads and refused non-send todo actions in other turns are omitted.
App-unreachable calls are never recorded. Outside a run nothing is recorded unless that call opens the run.

All recording is observe-only and best-effort: write failure cannot change the operation or its result.
Existing §25 files remain readable, and every new event is appended without rewriting prior bytes.

### 30.6 Verification assumptions

The hook/transcript origin format is an internal Claude Code format verified on 2.1.319. A changed or unknown
format refuses guarded operations as undetermined. The real Remote Control acceptance check uses a signed-in
Claude Code session: approve a gate from a human Remote Control prompt and observe advancement, then observe
the same call refused in an engine turn. Record its result in the PR alongside the install/session identity,
launch-origin, slash-command, prompt-text and idle-delivery checks. The automated tracer uses an MCP client
in a window session against the real app and PTY, asserting both allowed UI effects and unchanged refused UI.
