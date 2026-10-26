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
- Styled **only** through `src/renderer/src/tokens.css` custom properties (§22.4) — no hard-coded color, no
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
   into siblings, no global IDs, no assuming a parent class exists.
2. **It assumes nothing about its size, position, or neighbors.** It fills the bounded region
   it's handed and is responsive within it. No fixed positioning tied to one frame.
3. **Services are injected, never reached for.** Take `deps` as a parameter; do not import a
   concrete `window.monitor` / store / sibling directly. (This is §9.1 generalized.)
4. **Cross-component signalling goes through the contract.** Cross-highlight (§16.8) between
   terminal and capture is a `reveal(id)` call / event on each organism's interface — not one
   organism poking the other's DOM. Both can be visible at once *because* neither depends on
   the other's placement.
5. **Theming via tokens only.** All color/spacing from `src/renderer/src/tokens.css`; light + dark must both
   work with no per-placement override. A new colour value is defined only as a token in
   `src/renderer/src/tokens.css`, never in a component rule, and a controller pane-status colour uses the
   `--status-*` tokens. Colours already hard-coded in component rules stay as they are; this
   governs new work.
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

### 3.2b Anything about a painted pixel — the `browser` project, never a CSS parser
Colour, contrast, the focus ring, scrolling, clipping, reflow at a zoom or a small viewport: jsdom
computes none of it, and a regex over `styles.css` re-implements the cascade (specificity, document
order, `var()`, `color-mix()`, group or ancestor `opacity`) — the same class of error as mocking the VT
parser, and CLAUDE.md bans it outright: an approximated cascade keeps the suite green over a control that
has lost its focus ring (WCAG 2.2 SC 1.4.11). These assertions go in the **`browser` vitest project**
(`tests/browser/`, real Chromium), which mounts the **real component** and reads `getComputedStyle`
/ real box metrics; the test does the WCAG arithmetic (`tests/helpers/wcag.ts`) and nothing else.
The Playwright e2e is the other valid home. A pin that cannot fail for its own regression is worse
than none — mutation-probe it: reintroduce the defect and watch it go red.

**A design token is read through `tests/helpers/tokenProbe.ts`, never a hand-rolled probe**, and
compared against the expected values in `tests/helpers/designTokens.ts`. A second `var()` probe, or a
second way to tell an undefined token from a defined one, drifts from the first. A token added to
`src/renderer/src/tokens.css` is added to `designTokens.ts` by hand — never generated from the stylesheet,
which would make the check compare the sheet with itself.

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

### 3.4 How a UI test reads the screen
§3's litmus asks two questions of every UI test: **what wrong implementation would still pass it,
and what correct implementation would fail it?** A test with an answer to either is not done. The
rules below are the answers reviewers find most often. Each holds in jsdom, the `browser` project and
the e2e alike.

1. **Find elements by role and accessible name**, the way assistive technology does (the Testing
   Library query priority): `getByRole('button', { name })`, a heading by its role, a status by its
   text. Never by tag (`button`, `h1…h6`), class, `id`, a single naming attribute (`aria-label` alone),
   or how the text is split into elements. Each component's tests go through **one** helper, and every
   query in it shares one matcher, so a `role="button"` element is found everywhere or nowhere.
2. **Check inside the element that owns the fact.** Read a card's status from that card's status row,
   not the whole host or page, whenever the same word can appear elsewhere (a header count, a label,
   an activity line). A pattern that a neighbouring element can satisfy proves nothing.
3. **Read painted or measured state after it settles**: `expect.poll` or `vi.waitFor`, never in the
   same task as the render, publish or click that changes it. When a component measures (at render, in
   a `ResizeObserver`, on the next frame) is its own business. A state that must hold across time (still
   hidden, still open after an update) is held for at least two animation frames before it is checked.
4. **Choose test data that can tell the cases apart.** Every count and value a test compares is
   different from the others, so two cannot be swapped unnoticed. Include the boundary itself (exactly
   the limit, not only under and over it), the opposite direction (a connected card is *not* dashed), and
   more than one item where the rule is per item (two reasons in one box).
5. **A check fails when it finds nothing to check.** A walk over painted text or controls lists what it
   must grade and reports each one it did not find; it never passes because nothing was rendered. Every
   state a check grades actually renders in its fixture. A long reason is there if the "Show full reason"
   control's contrast is graded.
6. **Grade every pairing that is actually painted.** Each text against each background it sits on,
   tints and controls included. Each non-text indicator (accent, border, focus ring) against every colour
   it touches (WCAG 2.2 SC 1.4.3, 1.4.11).
7. **No conditional assertions.** A fixture is deterministic, so an `if` around an `expect` only hides
   the check when it should fail.
