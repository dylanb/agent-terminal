# CODE-STANDARDS.md

The **Code standards** section of `CLAUDE.md` carries the one-line imperatives; this file carries each
rule's rationale, motivating defect, and named primitive. When a `CLAUDE.md` bullet links here, cite the
section (e.g. "CODE-STANDARDS.md § Shell quoting") in review rather than re-arguing the design. Nothing
here is new — it is the same rules with the depth that need not sit in every turn's context.

## Untrusted data crosses a boundary as data, never as syntax

Anything crossing a process, shell, or OS boundary into a place the far side interprets is carried as a
structured value — env var, `argv` element, quoted literal — **never concatenated into a string the far
side parses** (CWE-78). Instances: paste-breakout sanitization at the injection seam (§7.5/§9.3), and the
§23.5 launch target crossing the OS boundary as a distinct env value rather than spliced into a command
line. When the boundary is a POSIX shell, the enforcement is the shell-quoting rule below.

## Shell quoting — `src/shared/shellQuote.ts`, never hand-rolled

Any value placed into shell text is quoted through the one shared primitive — generated scripts,
PATH/profile blocks, command lines, pasted paths all route through it (shared-semantics rule; CWE-78).
`shellQuote` is lossless — it only quotes; lossy paste-safety (e.g. C0-control stripping before a drop
reaches the prompt, §7.8) is a separate layer the caller applies *before* quoting, never folded in.

## Confining repo-derived paths — `src/main/confinedPath.ts`, never hand-rolled

Any path derived from repo content is confined before it is walked, opened, or written — the filesystem
twin of the `shellQuote` rule: an inline confinement check is one the *next* callsite will not have.

**Which jail you name depends on WHOSE GROUND IT SITS ON, and getting that backwards is the bug.**
`resolveJail` is for a jail inside *untrusted content* — a checked-out working tree — where an attacker
can plant a symlink at the jail's own final segment: it resolves the anchor but never that segment, so a
planted `.agent-loop` link cannot adopt its target (the segment is *our* literal; what is untrusted is the
ground it stands on, not the name). `resolveOwnedDirJail` is for a root in the **user's own space** the app
derives itself (`$HOME`, `CLAUDE_CONFIG_DIR`, …) and which may not exist yet: it resolves *including* the
final segment. A link the user placed at their own config dir is their setup — a dotfiles repo — and the
tools that *read* it follow the link, so refusing to write through it seeds nothing the reader loads and
strands the user, while granting no protection: whatever could plant the link can already write the
directory.

Confinement then holds **inside** the resolved jail either way: `confinedRealPath` /
`confinedRealPathResult` returns the symlink-free real path (or why it refused — `escapes` vs
`unresolvable`, which call for opposite fixes and must never be reported as each other), rejecting a
lexical escape (CWE-22), a symlink the caller would follow out (CWE-59), and a later swap that redirects
the read (CWE-367). It lives in `src/main/`, not `src/shared/`, because it needs `node:fs` and `src/shared/`
must stay renderer-importable. Motivating defect: `loopDef.ts` grew a correct confinement for the `exec`
gate's artifact paths but kept it private, and `viewerWatch.ts`'s new directory walker then followed a
symlinked root straight back into the inotify exhaustion the walker existed to fix. A primitive nobody can
see is one nobody reuses; absence of a call to a shared one is visible in review.

## Errno narrowing and error messages — `src/main/errno.ts`, never inline

A caught value raises two questions — "which errno?" and "what do I tell the user?" — both answered by one
module. `isErrno(e, code)` narrows `unknown` (a thrown non-`Error` fails closed) against a **closed
`ErrnoCode` union**, not a `string`: every caller selects swallow-vs-rethrow off that value, and a
misspelled code compiles, never matches, and silently turns a handled failure into an escaping one.
`errMsg(e)` is the same rule for the message. Both are one definition because the casts they replace had
already been removed once and grew back at the next filesystem callsite. An unused `ErrnoCode` member is a
claim about the code that is not true — widen it only when a caller needs it.

## Tree-walks that must distinguish absent from unreadable — `src/main/dirEntries.ts`

