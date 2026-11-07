# CODE-STANDARDS.md

`CLAUDE.md` carries the one-line imperatives; this file carries each rule's rationale and named
primitive. Cite the section (e.g. "CODE-STANDARDS.md § Shell quoting") in review rather than re-arguing
the design.

## Shared semantics have one definition both sides import

Any classification, identity or serialized vocabulary two sides must agree on lives in one module both
import — never two copies that "obviously agree today". A behaviour-preserving change to one copy must be
unable to desync the other. The boundary is any two sides of one contract, not just main↔renderer: a
writer and a reader of the same on-disk file desync exactly as two processes do, so the predicate that
decides what is legal lives in **one** module. Live instances: `src/shared/occurrence.ts` (dedup identity),
`src/shared/loopStatus.ts` (human-needed classification), `src/shared/audit.ts` (the run-log vocabulary,
its serialize↔parse pair and timeline reconstructor), `src/shared/redCheck.ts` (the red-check report's
path, example and verdict), and `src/shared/shellQuote.ts`.

**A writer of an asset another component reads computes the destination through that component's own
resolver**, never a parallel path literal, pinned by `expect(dest).toBe(resolve…(…))`: `appIconBuild.ts`
writes to `resolveWindowIconPath`, and `exampleAssetsBuild.ts` to `resolveExampleFlowsDir` /
`resolveExampleLoopsV2Dir` and their siblings — the same functions the runtime reads through.

**A set of shipped assets is listed once, in the code that resolves them; every other copy of the list is
derived from it or pinned by a test.** The build copies every entry of that list (`APP_ICONS` in
`appIcon.ts`), the packaging config's entries are checked against the resolver by a test, and a generator
finds its inputs by pattern (`gen-icon` renders every `build/*.svg`) rather than a hand-kept list. A copy
that is neither derived nor tested goes stale silently — a renamed or added asset ships missing or out of
date with every test green.

**When the reader's resolution is precedence-aware, the writer targets a named branch of that order, not
the resolver's result.** A resolver that consults an override chain (repo-local override, else the
user-config copy) answers "where would this be read from *here, now*"; a writer calling it inherits ambient
state, so the same install lands somewhere different depending on the cwd. Name the branch the writer
means, give it its own definition, and let the precedence-aware resolver consume that definition for its
fallback leg. The test that pins it installs **with an override present** — a no-override fixture passes
either way.

**A writer that seeds a directory absent on first run has a RED test that deletes the target's root
first.** A `mkdtemp` fixture pre-creates the destination's parent chain, so a confinement or resolver that
only works when the anchor exists passes every such test while failing on the fresh machine the feature is
for (a jail anchored with `resolveJail(dirname, basename)` returns `null` when `~/.claude` is absent). The
test removes the user-config root (`~/.claude`, the `.agent-terminal` global dir, …) before asserting the
tree is created.

## Tests assert observable behavior, never implementation

A test asserts what a caller can observe: return values, thrown errors, bytes written to the PTY, IPC
payloads on a contract channel, text read back through the shadow buffer's public read path, DOM state the
user can see. It never asserts which private method was called, in what order or how often, an internal
data structure's shape, parser steps, or anything a behaviour-preserving refactor would change. Litmus:
*could a teammate rewrite the unit's internals from scratch and keep the tests green while the observable
behaviour is unchanged?* Implementation-bound tests pass while the system is broken, fail while it is
correct, and turn every refactor into a rewrite that re-encodes the same assumption. Mock-heavy tests,
snapshots of internal structures and assertions that re-spell the source are the usual shapes. Exact byte
sequences are legitimate only where the bytes ARE the contract (`ESC[200~…ESC[201~` paste framing, `\r`
submit).

## Expected results are written independently of the code they check

A table of expected results that tests grade production code against (an oracle fixture) is written from
the requirement, by hand, and never imports the code it checks. An expectation computed by that code
passes whatever the code does, so the test can no longer catch the mistake it exists for. The fixture may
import the contract's types (`src/shared/ipc`), never a classifier, formatter or constant that decides the
answer. Each such fixture is listed in `EXPECTED_RESULTS_FIXTURES` in `eslint.config.mjs`, whose
`no-restricted-imports` block enforces this; `tests/helpers/controllerStatusFixture.ts` (`STATUS_CASES`) is
the shape to copy. A new oracle is added to that list in the change that creates it.