8. **When a behaviour changes, rewrite the old test from the new requirement.** A carried-over test
   that still checks the old behaviour (the full directory visible, when the new rule cuts it) fails a
   correct implementation and passes only the old one.

---

## 4. Transient announcements — the WAI-ARIA Alert pattern

A component that surfaces a transient, attention-demanding message (an alert bar, a toast, a
status banner that must reach assistive tech the moment it appears) follows the Alert pattern.
Getting this wrong by reaching for the obvious `[hidden]` toggle silently breaks screen-reader
announcement and can create a focus trap. The rules:

1. **The live-region host is permanent and never toggled.** Set `role="alert"` +
   `aria-live="assertive"` (WCAG 4.1.3) on a host that is always in the DOM. **Never** hide it
   with `[hidden]`/`display:none`/unmount — a region that comes and going does not re-announce
   reliably.
2. **Re-announce by emptying and refilling the host**, not by toggling visibility. Clearing its
   children (`replaceChildren()`) and inserting new content is what fires the next announcement;
   collapse the empty host visually with `:empty` in CSS, not by hiding the element.
3. **An empty live region must have no focusable descendants**, so emptying it can never strand
   focus on a hidden-but-focusable control (spec §22.2). Filling it with a focusable (e.g. a
   dismiss button) is fine *because* emptying removes that focusable.
4. **Mount it in an always-visible region.** A live region nested under a frame that can itself be
   hidden can be suppressed out from under you; put it where no ancestor toggle can mask it.
5. **Preserving focus across a subtree rebuild restores it through the shared primitive (WCAG 2.4.3).**
   When a teardown or an in-place rebuild removes the node that held focus, the component captures
   whether focus was inside the rebuilt container *before* the rebuild and lands it on the freshly-built
   replacement *after* — but only if focus has not since moved away (it is on `<body>`, blurred there by
   the rebuild, or still inside the container), never pulling focus in when it was elsewhere and never
   stealing focus the user redirected. Compose `captureSubtreeFocus` (`dom.ts`); never hand-roll the
   capture/guard. When a component empties its host with no replacement to land on, focus must not
   strand on `<body>`: either it signals across its contract (an `onFocusLost`-style callback) so the
   root re-places focus, or a caller contract guarantees focus is moved out *before* the emptying call —
   and the emptying entry point says which. A component never reaches across organisms to move focus
   itself (UI §2.2).
6. **A control that disables itself during an async action restores focus on completion (WCAG 2.4.3).**
   Capture focus *before* disabling and return it *after* — but only if focus has not since moved:
   restore iff the control still holds focus or was blurred to `<body>` by the disable, never stealing
   focus the user redirected mid-action. Compose `captureFocusReturn` (`dom.ts`); never hand-roll the
   guard — two copies drift, the same reason `createModalShell` is a single implementation (UI §5).

## 5. Blocking dialogs — the modal focus-management pattern

A component that demands a decision before the user can proceed (a destructive confirmation, a
required typed-input prompt) is a **blocking dialog** — the inverse of the §4 Alert pattern. An
alert *announces* and must never trap focus; a dialog *traps* focus until dismissed. Confusing the
two breaks keyboard and screen-reader users in opposite ways, so the boundary is explicit: §4 is
for transient announcements, §5 is for blocking decisions.

The focus management here (WCAG 2.4.3 focus order, 4.1.2 name/role/value) is subtle and identical
across every dialog, so it is defined **once** and composed, never re-derived:

1. **Compose the shared modal shell; never hand-roll focus management.** There is exactly one
   implementation of the scrim + focus-trap + focus-restore (`createModalShell`); a new dialog
   supplies only its card body and actions. This is the §9.1 / `src/shared` single-definition rule
   applied to dialog accessibility — two hand-rolled focus traps *will* drift, and the drift is
   invisible until a keyboard user hits it.
2. **Identify the dialog to assistive tech.** `role="dialog"` (or `alertdialog` for a system-raised alert — errorDialog) + `aria-modal="true"` +
   `aria-labelledby` (the title node) and, when there's body copy, `aria-describedby` (the message
   node). The label/description come from real rendered nodes, not duplicated string attributes.
3. **Move focus in on open; trap and wrap Tab; Escape closes.** Focus lands on the dialog's
   declared initial control (or the dialog container when none), Tab/Shift-Tab cycle only the
   dialog's focusables and wrap at the ends, and the scrim click and Escape both dismiss.
4. **Restore focus to the opener on close (WCAG 2.4.3).** The shell records whatever was focused
   when the dialog opened and returns focus there on close — the user is put back where they were.
5. **`dispose()` tears down WITHOUT restoring focus.** Closing (user dismissal) and disposing
   (unmount / relocation, UI §2.2 rule 6) are different contracts: `close()` restores focus to the
   opener; `dispose()` just clears the host subtree, because on relocation there is no opener to
   return to. An organism that owns a dialog must expose both.