A tree-walk whose emptiness would be a silent DATA problem uses this module: an **absent** directory yields
`[]` (an optional subtree legitimately has no files), an **unreadable** one **throws**. Conflating them is
how a mispackaged bundle plans zero files and reports a *successful install of nothing* — so the install
walk uses it. A best-effort *reader* that treats any failure as "nothing to show" (the todo-template
picker) is a different, correct policy — the rule is not "every readdir routes here."

## Validating an untrusted value that feeds a safety limit — where, and which way it fails

A value read from attacker-plantable persisted state (`.agent-terminal/loop/run-state.yaml`, and any on-disk
doc a repo can carry) that feeds a **runaway backstop** — an iteration cap, budget, quota, rate limit — is
validated in two places, and the two are **not redundant**.

**Field-local constraints go at the untrusted read boundary; a relational constraint goes at the use
site.** The reader enforces everything judgeable about the value *alone* — finite, non-negative, integer —
degrading anything else to the safe default. A constraint relating the value to *another* the reader does
not have in scope belongs where both operands are live. This was the shape of a real defect in the retired
loop engine: its `cap_baseline` field was decoded at the read boundary as a finite non-negative integer or
`0`, but its real invariant — `cap_baseline <= iteration` — was checked only where `iteration` was also
live. **Passing the read-boundary gate is not proof the relational invariant holds**; treating "the reader
already validated it" as sufficient is the bug.

**A normalization that feeds a safety limit fails TOWARD the limit still firing, never away from it.** Out
of range, the fallback is the one that *preserves* the backstop — `cap_baseline` degraded to `0`, the
monotonic window `iteration - 0`, so the cap fired exactly as with no reset — never one that silently
disables it. The sharpest corollary: **when you change how a limit is computed, re-derive whether
out-of-range inputs still fail safe.** That is where the defect lived — moving the cap test from `iteration
>= cap` to `iteration - cap_baseline >= cap` *flipped the safe direction*: a planted `cap_baseline` larger
than `iteration` (or `NaN` / `±Inf`) drove the subtraction negative or incomparable, so the runaway
backstop went from "fires early" to **never fires** — unbounded autonomous iteration out of one line of
untrusted YAML (CWE-20/770). The fix was the two layers above, each with a RED test: the reader over the
hostile numeric family (`-1`, `NaN`, `±Inf`, non-integer), the decision over `cap_baseline > iteration`. The
retired engine and its persisted iteration cap are gone (the surviving engine's consolidator stops for a
human instead); the rule they illustrate does not depend on either surviving.

## An agent-produced artifact contract — one vocabulary, a self-validating example, a minimal predicate

§27's review-and-fix turn is the first place a **composed prompt instructs an LLM subagent to produce a
serialized artifact that a predicate then gates completion on** (`composeReviewAndFixPrompt` writes it,
`roundReportProblems` validates it). A prompt is a *writer* in the shared-semantics contract — an
instruction to a model, not a second process — and it desyncs the same way two copies of a wire format do.
Four disciplines hold it, the middle two easy to drop:

1. **One descriptor feeds both sides.** The disposition set, the reviewer statuses and the JSON keys live
   once in `src/shared/roundReport.ts`; the composer and the predicate both read it. The trap is not
   seeing "a prompt" as a side of the contract.
2. **The prompt's few-shot is asserted well-formed against the gating predicate.** `exampleRoundReport(...)`
   is run through `roundReportProblems` in a test (`reviewTurn.test.ts` — "no prompt↔predicate drift").
   Without it the example and the predicate are two hand-maintained copies and no code test catches the
   drift.
3. **The predicate validates the minimal contract, not a rigid layout.** It checks the declared sections,
   the full roster, and each issue's required fields with a disposition from the closed set — never key order,
   extra fields or formatting. Over-constrain it and the test's fake agent passes while a real model's legitimate
   variation is rejected: mocking the VT parser, one layer out.
