# UI Development Standards — Agent Terminal

How we build renderer UI. **Atomic** (build from small, individually-tested units up) and
**relocatable** (large compositions move between layouts without an implementation change).

This document is binding for everything under `src/renderer/`. It does not override the
authoritative spec (`terminal-web-ui-spec.md`) or the TDD rules in `CLAUDE.md` — it refines
them for UI. On conflict: spec wins on *what the UI does*; this doc and CLAUDE.md govern *how
it's built and tested*. Cite section anchors here (e.g. "UI §2.3") the way we cite spec `§n`.

Related spec sections: **§22.4** layout-as-data (the relocatability boundary), **§16.8**
cross-highlight (cross-component signalling done right), **§9.1** the monitor pane's
talk-only-to-`window.monitor.*` rule (the existing precedent for a stable interface).

---

## 1. The component model — Atoms · Molecules · Organisms

Three tiers. A component's tier is defined by what it's allowed to depend on, not by how
big it looks.

### 1.1 Atoms
The smallest indivisible units. Pure presentation: given inputs, they produce DOM; they hold
no app/domain state and know nothing about IPC, the session, or where they sit.

- Examples: pill button, badge, status dot, hairline divider, `kbd` hint, eyebrow label.
- Styled **only** through `tokens.css` custom properties (§22.4) — no hard-coded color, no
  layout assumptions, both themes for free.
- No timers, no subscriptions, no `window.*` access.

### 1.2 Molecules
A small assembly of atoms with **one** responsibility. May own local UI state (open/closed,
hover, a tick) but no domain coupling beyond its declared prop/event interface.

- Examples: gate control (approve / request-changes pair + its state), status strip, a flow
  step, the quick-send input row, a finding row.
- `statusStrip` is the model molecule: it owns its `last`/`alive` state and 1 s tick, and its
  doc-comment already states the rule — *"Talks to nothing but its host element."*

### 1.3 Organisms
Larger compositions that own a coherent feature area and are **relocatable** — these are the
units §22.4 moves between frames. Their interface is a contract (UI §2).

- Examples: artifact explorer, terminal pane, capture / findings panel, todo board,
  quick-send drawer.
- An organism may compose molecules and atoms, and may depend on declared services (e.g.
  `window.monitor.*`), but only through its explicit interface.
- **Organisms never import from sibling organisms.** Cross-organism behavior goes through the
  contract (UI §2.2), never DOM reach-across.

---

## 2. The stable-interface contract (relocatability)

The whole point: **the artifact explorer (and every organism) can be placed in any frame —
left rail, main, docked drawer — with zero change to its implementation.** "Relocatable" is
not a claim; it's a passing test (UI §3.3).

### 2.1 Declare the entire dependency surface, explicitly and typed
Every organism is a factory with a typed interface — the pattern already in the codebase:

```ts
export interface ArtifactExplorer {
  setArtifacts(items: Artifact[]): void;     // input
  onOpen(cb: (id: string) => void): void;    // output
  reveal(id: string): void;                  // input (cross-highlight, §16.8)
  dispose(): void;
}
export function createArtifactExplorer(
  host: HTMLElement,                          // the only DOM it may touch
  deps: { monitor: MonitorApi },             // declared services, injected
): ArtifactExplorer { /* … */ }
```

The interface IS the contract. Inputs (methods/props), outputs (callbacks/events), and
required services (injected `deps`) are all named. Nothing reaches outside it.

### 2.2 The hard rules an organism must obey to be relocatable
1. **It touches only its host element and that element's subtree.** No `document.querySelector`
   into siblings, no global IDs, no assuming a parent class exists. **Every node it creates or
   inspects comes from `host.ownerDocument`** — `createElement`, `createTextNode`,
   `activeElement`, `getSelection`, … — **never the ambient global `document`.** A relocated
   organism lives in a different document (another frame/process); the global `document` is not
   its own. Idiom: `const doc = host.ownerDocument;` at the top of the factory, then `doc.*`.
2. **It assumes nothing about its size, position, or neighbors.** It fills the bounded region
   it's handed and is responsive within it. No fixed positioning tied to one frame.
3. **Services are injected, never reached for.** Take `deps` as a parameter; do not import a
   concrete `window.monitor` / store / sibling directly. (This is §9.1 generalized.)
4. **Cross-component signalling goes through the contract.** Cross-highlight (§16.8) between
   terminal and capture is a `reveal(id)` call / event on each organism's interface — not one
   organism poking the other's DOM. Both can be visible at once *because* neither depends on
   the other's placement.
5. **Theming via tokens only.** All color/spacing from `tokens.css`; light + dark must both
   work with no per-placement override.
