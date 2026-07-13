# CODE-STANDARDS.md

The **Code standards** section of `CLAUDE.md` carries the enforceable one-line imperatives; this file
carries each rule's rationale, its motivating defect, and the named primitive that satisfies it. When a
`CLAUDE.md` bullet links here, this file is the authority — cite the section (e.g. "CODE-STANDARDS.md §
Shell quoting") in review rather than re-arguing the design. Nothing here is new: these are the same
rules, with the depth that does not need to sit in every turn's context.

## Untrusted data crosses a boundary as data, never as syntax

Anything that crosses a process, shell, or OS boundary into a place where the far side interprets it is
carried as a structured value — an env var, an `argv` element, a quoted literal — and is **never
concatenated into a string the far side parses**. The existing instances are this rule applied at
specific boundaries: paste-breakout sanitization at the injection seam (§7.5/§9.3) and the §23.5 launch
target crossing the OS boundary as a distinct env value rather than spliced into a command line
(CWE-78). When the boundary is a POSIX shell specifically, the enforcement is the shell-quoting rule
below.

## Shell quoting — `src/shared/shellQuote.ts`, never hand-rolled

Any value placed into shell text is quoted through the one shared primitive: generated scripts,
PATH/profile blocks, command lines, and pasted paths all route through it (the shared-semantics rule;
CWE-78). `shellQuote` is lossless — it only quotes; lossy paste-safety (e.g. C0-control stripping before
a drop reaches the prompt, §7.8) is a separate layer the caller applies *before* quoting, never folded
into the primitive.

## Confining repo-derived paths — `src/main/confinedPath.ts`, never hand-rolled

Any path derived from repo content is confined before it is walked, opened, or written. This is the
filesystem twin of the `shellQuote` rule, and it exists for the same reason: a confinement check written
inline is a check that the *next* filesystem callsite will not have. `resolveJail` names the jail
(resolving the anchor but never the jail's own final segment, so a planted `.agent-loop` symlink cannot
adopt its target as the jail); `confinedRealPath` returns the symlink-free real path or `null`, rejecting
a lexical escape (CWE-22) and a symlink the caller would follow out (CWE-59), and returning the resolved
path so a later swap cannot redirect the read (CWE-367). It is in `src/main/`, not `src/shared/`, because
it needs `node:fs` and `src/shared/` must stay renderer-importable. The motivating defect: `loopDef.ts`
grew a correct confinement for the `exec` gate's artifact paths, kept it private, and `viewerWatch.ts`'s
new directory walker then followed a symlinked root straight back into the inotify exhaustion the walker
existed to fix. A primitive nobody can see is a primitive nobody reuses; absence of a call to a shared
one is visible in review.

## The app never modifies the user's `.gitignore`

Whether to ignore or commit a path is the user's VCS decision, not the app's. App-owned files
(`flow-state.yaml`, the audit pointer, `todos.json`, anything under `.agent-terminal/`) are written
wherever the spec puts them, but the code that writes them **never** creates, appends to, or otherwise
edits `.gitignore` to "protect" them — a per-file ignore entry is redundant in a repo that already
ignores the directory and is unwanted churn besides (§19.1/§25; the todoStore §16.3 is the reference — it
never touched `.gitignore`). RED-first tests for any app-owned persistence MUST assert the write
**creates no `.gitignore`** and leaves a pre-existing one **byte-for-byte unchanged**. This generalizes:
the production system does not silently rewrite a user's tooling config — `.git/`, editor configs, shell
rc files outside the explicit, user-invoked §23.5 install action — to make its own state tidy.

## IPC payloads carry resource identity; the receiver never re-derives it from ambient state

The `sessionId`-on-every-payload rule is one instance of the principle; this is the principle. Ambient
state — the current working directory, the focused repo, the selected pane — moves between the moment a
message is *raised* and the moment it is *answered*, so a receiver that reaches for "the current repo"
instead of reading the repo off the message will eventually act on the wrong one. **For a destructive or
outward-facing action this is a data-loss defect, not a tidiness one:** `flow:onBootstrapConflict`
shipped without a `repoKey`, so a conflict raised for repo A could be answered against whatever repo the
user had since `cd`'d into — and the answer wipes a branch and closes its PR. Bind the handler to the
identity the message carries (`wireBootstrapConflict` takes it injected and has no cwd dependency), never
to a `repoKey()` the handler looks up for itself.

## A best-effort or cosmetic side effect must never abort the critical path it sits on

Anything observe-only or decorative — setting the Dock icon, writing the §25 audit record, any
fire-and-forget telemetry — is wrapped so a failure inside it cannot propagate into its caller. The §25
audit recorder already states this ("never throws into the flow path"); the rule is general, because the
inverse is exactly how a cosmetic failure (a `setIcon` throw that aborted `createWindow` before the
window existed) once turned the *entire* e2e bar red with no product cause. The litmus: if this effect
threw, would a feature the user actually depends on stop working? If yes, the effect is on the critical
path by accident — isolate it (try/catch that leaves a sensible default, or a non-throwing boundary) so
its failure is contained and, where it matters, recorded. This is the robustness dual of the TDD
evidence rule: don't let an inessential effect manufacture a red bar that masks — or mimics — a real one.

### Name the calls that throw

The rule is unfalsifiable until you name the calls that throw, so here they are. Every `fs.*Sync`
(`rmSync`, `statSync`, `mkdirSync`, `readdirSync`, `writeFileSync`, `openSync`), `execFileSync`/
`spawnSync`, `realpathSync`, `JSON.parse`, and `fs.watch` throws on inputs a hostile or merely untidy
filesystem can produce. **On a best-effort path each one is wrapped, and each wrap needs a RED-first test
that provokes the throw.** Two options that read as safe and are not: `rmSync(p, { force: true })`
suppresses only `ENOENT` — it still throws `EISDIR` on a directory and `EPERM` on a locked path
(`clearTurnDone` on the injection path, and the `state.yaml.tmp` pre-clean, both stranded the loop this
way); and a `postinstall` guard that shells out to `bash` fails the entire `pnpm install` on any machine
where `bash` is not on `PATH`. If you cannot name the three failure modes of a new filesystem or
subprocess call, you have not finished writing it.

### A caught value is `unknown`, never an `Error`

`catch (e) { ...(e as Error).message }` yields `undefined` for a thrown string, a rejected promise
carrying an object, or anything a dependency throws that is not an `Error` — so the one place whose job
is to explain the failure explains nothing. Always coerce: `` const reason = e instanceof Error ?
e.message : String(e) ``. This is the mirror of the swallowing rule below: an error surfaced with an
empty reason has been swallowed just as thoroughly as one never caught.

## Never silently swallow an error whose consequence is a state the user cannot recover from

The opposite of the best-effort rule above: there, a failure in an *inessential* effect must be contained
so it can't abort the critical path; here, a failure on the *critical path itself* must never be dropped.
An `{ok:false}` result, a caught exception, a guard that returns early — if it means the system did not do
the thing the user asked and now sits in a state they can't see or fix by clicking, it MUST surface (an
error the UI presents) and MUST leave the flow in a state the user can retry or back out of. The
motivating defect: the loop orchestrator injected a work-agent prompt into a bare shell because the "no
agent is at the prompt / not injectable" condition was swallowed (only an `exit 1` audit line) — the user
saw nothing happen, and the only "recovery" was quitting the agent and scrolling shell history to find
the leaked prompt. Silent early-returns on the critical path are the shape this takes; every one must
either be provably harmless or be surfaced. **If you are unsure whether a swallowed error can strand the
user, ask the operator — do not guess.**

