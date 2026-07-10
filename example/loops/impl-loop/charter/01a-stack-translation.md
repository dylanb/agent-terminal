### Translate your standards into this repository's stack — before you review

Your lane's named standards, exemplar calls, error codes, and idioms are drawn from whichever ecosystems make them concrete. **They are not a checklist for one language.** The failure classes are invariant; the calls, the error values, the conventions and the tooling are not. Before you read a line of the diff, spend a few minutes on this pass.

1. **Identify the stack.** Language(s), runtime, package manager, build and test tooling, the frameworks in the changed paths. Read the repo's standards file (`CLAUDE.md` / `AGENTS.md` / `CONTRIBUTING.md`) and at least one source file neighbouring the diff. What the neighbours do *is* the local idiom.
2. **Map every named standard and exemplar in your SKILL onto its local equivalent.** Write the mapping down for yourself. Where an exemplar has no direct analogue, find the call, construct, or artifact that plays its role here — the class still applies. A lint rule, a sink, a syscall, a test runner, a schema format: each has a counterpart or a considered reason it has none.
3. **Learn the repository's error and failure convention.** Whether failures are raised, returned as values, signalled on a channel, delivered as an asynchronous event, or encoded in a result type determines what an *unhandled* one looks like here. An ignored `err` in Go, an empty `catch` in TypeScript, a bare `except: pass` in Python and a discarded `Result` in Rust are one finding wearing four costumes. Look for the local costume.
4. **Record what genuinely does not apply, and why.** A standard with no counterpart in this stack is dropped with a reason — never silently skipped, and never reported as the repository's fault.

**This pass is orientation, not output.** It changes what you look for; it does not change what you emit. Do not add it to the JSON, do not narrate it in findings, and do not spend the iteration on it — the review is the deliverable.

Two failure modes it exists to prevent, both of which have shipped:

- **Reporting the absence of the exemplar instead of finding the local one.** "This repo does not use `rmSync`" / "there is no OpenAPI document here" / "these aren't Go packages" is not a review. Find what this repo uses instead, and review that.
- **Letting the translation soften you into abstraction.** A generic finding ("filesystem operations may fail", "the API surface could drift") is not a finding, because nothing can be done with it and nothing can falsify it. Having translated, be *more* concrete, not less: name the actual call in this diff, the actual failure its runtime produces, and the actual state it leaves behind.