6. **Clean teardown.** `dispose()` removes every listener, timer, and node it created, so an
   organism can be unmounted from frame A and mounted in frame B without leaks.

### 2.3 Frames are dumb
A layout/frame's job is to hand each organism a container and wire the declared contract. A
frame contains **no** organism business logic — if moving a component between frames requires
editing the component, the contract has leaked and must be fixed before merge.

---

## 3. Testing — every component tested individually

Per `CLAUDE.md`: **RED-first, no exceptions**, and tests assert **observable behavior, not
implementation**. The litmus stays the same — a teammate must be able to rewrite a component's
internals and keep your tests green. For UI that means asserting rendered DOM the user can see,
attributes/ARIA, emitted events, and bytes/IPC on the contract — never private method calls,
internal structure, or class-name spelling that a refactor would change.

### 3.1 Atoms & Molecules — DOM-level unit tests
- vitest + `// @vitest-environment jsdom`, driving the **real** DOM (no shadow/PTY mocks; that
  ban from CLAUDE.md still holds for any component that wraps a core).
- Assert: rendered text/state, ARIA, that the declared events fire with the right payload.
- Mount the component into a detached host element, exercise its interface, assert the output —
  exactly the shape of the existing `statusStrip` / `captureTab` tests.

### 3.2 Organisms — DOM unit **plus** e2e
- Everything in §3.1, **and** a Playwright `_electron` test that mounts the organism for real
  (real rendering, both themes), since pixel/layout truth isn't observable in jsdom.

### 3.3 The relocation test (mandatory for organisms)
An organism's relocatability is only true when a test proves it. Mount the **same** organism,
**unchanged**, in **two different placements** and run the **same** behavioral assertions
against both:

```
mount(createArtifactExplorer, frameA-host)  → behavioral assertions pass
mount(createArtifactExplorer, frameB-host)  → same assertions pass, zero impl change
```

If the assertions need different setup per placement beyond "a different host element + the
same wired contract," the contract has leaked — fix the component, not the test.

**The two-placement test alone does NOT catch a global-`document` reach — give it teeth.**
jsdom (and the DOM spec) **auto-adopts** appended nodes: a node created via the global
`document` and then appended into a host re-acquires that host's `ownerDocument`. So if both
placements live in the same (global) document, the assertions pass *even when the organism
reached for the global* — a test that's green while the rule (§2.2.1) is broken. Asserting
`ownerDocument` after render is for the same reason **not** sufficient. To make the latent reach
observable, mount into a host in a **foreign document** with the global document node factories
(`createElement` **and** `createTextNode` — every ambient-global factory §2.2 forbids) **poisoned to
throw**:

```
function foreignDocWithHostileGlobal(): Document {
  const foreign = document.implementation.createHTMLDocument('relocated');
  const hostile = (factory) => () => {
    throw new Error(`organism reached for the ambient global document.${factory} instead of its host`);
  };
  vi.spyOn(document, 'createElement').mockImplementation(hostile('createElement'));
  vi.spyOn(document, 'createTextNode').mockImplementation(hostile('createTextNode'));
  return foreign;                       // restore the spies in afterEach
}
// const host = foreign.createElement('div'); mount the organism on it, drive a render,
// then assert the visible DOM appears in `host` — a clean organism renders, a reaching one throws.
```

A clean organism renders from `host.ownerDocument` regardless; one that touches the global
produces nothing. Reference implementation: `tests/unit/relocatable.test.ts`.

---

## 4. Conventions

- **Factory shape.** `createX(host: HTMLElement, deps?): X` returning a typed interface with a
  `dispose()`. No default-exported god objects.
- **One component per file**, named for the component; its test is `tests/unit/<name>.test.ts`
  (organisms add `tests/e2e/<name>.spec.ts`).
- **Comments carry invariants, not narration** (CLAUDE.md). A one-line "talks only to its host"
  invariant earns its place; a play-by-play does not.
- **No new magic numbers.** Timings/dimensions that the spec names stay named and configurable
  (§7.1/§8.2/§9.3).

## 5. Definition of done (per component)
- [ ] Correct tier, and obeys that tier's dependency limits (UI §1).
- [ ] Typed interface; all inputs/outputs/services on it (organisms: UI §2.1).
- [ ] Touches only its host subtree; builds DOM from `host.ownerDocument`; services injected, not reached for (UI §2.2).
- [ ] Styled via `tokens.css`; light + dark both correct.
- [ ] `dispose()` leaves nothing behind.
- [ ] RED-first DOM unit tests of observable behavior (UI §3.1).
- [ ] Organisms: e2e + a relocation test against a foreign-document host with a hostile global `document` (UI §3.2–3.3).