6. **Accept and dismiss are different doors.** `close` is the *dismiss* path and fires `onDismiss`;
   the build's `confirm` is the user's *affirmative* action and does not. Accepting through `close`
   fires the caller's retraction against the very operation it is starting — the success path then
   announces the cancellation into its own live region (WCAG 4.1.3). The shell owns this: never
   re-hand-roll a `confirmed` flag to work around it. The callback is named for the *event*, not the
   mechanism — calling it "onClose" is what invited a consumer through the wrong door.
7. **A long body scrolls in the card, and never pushes the footer off-screen.** The card is a flex
   column with a `max-height`. A card whose body can outgrow it returns `grow` (the chain that
   absorbs the leftover column height) and `scroll` (the one box that scrolls) **on its `ModalCard`**;
   the shell applies them. Two things that box must never do, and neither is visible to a pin that
   only checks the footer: **collapse to zero height** (a `flex:1 1 auto; min-height:0` body will,
   leaving controls focusable but unpainted — focus lands where nothing is drawn, WCAG 2.2 SC 2.4.11),
   and **clip the focus ring of a control it scrolled into view** (scroll-into-view aligns the border
   box with the clip edge, and the ring paints outside it — `scroll-padding`). The shell styles only its
   own structural classes and slot attributes, never an organism's class names (UI §2.3).
8. **Nothing switches the view while a dialog is open.** A view switch `display:none`s a whole
   viewpane — including one a dialog may be hosted in — tearing focus out of the open dialog; and a
   hidden dialog is still IN the document, so it can never be reached to close, wedging the app
   behind the scrim (WCAG 2.4.3, 2.1.1). The guard lives on the shell's `setView` itself, not on its
   callers, so every caller is covered, and it shares ONE "a dialog is open" predicate with the
   loop-panel's Escape deference — two copies disagree about which roles count.

**Every** blocking dialog composes `createModalShell`; this doc keeps no list of them, because the
composer a list omits is the one that drifts. A dialog is tested like any organism
(§3.2–3.3) **plus** assertions for items 2–8 above: the ARIA wiring, Tab wrapping in both directions, Escape/scrim dismissal,
focus-restored-to-opener, accept-is-not-dismiss, and (if its body can overflow) the §3.2b painted
pins for scroll and footer reachability.

## 6. Conventions

- **Factory shape.** `createX(host: HTMLElement, deps?): X` returning a typed interface with a
  `dispose()`. No default-exported god objects.
- **One component per file**, named for the component; its test is `tests/unit/<name>.test.ts`
  (organisms add `tests/e2e/<name>.spec.ts`).
- **Comments carry invariants, not narration** (CLAUDE.md). A one-line "talks only to its host"
  invariant earns its place; a play-by-play does not.
- **No new magic numbers.** Timings/dimensions that the spec names stay named and configurable
  (§7.1/§8.2/§9.3).

## 7. Definition of done (per component)
- [ ] Correct tier, and obeys that tier's dependency limits (UI §1).
- [ ] Typed interface; all inputs/outputs/services on it (organisms: UI §2.1).
- [ ] Touches only its host subtree; services injected, not reached for (UI §2.2).
- [ ] Styled via `src/renderer/src/tokens.css`; light + dark both correct.
- [ ] `dispose()` leaves nothing behind.
- [ ] RED-first DOM unit tests of observable behavior (UI §3.1).
- [ ] Organisms: e2e + a passing relocation test in ≥2 placements (UI §3.2–3.3).
- [ ] Any claim about a painted pixel (colour, contrast, focus ring, scroll, clip, reflow) pinned in the `browser` project or the e2e — never by parsing CSS (UI §3.2b).
- [ ] Its tests read the screen by role and name through one helper, check inside the owning element, wait for painted state to settle, and use test data that tells the cases apart (UI §3.4).
- [ ] If it rebuilds a subtree that can hold focus: composes `captureSubtreeFocus`/`captureFocusReturn` (`dom.ts`), never a hand-rolled capture/guard (UI §4 items 5–6).
- [ ] If it announces transient messages: follows the Alert pattern — permanent host, empty-to-re-announce, no focusable when empty, focus restored on dismiss (UI §4).
- [ ] If it blocks for a decision: composes `createModalShell` — `role="dialog"` (or `alertdialog`)/`aria-modal`, labelled + described, Tab trapped and wrapping, Escape/scrim close, focus restored to opener on close, `dispose()` tears down without restoring (UI §5).
- [ ] …and answers it through the right door: the build's `confirm` for the user's affirmative action, `close` **only** for a dismissal. `close` fires `onDismiss`, so accepting through it retracts the very operation being started — the success path then announces the cancellation (WCAG 4.1.3). Never re-hand-roll a `confirmed` flag; the shell owns this.