4. **The artifact is structured data, and the agent can run the predicate itself.** A format the loop both
   writes (through a prompt) and reads is JSON, parsed by the platform parser and judged by the shared
   predicate, never a hand-written grammar over Markdown. The prompt hands the agent a command that runs that
   same predicate (the bundled checker, §27.12) and tells it to fix the file until the check passes before it
   signals done. Free text the predicate does not judge — notes, raw captured output — lives outside the
   parsed structure, in a file nothing parses. The motivating defect: #208's goal progress file was Markdown
   read by a hand-written parser, and the review loop found a new valid edge case in it every round (fences,
   indented code, emphasis) — never a repeat, so §27.6's spinning check could not see it. JSON removed the
   whole class.

## Independent-lifecycle state lives in its own file, disjoint from any wholesale-rewritten document

A flag whose set/clear lifecycle is **independent** of a larger persisted document is stored in its own
file — never as a field of that document — so that a wholesale write of the document is *structurally*
unable to clobber or resurrect it. This is the on-disk dual of the shared-semantics writer↔reader rule and
a load-bearing part of never-allow-unrecoverable-state: it removes an entire class of defect by construction
rather than by every write remembering to preserve a field.

The §27 loop keeps three concerns under `<repo>/.agent-terminal/loop/` in three disjoint files —
`run-state.yaml` (the turn/round/verdict document), `armed-interrupt.yaml`, and `polish.yaml` (the two
`{schema_version, step}` levers). The run-state writer serializes and re-writes the whole run-state document
on every turn-status transition, which happens constantly. Had polish or the armed interrupt been a *field*
of that document, two failure shapes open that no reviewer reliably catches: **(1)** any path that
constructs a fresh run-state and writes it — a redo re-entry rebuilding the work turn, a relaunch replaying
state — silently drops or carries a stale flag forward, because "write the whole document" and "preserve
this one orthogonal field" are two obligations and only the first is visible in the diff; **(2)** a stale
in-memory run-state object round-tripped back to disk *after* the flag was cleared elsewhere resurrects it,
reviving a stand-down the operator already dismissed. Disjoint files make both impossible: the run-state
writer cannot address `polish.yaml`, so no run-state write can touch it, and clearing polish (`rmSync` on
its own file) cannot touch the run-state. (The orthogonal concern — an *abandoned* stand-down surviving a
same-step re-drive — is handled separately by clearing on fresh work-turn entry; disjoint files answer only
"a sibling's write can't move this flag," not "this flag expires correctly.")