## Never allow an unrecoverable state to occur

A state is unrecoverable when the user cannot get back to a good state through the UI without external
surgery (hand-editing `state.yaml`/`flow-state.yaml`, deleting `.agent-loop/`, running `git`/`gh` by
hand, restarting the app to clear stuck in-memory state). Design every operation so that on failure it
**rolls back to the prior good state or forward to one with a visible next action** — never a dead end.
This is why a failed bootstrap reverts the flow (§26.9) rather than leaving it half-advanced, and why a
stuck turn stops in a first-class `error` status with a retry/impasse affordance (§26.3/D48) rather than
hanging. When a change could introduce a path with no UI route out — or when you cannot tell whether one
exists — **stop and ask the operator before building it.**

## The policy authorizing a destructive operation is checked at the operation, not at the prompt

A confirmation flag records that *a human said yes*; it does not record that *the policy permits the
act*. Check both where the act happens, in that order, and hard-fail the policy before any prompt is
raised — otherwise a caller that arrives with the flag already set performs a wipe the policy forbids.
`loopPickup` shipped this way: `wipeConflict: true` deleted the branch (and closed its PR) regardless of
whether `on_conflict` was `wipe-and-retry`, because the policy was consulted only on the path that
*asked*. The confirm-first rule for hard-to-reverse and outward-facing actions stands on top of this, not
instead of it.

## Comments state ONLY what the code cannot