## Test stand-ins speak the protocol through its own module

A test that stands in for one side of the controller protocol (a scripted terminal, a fake controller)
builds every message with `encodeControllerMessage` and the version constants
(`CONTROLLER_PROTOCOL_MAJOR`, `CONTROLLER_PROTOCOL_MINOR`) from `src/shared/controllerProtocol.ts`, never a
typed-in `version: 2`. A typed-in version goes stale silently on the next protocol bump: every copy has to
be found by hand, and a test can keep passing against a message the app no longer sends. A test that only
needs a registered terminal uses `connectScriptedTerminal` (`tests/helpers/scriptedControllerTerminal.ts`).
The exception is a test whose subject *is* the wire format — version negotiation, malformed or fragmented
frames, the parser's accept/reject rules — where the typed-in bytes are the contract; those files are
listed in `WIRE_FORMAT_TESTS` in `eslint.config.mjs`. A `no-restricted-syntax` rule there flags a literal
`version` or `minor` on a message a controller test builds.

## An injection seam names a domain concept, not the shape of what backs it

A dependency injected for testability is part of the unit's public surface, so it names *what* the unit
needs in its own vocabulary — `canEnter(dir): boolean`, `now(): number` — never the primitives that satisfy
it today (`accessSync`/`statSync`, `Date.now`, a concrete tracker's fields). A seam that enumerates library
or syscall shapes leaks the mechanism: the fake re-spells it, so swapping *how* the need is met breaks the
interface and every fake at once. Inject the **narrowest domain predicate** that reaches the otherwise
unreachable branch, cover the real predicate with real fixtures, and gate a genuinely unprovokable case
(a traverse-permission failure that cannot occur as root) with `it.skipIf` rather than widening the seam.
`launchRoot.ts`'s `CanEnter` is the shape to copy. A descriptor with mutually exclusive modes is a
discriminated union, never a flat record with fields dead in some modes — a flat shape lets a caller pass a
dummy the mode ignores. `BundleLocation` (`packaged: true` carries `resourcesPath`; `packaged: false`
carries `appPath`) is the shape to copy.

## Code that acts on a kind handles every kind

When a value names its kind (a discriminated union's tag, a string-literal union, a `kind` field), every place
that turns that kind into behaviour handles every member explicitly: an exhaustive lookup table
(`const X: Record<Kind, …> = { … }`) or a `switch` whose `default` ends in `value satisfies never`. Adding a
member then fails the build at each such site until it is handled. Never write the behaviour of the only member
that exists today and leave the kind unread: that code compiles and passes every test, and the day a second member
lands it silently gets the first one's behaviour. A kind field that nothing reads is the tell.
`SELF_CHECK_ARTIFACT_CHECK` (`src/main/appLoopEngine.ts`) and `SELF_CHECK_LINES` (`src/main/appWorkTurn.ts`) are
the table shape to copy; `writePointer`'s `write satisfies never` (`src/main/activeFlowGate.ts`) is the
`switch` shape.

## Platform branches take the platform as a parameter

CI and the Podman e2e run only on Linux, so a branch decided by reading `process.platform` inline runs its
macOS arm only on a developer's Mac, and the macOS behaviour ends up untested or recorded as a gap. Code
whose behaviour differs by operating system therefore takes the platform as an argument
(`platform: NodeJS.Platform`) and returns the decision — a value, a template, the name of the action to take
— so a unit test passes `'darwin'` and `'linux'` on any host and asserts both. `process.platform` is read
once, at the composition root (`src/main/index.ts`, `src/main/controller.ts`), and handed down.
`applyDockIcon` (`appIcon.ts`), `buildMenuTemplate` (`appMenu.ts`) and `probeShellCommand` are the shapes to
copy.

What remains untested is only the native call that carries the decision out (`window.hide()`,
`tray.setContextMenu(…)`). That code chooses nothing itself: it executes a decision the tested function
returned, and when no layer can drive it, it carries the `// untestable; tracked in #153` comment (CLAUDE.md
TDD exemption). If a reviewer finds an `if (platform …)` in untested glue, that decision belongs in a tested
function instead. Inline `process.platform` reads already in the code stay as they are until a change
touches their branch.

## "Clean" is a claim about an observed, complete, green run

Declaring a change clean, done or ready requires having run the full relevant suite — unit, integration,
`browser`, and the Playwright e2e in the Podman/Xvfb harness (`./scripts/e2e-podman.sh`) — and seen it
pass, with the tally shown. A suite never observed green in a valid environment is worse than none: its
redness gets pre-explained as "the environment" and stops being a signal, which is how a real defect hides
behind a red bar. A failing, unrunnable or broken suite is never normalized or deferred to CI; only when
the Podman harness itself cannot run is it grounds to stop and escalate.

## Untrusted data crosses a boundary as data, never as syntax

Anything crossing a process, shell, or OS boundary into a place the far side interprets is carried as a
structured value — env var, `argv` element, quoted literal — **never concatenated into a string the far
side parses** (CWE-78). Instances: paste-breakout sanitization at the injection seam (§7.5/§9.3), and the
§23.5 launch target crossing the OS boundary as a distinct env value rather than spliced into a command
line. When the boundary is a POSIX shell, the enforcement is the shell-quoting rule below.

A `gh` PR, issue or comment body is free text of any length, so it travels on stdin (`--body-file -`, or
`--input -` for `gh api`), never as an `argv` element: Linux caps one argument at 131,072 bytes. The
`local/no-gh-body-argv` ESLint rule enforces this over `src/` and `scripts/`.

## Git in a checked-out repository — `src/main/gitHardening.ts`, never a second copy

A repository's own config can make git run code during an ordinary local command: a planted `core.fsmonitor`
runs when git refreshes the index, and `core.hooksPath` points git at the repository's hooks. A command-line `-c`
outranks any repository value. So a new `git` call that runs in a checked-out repository leads its argv with
`coreExecHardeningArgs(freshDisabledHooksDir())`, the one source of those overrides, and never writes its own
copy. This is a floor, not complete hardening. Each caller still neutralizes its own command's execution
surfaces (textconv and external diff, filter and merge drivers, and so on), and a call that reaches the network
adds protocol and credential hardening on top. Existing callers stay as they are; this rule governs new work.
The `local/git-hardening` ESLint rule enforces it over `src/`: a call whose first argument is `'git'` must lead
its argv with a spread of `coreExecHardeningArgs(…)` or `bootstrapProtectedArgs(…)`, directly or through a
`const` holding one. Each older caller carries a line-level exemption that states its reason.

## Shell quoting — `src/shared/shellQuote.ts`, never hand-rolled

Any value placed into shell text is quoted through the one shared primitive — generated scripts,
PATH/profile blocks, command lines, pasted paths all route through it (CWE-78). `shellQuote` is lossless —
it only quotes; lossy paste-safety (e.g. C0-control stripping before a drop reaches the prompt, §7.8) is a
separate layer the caller applies *before* quoting, never folded in.

## Confining repo-derived paths — `src/main/confinedPath.ts`, never hand-rolled

Any path derived from repo content is confined before it is walked, opened, or written — the filesystem
twin of the `shellQuote` rule: an inline confinement check is one the *next* callsite will not have, and a
private one is one nobody reuses.

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
must stay renderer-importable.

## Errno narrowing and error messages — `src/main/errno.ts`, never inline

A caught value raises two questions — "which errno?" and "what do I tell the user?" — both answered by one
module. `isErrno(e, code)` narrows `unknown` (a thrown non-`Error` fails closed) against a **closed
`ErrnoCode` union**, not a `string`: every caller selects swallow-vs-rethrow off that value, and a
misspelled code compiles, never matches, and silently turns a handled failure into an escaping one.
`errMsg(e)` is the same rule for the message. Inline casts grow back at every new filesystem callsite. An
unused `ErrnoCode` member is a claim about the code that is not true — widen it only when a caller needs it.

## Tree-walks that must distinguish absent from unreadable — `src/main/dirEntries.ts`

A tree-walk whose emptiness would be a silent DATA problem uses this module: an **absent** directory yields
`[]` (an optional subtree legitimately has no files), an **unreadable** one **throws**. Conflating them is
how a mispackaged bundle plans zero files and reports a *successful install of nothing* — so the install
walk uses it. A best-effort *reader* that treats any failure as "nothing to show" (the todo-template
picker) is a different, correct policy — the rule is not "every readdir routes here."

## Validating an untrusted value that feeds a safety limit — where, and which way it fails

A value read from attacker-plantable persisted state (`.agent-terminal/loop/run-state.yaml`, any on-disk
doc a repo can carry) that feeds a **runaway backstop** — an iteration cap, budget, quota, rate limit — is
validated in two places, and the two are **not redundant** (CWE-20/770).

**Field-local constraints go at the untrusted read boundary; a relational constraint goes at the use
site.** The reader enforces everything judgeable about the value alone — finite, non-negative, integer —
degrading anything else to the safe default. A constraint relating it to another value (`baseline <=
iteration`) belongs where both operands are live; passing the read-boundary gate is not proof it holds.

**The fallback fails TOWARD the limit still firing, never away from it.** When you change how a limit is
computed, re-derive whether out-of-range inputs still fail safe: moving a cap test from `iteration >= cap`
to `iteration - baseline >= cap` flips the safe direction, so a planted baseline larger than `iteration`
(or `NaN` / `±Inf`) makes the backstop **never fire** — unbounded autonomous iteration from one line of
untrusted YAML. Each layer gets its own RED test: the reader over the hostile numeric family (`-1`, `NaN`,
`±Inf`, non-integer), the decision over the relational violation.

## A GitHub read checks that the answer is the one it asked for

`gh` answers whatever its arguments resolve to: a redirected repository, a renamed one, or a default `--repo`
the caller did not intend. So a read of one GitHub object (a pull request, an issue, a comment) checks the
answer's identity before using any field of it: the number it asked for, and a URL in the repository it asked.
An answer that fails either check is refused with a reason naming what was asked, never read as a near miss.
The parser takes what was asked as a parameter, so the check cannot be skipped by a caller. The pattern to copy
is `parseGitHubPullRequest` in `src/main/githubPullRequest.ts`, which also refuses a state, a branch or a
closing ticket it cannot read. Existing reads stay as they are; this rule governs new work.

## An agent-produced artifact contract — one vocabulary, a minimal predicate, a self-check

A **composed prompt that instructs an LLM to produce a serialized artifact a predicate then gates on** is a
*writer* in the shared-semantics contract (`composeReviewAndFixPrompt` writes the round report,
`roundReportProblems` validates it), and it desyncs the same way two copies of a wire format do:

1. **One descriptor feeds both sides.** The disposition set, reviewer statuses and JSON keys live once in
   `src/shared/roundReport.ts`; composer and predicate both read it, and the prompt's few-shot is that
   module's canonical example (`exampleRoundReport(...)`).
2. **The predicate validates the minimal contract, not a rigid layout** — declared sections, full roster,
   each issue's required fields with a disposition from the closed set; never key order, extra fields or
   formatting. Over-constrained, the fake agent passes while a real model's legitimate variation is
   rejected: mocking the VT parser, one layer out.
3. **The artifact is JSON the agent checks itself.** The prompt hands the agent a command running the same
   predicate and has it fix the file until the check passes before signalling done. Free text the predicate
   does not judge lives in a file nothing parses. A hand-written grammar over Markdown yields a new valid
   edge case every round (fences, indented code, emphasis), never a repeat, so the spinning check cannot
   see it; JSON removes the class.

## Independent-lifecycle state lives in its own file, disjoint from any wholesale-rewritten document

A flag whose set/clear lifecycle is **independent** of a larger persisted document is stored in its own
file — never as a field of that document — so a wholesale write of the document is *structurally* unable to
clobber or resurrect it. The loop keeps `run-state.yaml`, `armed-interrupt.yaml` and `polish.yaml` disjoint
under `<repo>/.agent-terminal/loop/`. As a field, the flag would be lost or carried stale by any path that
rebuilds and writes a fresh document (two obligations, only one visible in the diff), and resurrected by a
stale in-memory copy written back after the flag was cleared elsewhere. Disjointness answers only "a
sibling's write can't move this flag", not "this flag expires correctly". Pin it both ways (as
`appLoopState.test.ts` does): **writing the document leaves the flag file byte-for-byte untouched, and
clearing the flag leaves the document byte-for-byte unchanged.**

## The app never modifies the user's `.gitignore`

Whether to ignore or commit a path is the user's VCS decision, not the app's. App-owned files
(`flow-state.yaml`, the audit pointer, `todos.json`, anything under `.agent-terminal/`) are written where
the spec puts them, but the writing code **never** creates, appends to, or edits `.gitignore` to "protect"
them — a per-file entry is redundant where the directory is already ignored, and unwanted churn besides
(§19.1/§25). RED-first tests for any app-owned persistence MUST assert the write **creates no `.gitignore`**
and leaves a pre-existing one **byte-for-byte unchanged**.

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
the wrong one. **For a destructive or outward-facing action this is a data-loss defect:** a bootstrap
conflict answered against whatever repo the user has since `cd`'d into wipes the wrong branch and closes
the wrong PR. `wireAppBootstrapConflict` binds to the `repoKey` and `step` the message carries, never to a
`repoKey()` it looks up for itself.

## Published snapshots have explicit ownership and isolate consumers

An API that returns or publishes a state snapshot MUST define who owns the value. A consumer MUST NOT
be able to mutate the producer's state or another consumer's view through that snapshot, including its
nested objects and arrays — otherwise one consumer editing a nested title changes retained state and every
other subscriber's delivery. Detached copies or enforced immutability both satisfy this rule; a shallow
copy or a TypeScript `readonly` annotation alone does not protect shared mutable values at runtime. The
contract applies equally to direct reads and subscription deliveries. Tests mutate a returned or delivered
nested value and confirm later reads and other subscribers are unchanged, allowing either mechanism.

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
inspection/snapshot pipeline, not parallel implementations of the same conflict semantics. Install
examples (a one-use `previewId` over a source/target hash snapshot) and bootstrap conflict resolution
(repository, branch, ref object ids and PR ids, with ref deletion conditional on the expected object id)
are the two live instances.

## An action a receiver can refuse is a two-way request; the UI holds its collected input open until the reply confirms

One-way dispatch plus a state-pull is correct only when the near side can know the outcome from state it
already owns. When success depends on state only the receiver holds — a runner mid-turn, a gate that has
already raced out, a lock — a one-way send leaves the sender to guess, and the reflexive guess ("assume it
landed, close the UI") discards the operator's typed input on the exact refusal it was meant to survive.
Model such an action as a two-way request that returns the outcome (`ipcRenderer.invoke`/`ipcMain.handle`),
and keep the input-collecting UI open until the reply: close on success; on refusal keep the entered value
and show why. `flow:appRequestChanges` and the feedback composer are the live instance. Litmus: if the
operation can fail on receiver-only state *and* the near side holds input a drop would lose, a one-way
channel is a data-loss defect.

**A value more than one surface can change has one owner — the side that applies it to the real thing — and
every surface shows only what that owner reports.** The owner may be main (a window property), a terminal
process (state the controller only mirrors), or the loop runner (run state). Each surface asks the owner for a
change as a two-way request; the owner applies it, persists it if it persists, replies with the value it now
holds, and pushes that value to every other surface. A surface displays the owner's reply or push, never its
own guess, so two surfaces cannot disagree. Two races decide correctness: a push that arrives before a
surface's first read replies is newer than that reply and wins, and a refused or failed request leaves the
surface on the last value the owner reported. Always-on-top is the live instance: `controllerAlwaysOnTop.ts`
owns it in main, and the window switch (`alwaysOnTopControl.ts`) and the tray item both request it. A value
with a single surface that cannot be refused (the controller theme) needs none of this.

## A best-effort or cosmetic side effect must never abort the critical path it sits on

Anything observe-only or decorative — the Dock icon, the §25 audit record, fire-and-forget telemetry — is
wrapped so a failure inside it cannot propagate into its caller; a `setIcon` throw that aborts window
creation turns the entire e2e bar red with no product cause. Litmus: if this effect threw, would a feature
the user depends on stop working? If yes, isolate it (try/catch leaving a sensible default, or a
non-throwing boundary) and, where it matters, record the failure.

### Name the calls that throw

The rule is unfalsifiable until you name the calls that throw. Every `fs.*Sync`, `execFileSync`/
`spawnSync`, `realpathSync`, `JSON.parse`, and `fs.watch` throws on inputs a hostile or merely untidy
filesystem can produce; **on a best-effort path each is wrapped, with a RED-first test that provokes the
throw.** Two that read as safe and are not: `rmSync(p, { force: true })` suppresses only `ENOENT` — it
still throws `EISDIR` on a directory and `EPERM` on a locked path; and a `postinstall` that shells out to
`bash` fails the entire `pnpm install` where `bash` is not on `PATH`. If you cannot name a new filesystem or
subprocess call's failure modes, you have not finished writing it.

### A caught value is `unknown`, never an `Error`

`(e as Error).message` yields `undefined` for a thrown string, a rejected object, or anything a dependency
throws that is not an `Error` — so the one place whose job is to explain the failure explains nothing.
Always coerce: `` const reason = e instanceof Error ? e.message : String(e) ``. An error surfaced with an
empty reason has been swallowed as thoroughly as one never caught.

## Every async failure is caught where it arises, at every boundary, and its reason travels on

A `try` covers only the code that runs before it returns. A throw inside a `.then`, a timer, an emitter or
socket handler, or a native module's callback runs after every enclosing `try` has gone, so it reaches
nothing but the process's unhandled-rejection or uncaught-exception path: in the main process, a crash or
an error dialog with no product cause. So:

1. **At the earliest point.** Each async boundary that can fail has its own handler, where the failure
   arises: every promise the code starts or receives ends in a handler, and every callback handed to a
   timer, emitter, socket or native module catches its own failures. None relies on a caller's `try`. A
   promise-returning function the code does not own (an injected seam, a callback) is called inside the
   handler's `try`, or inside an `async` wrapper, because it can throw before it returns a promise. A
   function declared `async` cannot.
2. **At every point.** A handler's own work is a boundary too: a `.then` after a `.catch`, a listener a
   publisher calls, or a fallback that is computed. Make that work total, by isolating each listener and
   catching inside the fallback, rather than stacking catches no test can reach. Code that cannot throw
   needs no handler, and you name why it cannot, as "Name the calls that throw" above requires.
3. **The reason travels on, in the form its context needs.** A handler never discards what failed (use
   `errMsg(error)`):
   - **The user's next action depends on it.** Surface it with a retry or back-out path (the rule below).
   - **It is an outcome a caller or the §25 log must tell apart.** Return a value that names each outcome
     and carries the detail (`{ ok: false, detail }`).
   - **It is a best-effort or cosmetic value.** Fall back to its unavailable state and record the reason
     with `console.error`. For a polled read, record it once per distinct failure, so a read that keeps
     failing the same way logs once and logs again after it recovers.
   - **A failure that is the expected answer is not an error.** Examples: git's non-zero exit on a
     detached HEAD or outside a repository, or `ENOENT` where absence is normal. Narrow to exactly that
     case (`isErrno`, an exit code) and return the answer; let every other failure through with its
     reason.

The RED test provokes the failure at each boundary: a rejection, a throw before the promise exists, and a
throw inside the handler's own work, such as a subscriber. It asserts the fallback and the recorded reason.
Vitest fails a run on an unhandled rejection, so an escape fails the test even where no assertion is reached.

## Never silently swallow an error whose consequence is a state the user cannot recover from

The opposite of the best-effort rule above: there, a failure in an *inessential* effect must be contained;
here, a failure on the *critical path itself* must never be dropped. An `{ok:false}` result, a caught
exception, an early-return guard — if it means the system did not do what the user asked and now sits in a
state they can't see or fix by clicking, it MUST surface (an error the UI presents) and MUST leave the flow
in a state the user can retry or back out of. A swallowed "no agent at the prompt" check injects a work
prompt into a bare shell, and the user sees nothing happen. Silent early-returns on the critical path must
each be provably harmless or surfaced. **If you are unsure whether a swallowed error can strand the user,
ask the operator — do not guess.**

## Never allow an unrecoverable state to occur

A state is unrecoverable when the user cannot get back to a good state through the UI without external
surgery (hand-editing `flow-state.yaml` or loop state, running `git`/`gh` by hand, restarting the app to
clear stuck in-memory state). Design every operation so that on failure it **rolls back to the prior good
state or forward to one with a visible next action** — never a dead end. A failed bootstrap reverts the
flow (§27.10) rather than leaving it half-advanced, and a stuck turn stops in a first-class `error` status
with a retry affordance (§27.12) rather than hanging. When a change could introduce a path with no UI route
out — or when you cannot tell whether one exists — **stop and ask the operator before building it.**

## The policy authorizing a destructive operation is checked at the operation, not at the prompt

A confirmation flag records that *a human said yes*; it does not record that *the policy permits the act*.
Check both where the act happens, in that order, and hard-fail the policy before any prompt is raised —
otherwise a caller that arrives with the flag already set performs a wipe the policy forbids (a branch
deleted and its PR closed regardless of `on_conflict`, because the policy was consulted only on the path
that *asked*). The confirm-first rule for hard-to-reverse and outward-facing actions stands on top of this,
not instead of it.

## An outward side effect that writes more than once runs every refusal before its first write

A gate effect that makes several outward writes (a push, then a PR, then a comment) decides every refusal it
can before it makes the first one: the state of the branch on GitHub, whether its PR exists, whether the
comment fits. A refusal discovered between two writes leaves a half-published result on GitHub that the next
attempt must reconcile, and the operator sees a partial outcome nothing in the app named. Read what the
refusals need once, in the check phase, and have the write phase use that answer instead of reading it again.
A write can still fail on its own; that failure is reported, and a retry finds the earlier writes and continues
from them. `publish-pr-review` (`src/main/publishPrReview.ts`) is the reference.

## Every entry in the run log must be true

The §25 audit log is read afterwards as a statement of fact — "we showed a confirmation", "we skipped this
step", "this step failed" — so a wrong entry misleads its reader into believing something that never
occurred.

- **Never record something that didn't happen**, and never omit something that did — no "confirmation
  shown" for a run that blocked and showed nothing, no cancelled review logged as a success.
- **Never use one entry for two different outcomes.** If "skipped on purpose" and "tried and failed" write
  the same entry, the log cannot tell them apart; nor may a follow-up failure be recorded as the main
  action failing.

The code must be able to tell the outcomes apart: when a yes/no cannot (two outcomes both count as "yes"),
return a value that names each outcome and choose the entry from it — the epic-promotion gate returns
`EpicGateOutcome` and records "confirmation shown" only on `preview-raised`, with a block recorded as a
distinct kind. RED-test both directions: the entry appears when the outcome happened, and is absent when a
different one did — a bug that writes the entry every time passes a one-direction test.

## Comments state ONLY what the code cannot

If a fact is recoverable by reading the code, commenting it is forbidden. The test is mechanical: *could a
reader delete this comment, read only the code, and recover the same fact?* If yes, **delete it.** That bars
narration (restating a line, signature, type, data structure, control-flow step, name) **and** any
description of the *current mechanism*, which drifts the instant the mechanism changes — a
behaviour-preserving refactor must never be able to falsify a surviving comment. **The default is no
comment.** Exactly two kinds are allowed:

- **A citation of an authority outside this repository** — WCAG / WAI-ARIA, a CWE, an RFC, a wire or
  terminal protocol (OSC 7/133, bracketed-paste framing), a third-party file format or API (git's rebase
  instruction sheet, Playwright's `page.evaluate` serialization). **The citation is the whole comment**: a
  gloss beside it rots while the citation stays true. **Nothing inside this repository is cited from code**
  — not the spec (save the exception below), not `CLAUDE.md` or the standards files, not another module,
  not issue or PR text, and never a loop flow document (plan, groomed ticket, impl-report — not committed,
  so the citation points at nothing after merge). An in-repo rule that matters at a site is held there by a
  type, a name or a test, which a reader finds and which fails when the rule is broken.
- **A fact near impossible, or very expensive, to recover from the code** — one that needs running the
  system, reading third-party source, or history to find: an implicit coupling no type, name, test or
  assertion can catch, or a reason the obvious simpler code is wrong that only an observed failure revealed.
  A few minutes of reading, even across files, does not qualify. **A bare spec citation (`§n`) qualifies
  here and only here**: when the code's behaviour is set by a clause a reader could otherwise find only by
  reading the whole spec. Even then, first try to make the fact unbreakable in code and comment only the
  residue, stating **what breaks if it is violated**, never how the code currently works.

Doc-comments meet the same bar. This standard governs new and changed code; a change that touches an
existing comment brings it into line. Code `TODO`/`FIXME` comments are **forbidden** — deferred work goes to
a tracked GitHub issue, optionally pointed at by a marker-free `// untestable; tracked in #NNN`. The
`local/no-todo-comments` ESLint rule enforces this in the pre-commit hook and CI `pnpm lint`; it is
case-sensitive on the uppercase marker, and where a cited external contract *is* the literal token, an
explicit `// eslint-disable-next-line local/no-todo-comments` permits that one comment. When in doubt,
delete: a missing comment costs a code read; a wrong one costs a misled change. Three corollaries:

- **A comment that asserts an invariant is evidence of a missing check — enforce it, then delete the
  comment.** A type, a guard, a `satisfies`, a named test is the documentation that fails when violated; a
  comment beside code that quietly violates its own stated invariant reassures the reader while the code
  is wrong.
- **A doc-comment must not describe a parameter's domain in prose — put the domain in a named type**
  (`DestRelativePath`, `ConfinedPath`), so widening the value's meaning breaks compilation instead of
  silently falsifying a sentence.
- **A comment describing a mechanism the current change alters or deletes is updated or deleted in that
  same change.** Grep for the identifier you just removed.

## An e2e test never boots a process it will not use — the `@ownapp` contract

**A test fixture provisions what the test uses, and nothing it discards.** The e2e's `beforeEach` boots a
real Electron and waits for its first paint. A test that needs a bespoke environment (a temp `HOME`, a
stubbed `PATH`, `CLAUDE_CONFIG_DIR`) launches its own, so it is tagged **`@ownapp`** and the harness boots
nothing for it. The canary at the top of `app.spec.ts` (`expect(harnessBooted).toBe(false)`) fails a test if
a `beforeEach` regresses to booting unconditionally.

This is a correctness rule, not a speed one. Wasted boots land on process startup — the most contended
thing the suite does — and a saturated runner fails as a missed startup budget, a test past the 60 s
ceiling, and a **worker that cannot tear down**. A worker-teardown timeout belongs to no test, so `retries`
cannot absorb it: Playwright reports `1 error was not a part of any test` and exits non-zero with every test
green. Generally: when a shared fixture is expensive and only *some* tests can use it, make it opt-out and
pin the opt-out.

## An e2e test that checks what the screen shows gets there by pressing the control

When an e2e test asserts what the UI shows after an action, it takes that action through the UI: it presses
the control, types into the field, picks the option. Calling the preload API directly (`window.flow.*`,
`window.term.*`) skips the renderer's own path from the press to the repaint, so the test can pass while the
control is broken, or fail because the screen was never told to repaint. The Restart test in `app.spec.ts`
flaked for exactly that reason until it pressed the strip's Advance control. Calling the API remains fine for
setup the assertion does not depend on, such as bringing a run to the step under test. Existing tests stay
as they are; this rule governs new work.

## Test runs own their GUI windows through cleanup

Before a GUI test or native verification run launches anything, establish how it will identify and
clean up its own windows and child processes on success, failure and interruption. Ownership includes
any Terminal wrapper used to start the run. A shell command exiting is not proof of cleanup: Terminal
can retain the finished window, leaving the operator to identify and close test leftovers.

Close only the exact resources owned by the run, never all Terminal/Electron windows, unrelated
processes or the operator's sessions. Verify that no owned windows or processes remain before reporting
completion. If a launch mechanism cannot provide ownership and cleanup, use one that can; do not rely
on the operator to clean up or change their global Terminal preferences to hide the problem.

## One theme per PR

A branch that accumulates unrelated themes is not reviewable, by a human or by the §27.4 persona fan-out:
reviewer recall falls with surface area while a mechanical per-hunk pass's does not, so a many-theme branch
passes persona review and then collects valid findings from an automated reviewer. If a branch grows a
second theme, it wants a second PR — or, when the themes must land together, a review checkpoint per
theme. A friction/churn fix encountered *while doing the theme's work* (below) is **not** a second theme.

## Fixing churn or dev friction you hit while doing a PR's work is REQUIRED in that same PR

Not deferred, not optional. When the work of a PR surfaces friction — a stale standard the change just
falsified, a missing catalog entry for a primitive it introduced, a test harness that fought you, a
hand-rolled thing the change reveals should be shared, a doc that now misleads — resolving it *in this PR*
is mandatory. A friction fix is in-theme precisely because the theme's own work exposed it; leaving it for
"later" is how the next person re-pays the same cost. The boundary is the source of the discovery, not the
file it touches: friction the *work encountered* is in scope even when the fix lands in `CLAUDE.md`, a test
util, or a neighbouring module; an unrelated improvement you merely *noticed in passing* is a separate PR.
When unsure, fold it in and say so in the PR body.