RED-first, the disjointness is pinned directly: `appLoopState.test.ts` ("§27 polish stand-down and armed
interrupt — disjoint flags") asserts that arming an interrupt never surfaces as, clobbers, or resurrects a
polish stand-down, and the reverse — a pin that fails the moment either lever is folded into a shared
document or into the other's file. The general pin shape for any such flag: **writing the document leaves
the flag file byte-for-byte untouched, and clearing the flag leaves the document byte-for-byte unchanged.**

## The app never modifies the user's `.gitignore`

Whether to ignore or commit a path is the user's VCS decision, not the app's. App-owned files
(`flow-state.yaml`, the audit pointer, `todos.json`, anything under `.agent-terminal/`) are written where
the spec puts them, but the writing code **never** creates, appends to, or edits `.gitignore` to "protect"
them — a per-file entry is redundant where the directory is already ignored, and unwanted churn besides
(§19.1/§25; todoStore §16.3 is the reference — it never touched `.gitignore`). RED-first tests for any
app-owned persistence MUST assert the write **creates no `.gitignore`** and leaves a pre-existing one
**byte-for-byte unchanged**.

This generalizes: production never **silently** rewrites a user's tooling config — `.git/`, editor
configs, shell rc files — to tidy its own state. The exemption is an **explicit, user-invoked install
action** (§23.5; the §18.1 install-examples action and its destinations), and it is an exemption from
*silence*, not from care: it writes only where the user asked, asks before replacing a file it did not
create, leaves a declined file byte-for-byte unchanged, and never deletes. Writing into a directory another
tool owns — `~/.claude/skills`, `~/.claude/commands` — is permitted on exactly those terms and no others.

## IPC payloads carry resource identity; the receiver never re-derives it from ambient state

The `sessionId`-on-every-payload rule is one instance; this is the principle. Ambient state — cwd, focused
repo, selected pane — moves between the moment a message is *raised* and the moment it is *answered*, so a
receiver that reaches for "the current repo" instead of reading it off the message will eventually act on
the wrong one. **For a destructive or outward-facing action this is a data-loss defect, not a tidiness
one:** the retired engine's `flow:onBootstrapConflict` shipped without a `repoKey`, so a conflict raised for
repo A could be answered against whatever repo the user had since `cd`'d into — and the answer wipes a
branch and closes its PR. The surviving `flow:onAppBootstrapConflict` pair carries the fix forward: bind the
handler to the identity the message carries (`wireAppBootstrapConflict` takes the `repoKey` and `step` the
message injects, no cwd dependency), never to a `repoKey()` the handler looks up for itself.

## Published snapshots have explicit ownership and isolate consumers

An API that returns or publishes a state snapshot MUST define who owns the value. A consumer MUST NOT
be able to mutate the producer's state or another consumer's view through that snapshot, including its
nested objects and arrays. Detached copies or enforced immutability both satisfy this rule; no particular
cloning library or mechanism is required. A shallow copy or a TypeScript `readonly` annotation alone
does not protect shared mutable values at runtime.

The motivating defect was the controller registry and status publisher: consumers could modify nested
ticket titles or attention reasons and thereby change retained state or another subscriber's delivery.
The ownership contract applies equally to direct reads and subscription deliveries.

Tests verify the contract through observable behavior: attempt to change a returned or delivered nested
value, then confirm that subsequent reads and other subscribers still receive the producer's original
state. An immutable API may reject the attempted mutation; a detached mutable snapshot may accept it
locally. Tests must allow either mechanism when the public ownership contract allows both, and must
never assert which clone or freeze function was called.

## Delayed consent and asynchronous results act only on the exact occurrence they were raised for

Resource identity says *which object*; it does not say *which observed version*. Between inspection and
mutation, the object can change while keeping the same repository, path, branch, or numeric id. A preview,
confirmation, or asynchronous result MUST therefore carry an opaque occurrence identity or an immutable
version snapshot sufficient to reject a stale, replayed, or expanded action. Consume a one-use
authorization before attempting the operation, verify that every requested mutation was offered by that
authorization, revalidate the snapshot immediately before mutation, and use the backing system's
compare-and-mutate primitive with the expected version where one exists. If the identity or version no
longer matches, make the result inert and require a fresh inspection; never reinterpret old consent against
current ambient state.

The inspection shown to the user and the authorization consumed by the operation derive from one
inspection/snapshot pipeline, not parallel implementations of the same conflict semantics. The install
examples action is the local-file case: its opaque `previewId` names one retained source/target hash
snapshot, apply consumes it once, accepts replacements only for conflicts that snapshot offered, and
rechecks the snapshot before each write. Bootstrap conflict resolution is the outward-facing case: the
decision carries repository, branch, local and remote object ids, and pull-request ids; wipe rejects a
changed snapshot, and ref deletion supplies the expected object id to Git's conditional update.

## An action a receiver can refuse is a two-way request; the UI holds its collected input open until the reply confirms

One-way dispatch plus a state-pull is the default IPC shape, and it is correct only when the near side can
know the outcome from state it already owns. It is **wrong** the moment whether the action succeeds is state
only the receiver holds — a runner mid-turn, a gate that has already raced out, a lock — because a one-way
send leaves the sender to guess, and the reflexive guess is "assume it landed, close the UI." When that UI
was collecting human input the operator cannot cheaply reproduce, the optimistic close *discards their typed
work on the exact refusal it was meant to survive*. So: model such an action as a two-way request that
returns the outcome (`ipcRenderer.invoke`/`ipcMain.handle`), and keep the input-collecting UI open until the
reply confirms delivery — close on success, and on refusal preserve the entered value and surface why. The
motivating case: request-changes rode a one-way `flow:appGateDecision` (with the feedback smuggled through
an overloaded `note?`), so a decision that arrived while the loop was busy was dropped and the composer had
already closed over the operator's feedback. Retightened, it rides a dedicated two-way `flow:appRequestChanges`
that returns a `boolean`; `runAppGateDecision` returns that far-side outcome, and `feedbackComposer` holds
the dialog open — `false` keeps the text and shows the reason, `true` closes — so a busy loop costs a retry,
never the feedback. Litmus: if the operation can fail on state the receiver alone holds *and* the near side
is holding input a drop would lose, a one-way channel is a data-loss defect — this is the collect-then-dispatch
mechanism that satisfies the never-unrecoverable-state rule, named.

## A best-effort or cosmetic side effect must never abort the critical path it sits on

Anything observe-only or decorative — the Dock icon, the §25 audit record, fire-and-forget telemetry — is
wrapped so a failure inside it cannot propagate into its caller. The §25 recorder already says "never
throws into the flow path"; the rule is general, because the inverse is how a `setIcon` throw that aborted
`createWindow` before the window existed once turned the *entire* e2e bar red with no product cause.
Litmus: if this effect threw, would a feature the user depends on stop working? If yes, it is on the
critical path by accident — isolate it (try/catch leaving a sensible default, or a non-throwing boundary)
so its failure is contained and, where it matters, recorded. This is the robustness dual of the
TDD-evidence rule: don't let an inessential effect manufacture a red bar that masks — or mimics — a real one.

### Name the calls that throw

The rule is unfalsifiable until you name the calls that throw. Every `fs.*Sync` (`rmSync`, `statSync`,
`mkdirSync`, `readdirSync`, `writeFileSync`, `openSync`), `execFileSync`/`spawnSync`, `realpathSync`,
`JSON.parse`, and `fs.watch` throws on inputs a hostile or merely untidy filesystem can produce. **On a
best-effort path each one is wrapped, and each wrap needs a RED-first test that provokes the throw.** Two
that read as safe and are not: `rmSync(p, { force: true })` suppresses only `ENOENT` — it still throws
`EISDIR` on a directory and `EPERM` on a locked path (`clearTurnDone` on the injection path and the
`state.yaml.tmp` pre-clean both stranded the loop this way); and a `postinstall` that shells out to `bash`
fails the entire `pnpm install` on any machine where `bash` is not on `PATH`. If you cannot name a new
filesystem or subprocess call's three failure modes, you have not finished writing it.

### A caught value is `unknown`, never an `Error`

`catch (e) { ...(e as Error).message }` yields `undefined` for a thrown string, a rejected object, or
anything a dependency throws that is not an `Error` — so the one place whose job is to explain the failure
explains nothing. Always coerce: `` const reason = e instanceof Error ? e.message : String(e) ``. This is
the mirror of the swallowing rule below: an error surfaced with an empty reason has been swallowed as
thoroughly as one never caught.

## Never silently swallow an error whose consequence is a state the user cannot recover from

The opposite of the best-effort rule above: there, a failure in an *inessential* effect must be contained;
here, a failure on the *critical path itself* must never be dropped. An `{ok:false}` result, a caught
exception, an early-return guard — if it means the system did not do what the user asked and now sits in a
state they can't see or fix by clicking, it MUST surface (an error the UI presents) and MUST leave the flow
in a state the user can retry or back out of. The motivating defect: the loop orchestrator injected a
work-agent prompt into a bare shell because the "no agent at the prompt / not injectable" condition was
swallowed (only an `exit 1` audit line) — the user saw nothing happen, and the only "recovery" was quitting
the agent and scrolling shell history to find the leaked prompt. Silent early-returns on the critical path
are the shape this takes; every one must be provably harmless or surfaced. **If you are unsure whether a
swallowed error can strand the user, ask the operator — do not guess.**

## Never allow an unrecoverable state to occur

A state is unrecoverable when the user cannot get back to a good state through the UI without external
surgery (hand-editing `state.yaml`/`flow-state.yaml`, deleting `.agent-loop/`, running `git`/`gh` by hand,
restarting the app to clear stuck in-memory state). Design every operation so that on failure it **rolls
back to the prior good state or forward to one with a visible next action** — never a dead end. This is why
a failed bootstrap reverts the flow (§27.10) rather than leaving it half-advanced, and why a stuck turn
stops in a first-class `error` status with a retry/impasse affordance (§27.12/D48) rather than hanging. When
a change could introduce a path with no UI route out — or when you cannot tell whether one exists — **stop
and ask the operator before building it.**

## The policy authorizing a destructive operation is checked at the operation, not at the prompt

A confirmation flag records that *a human said yes*; it does not record that *the policy permits the act*.
Check both where the act happens, in that order, and hard-fail the policy before any prompt is raised —
otherwise a caller that arrives with the flag already set performs a wipe the policy forbids. `loopPickup`
shipped this way: `wipeConflict: true` deleted the branch (and closed its PR) regardless of whether
`on_conflict` was `wipe-and-retry`, because the policy was consulted only on the path that *asked*. The
confirm-first rule for hard-to-reverse and outward-facing actions stands on top of this, not instead of it.

## Every entry in the run log must be true

The app keeps a running record of what it did during each task — the run log (we call it the §25 audit log). People read it afterwards to understand what actually happened, so every entry is a statement of fact: "we showed the user a confirmation," "we skipped this step," "this step failed." Those statements have to be accurate. A wrong entry isn't a cosmetic issue — it misleads whoever reads the log into believing something that never occurred: a confirmation the user was never shown, a failure that never happened, or a "success" that was really a cancellation.

Two mistakes to avoid:

- **Never record something that didn't happen** — and never leave out something that did. Don't write "confirmation shown" for a run where you actually blocked the action and showed nothing, and don't log a cancelled review as a success.
- **Never use one entry for two different things.** If "skipped on purpose" and "tried and failed" write the same entry, nobody reading the log later can tell them apart. Same trap when a small follow-up failure gets recorded as if the main action failed — now the log blames a step that actually succeeded.

To write the right entry, the code has to be able to tell the situations apart — and this is usually where it breaks. A function returns a plain yes/no, but yes/no can't separate two outcomes that both count as "yes." When that happens, change the function to return a value that names which outcome actually occurred, and choose the log entry from that. Don't guess by picking the closest-looking entry off a yes/no.

A worked example: our epic-promotion gate used to return true/false, where "true" meant "we held the action." But it held in two different cases — either we showed the user a confirmation, or we blocked the action entirely. True/false can't tell those apart, yet we should record "confirmation shown" in only the first case. The fix was to return a value that names the real outcome (shown / blocked / not-applicable) and record "confirmation shown" only when it was actually shown. The gate-decision log already works this way: "skipped" and "failed" are separate entries, a cancelled decision is recorded as a cancellation and never as a success, and a bookkeeping failure is its own entry so it's never mistaken for the main action failing.

Prove it with a test that would fail if the log lied, and check both directions: the entry shows up when the outcome happened, and does not show up when a different outcome happened. Checking only the first isn't enough — a bug that writes the entry every single time would still pass. So the "blocked" test confirms the block was recorded and that no "confirmation shown" entry appears; the cancellation tests confirm the cancellation was recorded and that no "success" entry appears.

In the code: the gate returns `EpicGateOutcome` (not the old boolean). The "confirmation shown" entry, recorded only on the `preview-raised` outcome, is produced by the shared `gateDecisionAuditCmd` (`src/shared/audit.ts`); each block entry is the shared `epicPromotionAuditCmd('blocked', …)` (`src/shared/audit.ts`), a kind deliberately distinct from that preview entry so a block is never recorded as a confirmation.

## Comments state ONLY what the code cannot

If a fact is recoverable by reading the code, commenting it is forbidden. The test is mechanical and
absolute: *could a reader delete this comment, read only the code, and recover the same fact?* If yes,
**delete the comment.** That bars narration (restating a line, signature, type, data structure,
control-flow step, name) **and** any description of the *current mechanism* — mechanism descriptions drift
the instant the mechanism changes, and a behavior-preserving refactor must never be able to falsify a
surviving comment (the stale "single carried slot" beside a per-repo map is the canonical failure this rule
exists to kill). **The default is no comment.** A comment is allowed in exactly two cases, and nothing
else qualifies:

- **A citation of an authority outside this repository.** A web standard criterion (WCAG / WAI-ARIA), a
  CWE, an RFC, a wire or terminal protocol (OSC 7/133, bracketed-paste framing), or a third-party tool's
  file format or API (git's rebase instruction sheet, Playwright's `page.evaluate` serialization).
  **The citation is the whole comment** — no prose restating or applying what it says; a citation followed
  by a gloss is the shape every stale comment in this repo has taken, the citation staying true while the
  gloss rots beside it. **Nothing inside this repository is cited from code** — not the spec (`§n`, save
  the one exception in the next case), not `CLAUDE.md` or the standards files, not another module, and
  never a loop flow document — the plan, the groomed ticket, the impl-report and the other files under
  `.agent-terminal/loop/artifacts/` are not committed, so a citation of one points at nothing once the
  branch merges. Issue and PR text are the same:
  the one sanctioned reference to the tracker is the `// untestable; tracked in #NNN` gap pointer below. An
  in-repo rule that matters at a site is held there by a type, a name or a test, which a reader finds from
  the code and which fails when the rule is broken; a citation does neither.
- **A fact that is near impossible, or very expensive, to recover from the code.** The bar is high: a fact
  a reader can recover in a few minutes of reading — even across several files — does not qualify. What
  qualifies needs running the system, reading third-party source, or history to find: an implicit coupling
  between two modules where an edit on one side silently breaks the other **and no type, name, test or
  assertion can catch it**, or a reason the obvious simpler code is wrong that only an observed failure
  revealed. **A spec citation (`§n`) qualifies here and only here:** when the code's behaviour is set by a
  spec clause that a reader could otherwise find only by reading the whole spec — the clause is the reason
  the code is as it is, and nothing in the code, its names or its tests leads to it. The citation is the
  whole comment, with no gloss. A `§n` beside code whose name, test or module already leads to its clause,
  or used as a label for a feature, does not qualify. Even then, first try to make the fact unbreakable in
  code (a shared type, a precise name, a pinning test) and comment only the residue; state **what breaks if it is violated**, never how the code
  currently works.

Everything else goes, doc-comments included: a `/** */` on an exported identifier meets the same bar as
any other comment. Prefer a precise name or a named test over any sentence. This standard governs new and
changed code; a change that touches an existing comment brings that comment into line, and existing `§n`
comments elsewhere are not rewritten wholesale. The tightening to outside-the-repository citations came from
#245, whose test helpers cited "plan R2", "plan R3" and "#245 § Status token contract" — flow-document
sections that vanish at merge — and kept them through a review that dismissed them as polish. Code
`TODO`/`FIXME` comments are **forbidden** — deferred work and recorded §12-style gaps go to a tracked GitHub
issue (optionally pointed at from the site by a plain marker-free comment, e.g. `// untestable; tracked in
#NNN`), never a code marker; the `local/no-todo-comments` ESLint rule (`eslint.config.mjs`) enforces this in
the husky pre-commit hook and the CI `pnpm lint` step. The rule is case-sensitive on the uppercase marker, so
the `todo`/`Todo` domain word (the Todo pane) and identifiers like `TODO_UNDO_MS` are unaffected. **The lint
rule scans comment tokens for the uppercase deferral marker only**, so it never flags the two comment kinds
this section allows — a marker-free citation, a hard-to-recover-fact note, or a `// untestable; tracked in
#NNN` pointer passes clean; and on the rare occasion the cited external contract *is* the literal token, an explicit
`// eslint-disable-next-line local/no-todo-comments` permits that one comment (all three shapes are pinned in
`tests/unit/noTodoCommentsLint.test.ts`). When in
doubt, delete: a missing comment costs a code read; a wrong one costs a misled change. Three corollaries close
the loopholes this rule has actually leaked through:

- **A comment that asserts an invariant is evidence of a missing check — enforce it, then delete the
  comment.** Before writing a sentence stating that some condition always holds, make it hold by
  construction: a type, a guard, a `satisfies`, a named test. If it can be enforced, the comment is
  **forbidden**, because the enforcement *is* the documentation and the only form that fails when violated.
  A comment is the last resort for an invariant no mechanism in the language or the test suite can hold.
  The motivating defect: `loopStateWriter` carried "*the error reason travels WITH `status: error`*"
  directly above code that gated on `errorReason` instead of on `status` — the comment *was* the invariant,
  and the code quietly violated it while the reader was reassured.
- **A doc-comment must not describe a parameter's domain in prose — put the domain in a named type.**
  A doc-comment is held to the same two cases as any comment and never echoes the signature. It is the only
  artifact here that can rot **silently** — types, names and tests all fail loudly. So when a doc-comment would
  explain what values a `string` may take (`artifact` "names the turn's required output file", `filename`
  is "tree-relative"), that explanation belongs in a type — `ArtifactRef`, `DirRelativeName` — so widening
  the value's meaning breaks compilation instead of quietly falsifying a sentence. Prose about a `string`'s
  domain is a stale comment that has not happened yet.
- **A comment describing a mechanism the current change alters or deletes must be updated or deleted in
  that same change.** Not a courtesy — the mechanism description was already forbidden by this rule, so its
  survival past the mechanism is a violation that was merely latent before. Grep the comment for the
  identifier you just removed.

## An e2e test never boots a process it will not use — the `@ownapp` contract

**A test fixture provisions what the test uses, and nothing it discards.** The e2e's `beforeEach` boots a
real Electron (real PTY, real bash, real renderer) and waits for its first paint. A test that needs a
bespoke environment — a temp `HOME`, a stubbed `PATH`, `CLAUDE_CONFIG_DIR` — cannot use that instance and
launches its own, so booting one for it buys a full startup, and the wait on it, purely to throw away. Tag
such a test **`@ownapp`**: the harness boots nothing and the test boots once.

This is a correctness rule, not a speed one. The waste lands entirely on process startup — the most
contended thing the suite does — and a saturated runner does not fail *loudly*: it fails as a startup that
misses its budget, a whole test past the 60 s ceiling, and a worker that cannot tear down. **A
worker-teardown timeout is not attributed to any test**, so `retries` cannot absorb it: Playwright reports
`1 error was not a part of any test` and exits non-zero with every test green. That is the failure this
rule exists to prevent — a red bar that no test failure explains.

The motivating defect: 147 tests each got a `beforeEach` boot, and 63 of them immediately closed it and
launched their own — **214 Electron boots where 153 would do**, ~40% of them pure discard. Four tests were
worse, leaving the unused instance *running* while they launched one or two more, so a 2-core CI runner
hosted up to three concurrent Electrons for a test that used one. The suite went red with 149 passed, 4
flaky, and 0 failed — the green bar had been true and useless for as long as it took the load to tip.

The general form, and why it earns a standard rather than a code comment: **when a shared fixture is
expensive and only *some* tests can use it, "provision it for everyone" is not the safe default — it is a
load-bearing cost paid by the tests that cannot use it.** Make the fixture opt-out.

## One theme per PR

A branch that accumulates unrelated themes is not reviewable, by a human or by the §27.4 persona fan-out:
reviewer recall falls with surface area while a mechanical per-hunk pass's does not, which is exactly how a
5,782-line, 8-theme branch passed an 11-persona round and then collected 21 valid findings from an
automated reviewer. If a branch grows a second theme, it wants a second PR — or, when the themes genuinely
must land together, a review checkpoint per theme rather than one pass over the accumulated whole. A
friction/churn fix encountered *while doing the theme's work* (below) is **not** a second theme — it is part
of delivering this one cleanly.

## Fixing churn or dev friction you hit while doing a PR's work is REQUIRED in that same PR

Not deferred, not optional. When the work of a PR surfaces friction — a stale standard the change just
falsified, a missing catalog entry for a primitive it introduced, a test harness that fought you, a
hand-rolled thing the change reveals should be shared, a doc that now misleads — resolving it *in this PR*
is mandatory, and actively encouraged beyond the strict minimum. This is not in tension with **One theme
per PR** above: that rule bars *unrelated* themes accumulating; a friction fix is in-theme precisely because
the theme's own work exposed it, and leaving it for "later" is how the next person re-pays the same cost
you just diagnosed. The boundary is the source of the discovery, not the file it touches: friction the
*work encountered* is in scope even when the fix lands in `CLAUDE.md`, a test util, or a neighbouring
module; an unrelated improvement you merely *noticed in passing* is a separate PR. When unsure which side a
change is on, fold it in and say so in the PR body rather than dropping it.