If a fact is recoverable by reading the code, commenting it is forbidden. The test is mechanical and
absolute: *could a reader delete this comment, read only the code, and recover the same fact?* If yes,
**delete the comment.** That covers narration (restating a line, a signature, a type, a data structure, a
control-flow step, a variable name) **and** any description of the *current mechanism* — mechanism
descriptions drift the instant the mechanism changes, and a behavior-preserving refactor must never be
able to falsify a surviving comment (the stale "single carried slot" sitting beside a per-repo map is the
canonical failure this rule exists to kill). A comment earns its place by carrying a fact that originates
**outside the code it annotates** and that the code therefore cannot hold. Exactly two kinds qualify:

- **An external contract or authority.** A spec clause (`§n`), a web standard criterion (WCAG /
  WAI-ARIA), a wire or terminal protocol (OSC 7/133, bracketed-paste framing), an external file-format or
  API schema (the agent-loop `state.yaml` vocabulary), or a fixed product/workflow constraint ("injects
  nothing; the human drives agent-loop by hand"). **Cite it — never re-explain it in prose.** The
  citation is the whole comment; a paragraph restating what the spec says is narration of an external doc
  and is forbidden. **Mechanically: a comment carrying a `§n`/CWE/WCAG citation contains the citation and
  nothing that paraphrases the cited text.** If a reader needs the section, they open the spec. A citation
  followed by a prose gloss is the shape every stale comment in this repo has taken — the citation stays
  true while the gloss rots beside it.
- **A cross-module coupling this codebase cannot express through an abstraction.** An implicit dependency
  between two deep modules where a future edit on one side would silently break the other **and no type,
  name, test, or assertion can catch it.** This is the *only* license to mention anything internal — and
  it is conditional: first try to make the coupling unbreakable in code (a shared type, a precise name, a
  pinning test). Comment only the residue no abstraction can hold, and state **what breaks if the coupling
  is violated**, never how the code currently works. "Outside the system" extends this far and no
  further: across a deep module boundary inside this repo, only when omission risks a break no abstraction
  would catch.

Everything else goes. Prefer a precise name, a named test, or a `§n` citation over any sentence. `//
TODO(owner): …` tags and recorded §12-style gaps are always allowed. When in doubt, delete: a missing
comment costs a code read; a wrong one costs a misled change. Three corollaries close the loopholes this
rule has actually leaked through:

- **A comment that asserts an invariant is evidence of a missing check — enforce it, then delete the
  comment.** Before writing a sentence stating that some condition always holds, make the condition hold
  by construction: a type, a guard, a `satisfies`, a named test. If it can be enforced, the comment is
  **forbidden**, because the enforcement *is* the documentation and it is the only form that fails when
  violated. A comment is the last resort for an invariant no mechanism in the language or the test suite
  can hold. The motivating defect: `loopStateWriter` carried "*the error reason travels WITH `status:
  error`*" directly above code that gated on `errorReason` instead of on `status` — the comment was not
  describing the invariant, it *was* the invariant, and the code quietly violated it while the reader was
  reassured.
- **A doc-comment must not describe a parameter's domain in prose — put the domain in a named type.**
  Doc-comments on exported identifiers are allowed and must add the caller-facing contract (obligations,
  external invariants), never echo the signature. But a doc-comment is the only artifact here that can rot
  **silently**: types, names, tests and `§n` citations all fail loudly. So when a doc-comment would
  explain what values a `string` may take (`artifact` "names the turn's required output file", `filename`
  is "tree-relative"), that explanation belongs in a type — `ArtifactRef`, `DirRelativeName` — so that
  widening the value's meaning breaks compilation instead of quietly falsifying a sentence. Prose about a
  `string`'s domain is a stale comment that has not happened yet.
- **A comment describing a mechanism the current change alters or deletes must be updated or deleted in
  that same change.** Not a courtesy — the mechanism description was already forbidden by this rule, so
  its survival past the mechanism is a violation that was merely latent before. Grep the comment for the
  identifier you just removed.

## One theme per PR

A branch that accumulates unrelated themes is not reviewable, by a human or by the §26 persona fan-out:
reviewer recall falls with surface area while a mechanical per-hunk pass's does not, which is exactly how
a 5,782-line, 8-theme branch passed an 11-persona round and then collected 21 valid findings from an
automated reviewer. If a branch grows a second theme, it wants a second PR — or, when the themes
genuinely must land together, a review checkpoint per theme rather than one pass over the accumulated
whole.

### Exception

It is actively encouraged to eliminate the cause of churn and to improve the context of the repository to
make future work bore efficient and higher quality: therefore, changes in the PR that achieve this goal, for
example, new standards or tweaks to existin standards or agent context files are absolutely allowed and
encouraged as long as the content and the changess can be justified and are high quality.
