import { userEvent, page } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/renderer/src/styles.css';
import { createInstallExamples } from '../../src/renderer/src/installExamples';
import { createStatusBar, type StatusBar } from '../../src/renderer/src/statusBar';
import type { StatusBarModel, StatusBarTitle } from '../../src/shared/statusBar';
import type { DestRelativePath, InstallExamplesPreview, InstallExamplesResult } from '../../src/shared/ipc';
import { createFeedbackComposer } from '../../src/renderer/src/feedbackComposer';
import { parseColor as parse, compositeOver as over, contrastRatio as contrast, ringOver, type RGBA } from '../helpers/wcag';

// WCAG contrast pins for the renderer's tokens and controls. The locked "Galley · Lit" mood keeps
// bright accent hues, so dedicated `--*-text` tokens carry the accessible foreground (memory
// wcag-overrides-locked-mood). Chromium resolves the cascade, `var()` and `color-mix()`; the
// assertions below do only the WCAG 2.1 arithmetic on the values it paints.

/** The colour actually behind `el`: its own background composited down the ancestor chain to the
 *  first opaque layer, exactly as the compositor stacks them. */
function paintedBg(el: Element): RGBA {
  const layers: RGBA[] = [];
  for (let n: Element | null = el; n; n = n.parentElement) {
    const c = parse(getComputedStyle(n).backgroundColor);
    layers.push(c);
    if (c[3] === 1) break;
  }
  if (layers[layers.length - 1][3] !== 1) throw new Error('no opaque backdrop beneath probe');
  return layers.reduceRight((bg, fg) => over(fg, bg));
}
/** A group `opacity` composites everything the element paints — the browser-drawn focus ring
 *  included — so the ring's alpha is the product of every opacity above it. */
function paintedAlpha(el: Element): number {
  let a = 1;
  for (let n: Element | null = el; n; n = n.parentElement) a *= Number(getComputedStyle(n).opacity || '1');
  return a;
}

/** The surface a `:focus-visible` ring is painted against. With `outline-offset`, the ring sits OUTSIDE
 *  the element's border box, so what shows through beneath it is the parent's paint — not the element's
 *  own background. Grading the ring against the element's own fill is the wrong backdrop for any control
 *  that has one. */
function paintedBgBehindRing(el: Element): RGBA {
  const parent = el.parentElement;
  if (!parent) throw new Error('probe has no parent to paint its offset focus ring against');
  return paintedBg(parent);
}
/** The painted colour of el's focus ring: its outline colour at ITS OWN alpha, further scaled by every
 *  group opacity above it, composited over the surface behind the offset ring. A ring made translucent by
 *  `outline-color` alone (the `color-mix(…, transparent)` idiom this stylesheet uses) is washed out on the
 *  screen exactly as one under a group `opacity` is; grading only the group alpha reads it as opaque. */
function focusRing(el: HTMLElement): RGBA {
  return ringOver(getComputedStyle(el).outlineColor, paintedAlpha(el), paintedBgBehindRing(el));
}

let card: HTMLElement;

/** A probe subtree on an opaque `--card` backdrop — the surface every control below sits on. */
function mount(html: string): HTMLElement {
  card.innerHTML = html;
  return card.firstElementChild as HTMLElement;
}
/** Read a token's resolved colour without disturbing whatever the test has mounted. */
function token(name: string): RGBA {
  const probe = document.createElement('span');
  probe.style.color = `var(${name})`;
  card.appendChild(probe);
  try {
    return parse(getComputedStyle(probe).color);
  } finally {
    probe.remove();
  }
}
const fg = (el: Element): RGBA => parse(getComputedStyle(el).color);

/** Tab until the probe holds focus, because `:focus-visible` need not match a programmatic `focus()` and
 *  the probe need not be the first focusable in the subtree. */
async function tabToProbe(el: HTMLElement): Promise<void> {
  for (let i = 0; i < 10 && document.activeElement !== el; i++) await userEvent.tab();
  if (document.activeElement !== el) throw new Error('probe did not take keyboard focus');
  if (!el.matches(':focus-visible')) throw new Error('probe focused but :focus-visible did not match');
}

for (const theme of ['light', 'dark'] as const) {
  describe(`${theme} theme`, () => {
    beforeEach(() => {
      document.documentElement.setAttribute('data-theme', theme);
      card = document.createElement('div');
      card.style.background = 'var(--card)';
      document.body.replaceChildren(card);
    });
    afterEach(() => {
      document.documentElement.removeAttribute('data-theme');
    });

    describe('status-text token contrast (WCAG 1.4.3 AA)', () => {
      for (const tone of ['signal', 'pass', 'attn'] as const) {
        it(`--${tone}-text clears 4.5:1 on --card`, () => {
          expect(contrast(token(`--${tone}-text`), token('--card'))).toBeGreaterThanOrEqual(4.5);
        });
      }
    });

    describe('control text contrast (WCAG 1.4.3 AA)', () => {
      it('.pill.signal text clears 4.5:1 on --card (modal Confirm button)', () => {
        const el = mount(`<button class="pill signal">Confirm</button>`);
        expect(contrast(fg(el), paintedBg(el))).toBeGreaterThanOrEqual(4.5);
      });

      // #26 AC13: the Terminate confirm button's text sits on the button's OWN --danger fill, not
      // --card. In dark theme --danger is a light salmon, so a fixed white foreground would fail.
      it('.pill.danger text clears 4.5:1 on its own --danger fill (Terminate confirm button)', () => {
        const el = mount(`<button class="pill danger">Terminate</button>`);
        expect(contrast(fg(el), paintedBg(el))).toBeGreaterThanOrEqual(4.5);
      });

      // §7.7 keyboard settings.
      it('.seg-opt.on text clears 4.5:1 on its own background (active profile segment)', () => {
        mount(`<div class="seg"><button class="seg-opt on">Default</button></div>`);
        const el = card.querySelector('.seg-opt.on')!;
        expect(contrast(fg(el), paintedBg(el))).toBeGreaterThanOrEqual(4.5);
      });

      // §7.7: the recording pill's text sits on --signal-wash composited over --card.
      it('.kcapture text clears 4.5:1 on its wash over --card (recording pill)', () => {
        mount(`<div class="kr-chord"><span class="kcapture">Recording</span></div>`);
        const el = card.querySelector('.kcapture')!;
        expect(contrast(fg(el), paintedBg(el))).toBeGreaterThanOrEqual(4.5);
      });
    });

    // §22.3.1. In its attention state the bar paints on a tinted wash, not the plain card — and it shows
    // the title and the activity ALONGSIDE the alert, so every glyph on it is graded against that wash.
    // Driving the real organism: probe markup re-typed here would keep passing through any rename in the
    // renderer, and the wash only exists under `:has(.sb-alert-btn)`, which only the real alert emits.
    describe('status-bar attention state (WCAG 2.1 SC 1.4.3 / 1.4.11)', () => {
      let bar: StatusBar;

      const mountBar = (model: StatusBarModel): HTMLElement => {
        const host = mount(`<div class="status-bar"></div>`);
        bar = createStatusBar(host, {
          githubRef: async () => null,
          openExternal: () => true,
          setTitle: async () => {},
          onAlertActivate: () => {},
          onError: () => {},
          onOpenError: () => {},
          loopPanelId: 'loop-panel',
        });
        bar.render(model, 'repo');
        return host;
      };
      const withAlert = (title: StatusBarTitle): StatusBarModel => ({
        title,
        activity: { phrase: 'Waiting for the agent' },
        alert: { status: 'awaiting-plan-review', iteration: 3, pr: 58 },
      });

      afterEach(() => bar?.dispose());

      it("the alert's focus ring clears 3:1 on the attention wash", async () => {
        const host = mountBar(withAlert({ kind: 'user', text: 'Some work' }));
        const btn = host.querySelector('[data-status-alert]') as HTMLElement;
        await tabToProbe(btn);
        expect(contrast(focusRing(btn), paintedBgBehindRing(btn))).toBeGreaterThanOrEqual(3);
      });

      // Each glyph the bar can paint in this state, graded on the wash it actually sits on.
      const ON_WASH: ReadonlyArray<readonly [StatusBarTitle, string, string]> = [
        [{ kind: 'user', text: 'Some work' }, '.sb-name', 'a named title'],
        [{ kind: 'user', text: '' }, '.sb-name.empty', 'the unnamed-title placeholder'],
        [{ kind: 'user', text: 'Some work' }, '.sb-activity .phrase', 'the activity phrase'],
        [{ kind: 'user', text: 'Some work' }, '.sb-alert-btn b', "the alert's lead"],
        [{ kind: 'user', text: 'Some work' }, '.sb-alert-btn .it', "the alert's status detail"],
      ];
      for (const [title, sel, what] of ON_WASH) {
        it(`${what} (${sel}) clears 4.5:1 on the attention wash`, () => {
          const el = mountBar(withAlert(title)).querySelector(sel) as HTMLElement;
          expect(contrast(fg(el), paintedBg(el))).toBeGreaterThanOrEqual(4.5);
        });
      }
    });

    // The Install button stays focusable while busy (aria-disabled + aria-busy) so the progress
    // announcement reaches a keyboard user still standing on it. A group `opacity` there would
    // alpha-composite the browser-drawn focus ring along with the label.
    describe('busy pill focus ring contrast (WCAG 2.1 SC 1.4.11)', () => {
      it("the busy pill's focus ring clears 3:1 on --card", async () => {
        const el = mount(`<button class="pill signal" aria-disabled="true" aria-busy="true">Installing…</button>`);
        await tabToProbe(el);
        expect(contrast(focusRing(el), paintedBgBehindRing(el))).toBeGreaterThanOrEqual(3);
      });

      it("an idle pill's focus ring clears 3:1 on --card", async () => {
        const el = mount(`<button class="pill signal">Install examples</button>`);
        await tabToProbe(el);
        expect(contrast(focusRing(el), paintedBgBehindRing(el))).toBeGreaterThanOrEqual(3);
      });

      // The ring sits outside the border box (outline-offset), so it is painted on the surface BEHIND the
      // control, not the control's own fill. A filled pill makes the two genuinely different colours; a
      // grader that used the fill would be judging the wrong backdrop. This pins that they differ and the
      // ring is graded on the one behind.
      it("a filled pill's ring is graded on the surface behind it, not its own fill", async () => {
        const el = mount(`<button class="pill app">Install</button>`);
        await tabToProbe(el);
        const own = paintedBg(el);
        expect(own[3]).toBe(1); // .pill.app carries an opaque fill
        expect(paintedBgBehindRing(el)).not.toEqual(own);
        expect(contrast(focusRing(el), paintedBgBehindRing(el))).toBeGreaterThanOrEqual(3);
      });

      it('the busy pill still reads as busy — its label differs from the idle pill\'s', () => {
        const idle = fg(mount(`<button class="pill signal">Install examples</button>`));
        const busy = fg(mount(`<button class="pill signal" aria-disabled="true">Installing…</button>`));
        expect(busy).not.toEqual(idle);
        expect(busy).toEqual(token('--dim'));
      });
    });

    // The consent checkboxes are the only decision controls in the install dialog, and one of them takes
    // initial focus. The global ring rule matches `button`/`a`/`[tabindex]` — an `input` matches none of
    // them, so without a rule of its own the control falls back to the UA ring.
    describe('install consent checkbox focus ring contrast (WCAG 2.1 SC 1.4.11)', () => {
      it("a consent checkbox's focus ring clears 3:1 on the surface behind it", async () => {
        const row = mount(
          `<div class="install-consent-opt"><label class="ic-label"><input type="checkbox"><span class="ic-name">Loop definitions — 2 files</span></label><span class="ic-files">a.yaml, b.yaml</span></div>`,
        );
        const box = row.querySelector('input') as HTMLElement;
        await tabToProbe(box);
        expect(contrast(focusRing(box), paintedBgBehindRing(box))).toBeGreaterThanOrEqual(3);
      });
    });

    // §20.2 code viewer: the editor paints onto --bg (the board), and a changed line adds --changed-wash
    // over it. Code text, the gutter's line numbers, and every syntax class are small text, so all clear
    // 4.5:1 on BOTH surfaces — themed via tokens, since the library default is tuned for light only.
    describe('code viewer text contrast (WCAG 1.4.3 AA)', () => {
      const GLYPHS = [
        ['cm-editor', 'code text'],
        ['cm-gutters', 'gutter line numbers'],
        ['cm-syn-keyword', 'keyword'],
        ['cm-syn-string', 'string'],
        ['cm-syn-comment', 'comment'],
        ['cm-syn-number', 'number'],
        ['cm-syn-func', 'function'],
        ['cm-syn-type', 'type'],
        ['cm-syn-var', 'variable'],
        ['cm-syn-punct', 'punctuation'],
      ] as const;
      for (const [cls, name] of GLYPHS) {
        it(`.${cls} (${name}) clears 4.5:1 on the viewer background`, () => {
          const el = mount(`<div class="vbody" style="background:var(--bg)"><span class="${cls}">x</span></div>`).querySelector('span')!;
          expect(contrast(fg(el), paintedBg(el))).toBeGreaterThanOrEqual(4.5);
        });
        it(`.${cls} (${name}) clears 4.5:1 on a changed line's wash`, () => {
          const el = mount(
            `<div class="vbody" style="background:var(--bg)">` +
              `<div style="background:var(--changed-wash)"><span class="${cls}">x</span></div></div>`,
          ).querySelector('span')!;
          expect(contrast(fg(el), paintedBg(el))).toBeGreaterThanOrEqual(4.5);
        });
      }
    });

    // With the loop panel open, each spill tone sits on its own wash over the expanded read-out's
    // background over the card. A read-out that stacks its OWN wash under the spill's would put the
    // text on a failing doubled wash, so the real backgrounds are composited to discriminate that.
    describe('expanded loop read-out contrast (WCAG 1.4.3 AA)', () => {
      for (const tone of ['await', 'work', 'settle'] as const) {
        it(`.spill.${tone} text clears 4.5:1 when the read-out is expanded (panel open)`, () => {
          mount(
            `<div class="flowstrip"><div class="loopstat" aria-expanded="true">` +
              `<span class="spill ${tone}"><span class="pdot"></span>x</span></div></div>`,
          );
          const el = card.querySelector(`.spill.${tone}`)!;
          expect(contrast(fg(el), paintedBg(el))).toBeGreaterThanOrEqual(4.5);
        });
      }
    });
  });
}

// The consent step lists every conflicting file inline, and the loops destination enumerates the whole
// bundle — dozens of paths. A card that grows past the viewport in a centred, position:fixed modal is
// CLIPPED, not scrolled: the footer holding Cancel and Install goes off-screen with no way to reach it,
// so the dialog becomes unoperable by any input method (WCAG 2.1.1 / 2.4.3).
//
// This drives the REAL organism rather than hand-written probe markup. A probe that re-types the DOM is a
// pin that cannot fail: it kept passing while the app's own fieldset silently refused to scroll, and it
// would keep passing through any class rename in the renderer.
describe('install consent dialog stays operable with a long file manifest', () => {
  let host: HTMLElement;

  beforeEach(async () => {
    host = document.createElement('div');
    document.body.replaceChildren(host);
    const files = Array.from({ length: 60 }, (_, i) => `some-loop/nested/dir/file-${i}.yaml`) as DestRelativePath[];
    createInstallExamples(host, {
      preview: async (): Promise<InstallExamplesPreview> => ({
        ok: true,
        destinations: [
          { destination: 'flow', conflict: false },
          { destination: 'loops', conflict: true, files },
          { destination: 'skills', conflict: false },
          { destination: 'commands', conflict: false },
        ],
      }),
      apply: async (): Promise<InstallExamplesResult> => ({ ok: true, created: [], overwritten: [], skipped: [] }),
    });
    (host.querySelector('.kprofile button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(host.querySelector('.flow-modal .card')).not.toBeNull());
  });

  const cardEl = (): HTMLElement => host.querySelector('.flow-modal .card') as HTMLElement;

  it('keeps the footer actions inside the viewport', () => {
    const confirm = host.querySelector('.flow-modal button.confirm') as HTMLElement;
    const r = confirm.getBoundingClientRect();
    expect(r.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(r.top).toBeGreaterThanOrEqual(0);
  });

  it('scrolls the overflowing manifest inside the card rather than clipping the card', () => {
    expect(cardEl().getBoundingClientRect().height).toBeLessThanOrEqual(window.innerHeight);
    // Ask each candidate to SCROLL and see whether it moves. `overflow-y:auto` plus a taller scrollHeight
    // is NOT enough: on a <fieldset> Chromium renders the rows in an anonymous content box and the element
    // never becomes a scroll box, so a check on those two properties alone passes while the content stays
    // unreachable — which is exactly what shipped.
    const scrolls = [...cardEl().querySelectorAll<HTMLElement>('*')].some((n) => {
      if (n.scrollHeight <= n.clientHeight + 1) return false;
      n.scrollTop = 50;
      const moved = n.scrollTop > 0;
      n.scrollTop = 0;
      return moved;
    });
    expect(scrolls).toBe(true);
  });
});

// The card's bound (`max-height:calc(100vh - 48px)`) cannot absorb every viewport: at 200% zoom, or in a
// short window, the unshrinkable header and footer alone can exceed it. Nothing on this branch tested that
// case — every other test runs at full size, where the card fits and the manifest bound is never reached —
// so the whole short-viewport path shipped on an assertion that could not fail.
describe('the consent dialog survives a short viewport (200% zoom / reflow — WCAG 1.4.4, 1.4.10)', () => {
  let host: HTMLElement;

  beforeEach(async () => {
    await page.viewport(512, 384); // 1024x768 at 200% zoom
    host = document.createElement('div');
    document.body.replaceChildren(host);
    const files = Array.from({ length: 60 }, (_, i) => `some-loop/nested/dir/file-${i}.yaml`) as DestRelativePath[];
    createInstallExamples(host, {
      preview: async (): Promise<InstallExamplesPreview> => ({
        ok: true,
        destinations: [
          { destination: 'flow', conflict: false },
          { destination: 'loops', conflict: true, files },
          { destination: 'skills', conflict: false },
          { destination: 'commands', conflict: false },
        ],
      }),
      apply: async (): Promise<InstallExamplesResult> => ({ ok: true, created: [], overwritten: [], skipped: [] }),
    });
    (host.querySelector('.kprofile button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(host.querySelector('.flow-modal .card')).not.toBeNull());
  });

  afterEach(async () => {
    await page.viewport(1280, 896);
  });

  it('does not let the manifest overprint the footer actions', () => {
    const rows = host.querySelector('.install-consent-rows') as HTMLElement;
    const confirm = host.querySelector('.flow-modal button.confirm') as HTMLElement;
    // The rows must stop where the footer begins — a viewport-relative cap cannot know that, so an
    // over-tall manifest escapes the column and paints straight over the buttons.
    expect(rows.getBoundingClientRect().bottom).toBeLessThanOrEqual(confirm.getBoundingClientRect().top + 1);
  });

  it('keeps the footer actions reachable', () => {
    const confirm = host.querySelector('.flow-modal button.confirm') as HTMLElement;
    const r = confirm.getBoundingClientRect();
    expect(r.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(r.top).toBeGreaterThanOrEqual(0);
  });
});

// SC 1.4.10 names 320x256 as the reflow target: a card that outgrows the viewport must reflow into a
// SCROLLABLE modal with every edge reachable by single-axis scroll. `align-items:center` on a scroll
// container positions an overflowing card so its top sits ABOVE the scroll origin, which scroll cannot
// reach; `safe center` pins it to the start instead. The reachability of the top edge — not the modal's
// initial scroll offset, which the browser sets by scrolling the autofocused control into view and so
// varies with font metrics — is the property. Reachable means: at scrollTop 0 the top edge is on-screen.
describe('the consent dialog reflows at 320x256 (WCAG 1.4.10)', () => {
  let host: HTMLElement;

  beforeEach(async () => {
    await page.viewport(320, 256);
    host = document.createElement('div');
    document.body.replaceChildren(host);
    const files = Array.from({ length: 60 }, (_, i) => `some-loop/nested/dir/file-${i}.yaml`) as DestRelativePath[];
    createInstallExamples(host, {
      preview: async (): Promise<InstallExamplesPreview> => ({
        ok: true,
        destinations: [
          { destination: 'flow', conflict: false },
          { destination: 'loops', conflict: true, files },
          { destination: 'skills', conflict: false },
          { destination: 'commands', conflict: false },
        ],
      }),
      apply: async (): Promise<InstallExamplesResult> => ({ ok: true, created: [], overwritten: [], skipped: [] }),
    });
    (host.querySelector('.kprofile button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(host.querySelector('.flow-modal .card')).not.toBeNull());
  });

  afterEach(async () => {
    await page.viewport(1280, 896);
  });

  it('keeps the card top edge reachable — scrolling to the origin brings it on-screen', () => {
    const modalEl = host.querySelector('.flow-modal') as HTMLElement;
    const cardEl = host.querySelector('.flow-modal .card') as HTMLElement;
    modalEl.scrollTop = 0;
    expect(cardEl.getBoundingClientRect().top).toBeGreaterThanOrEqual(-1);
  });

  it('lets the modal scroll to whatever the card cannot fit', () => {
    // Assert the OUTCOME, not the two properties: `overflow-y:auto` plus a taller scrollHeight is exactly
    // the pair this file already documents as insufficient (a <fieldset> satisfies both and never scrolls).
    // Scroll the modal to its end and see whether the button is actually there.
    const modalEl = host.querySelector('.flow-modal') as HTMLElement;
    const confirm = host.querySelector('.flow-modal button.confirm') as HTMLElement;
    modalEl.scrollTop = modalEl.scrollHeight;
    expect(confirm.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight + 1);
    expect(confirm.getBoundingClientRect().top).toBeGreaterThanOrEqual(-1);
  });
});

// `overflow-y:auto` computes `overflow-x` to `auto` too (CSS Overflow L3 §3), so the scroll box clips ink
// on BOTH axes at its padding box. A focus ring is ink OUTSIDE the control's border box, so a checkbox
// flush against the clip edge loses the inline-start stroke of its ring (WCAG 1.4.11).
describe('the consent scroll box does not clip the checkbox focus ring', () => {
  let host: HTMLElement;

  beforeEach(async () => {
    host = document.createElement('div');
    document.body.replaceChildren(host);
    const files = Array.from({ length: 60 }, (_, i) => `some-loop/nested/dir/file-${i}.yaml`) as DestRelativePath[];
    createInstallExamples(host, {
      preview: async (): Promise<InstallExamplesPreview> => ({
        ok: true,
        destinations: [
          { destination: 'flow', conflict: false },
          { destination: 'loops', conflict: true, files },
          { destination: 'skills', conflict: false },
          { destination: 'commands', conflict: false },
        ],
      }),
      apply: async (): Promise<InstallExamplesResult> => ({ ok: true, created: [], overwritten: [], skipped: [] }),
    });
    (host.querySelector('.kprofile button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(host.querySelector('.flow-modal .card')).not.toBeNull());
  });

  const ringOf = (el: HTMLElement): number => {
    const cs = getComputedStyle(el);
    return parseFloat(cs.outlineWidth) + parseFloat(cs.outlineOffset);
  };

  it('leaves room for the ring to paint inside the clip, on the INLINE axis', async () => {
    const rows = host.querySelector('.install-consent-rows') as HTMLElement;
    const box = host.querySelector('.install-consent-opt input[type="checkbox"]') as HTMLElement;
    await tabToProbe(box); // `outline-width` computes to 0 unless :focus-visible actually matches
    const ring = ringOf(box);
    expect(ring).toBeGreaterThan(0);
    expect(box.getBoundingClientRect().left - rows.getBoundingClientRect().left).toBeGreaterThanOrEqual(ring);
  });
});

// The BLOCK axis is the one the box actually scrolls, and it is the axis the inline pin above cannot see.
// Sequential focus navigation scrolls the newly-focused control into view by aligning its BORDER BOX with the
// scrollport edge — so without `scroll-padding`, the ring (which paints OUTSIDE the border box) lands beyond
// the clip and the focus indicator is cut off (WCAG 2.2 SC 2.4.11 Focus Not Obscured; SC 1.4.11). Provoking it
// needs SEVERAL checkboxes and a manifest long enough that reaching a later one must scroll.
describe('the consent scroll box does not clip the focus ring of a control it scrolled into view', () => {
  let host: HTMLElement;

  beforeEach(async () => {
    await page.viewport(900, 300);
    host = document.createElement('div');
    document.body.replaceChildren(host);
    // SHORT manifests: nothing below a checkbox to keep it away from the clip edge, so scroll-into-view
    // really can land its border box flush against the scrollport.
    const files = (n: string): DestRelativePath[] => [`${n}/a.yaml`] as DestRelativePath[];
    createInstallExamples(host, {
      preview: async (): Promise<InstallExamplesPreview> => ({
        ok: true,
        destinations: [
          { destination: 'flow', conflict: true, files: files('flow') },
          { destination: 'loops', conflict: true, files: files('loops') },
          { destination: 'skills', conflict: true, files: files('skills') },
          { destination: 'commands', conflict: true, files: files('commands') },
        ],
      }),
      apply: async (): Promise<InstallExamplesResult> => ({ ok: true, created: [], overwritten: [], skipped: [] }),
    });
    (host.querySelector('.kprofile button') as HTMLElement).click();
    await vi.waitUntil(() => host.querySelector('.flow-modal') !== null);
  });

  afterEach(async () => {
    await page.viewport(1280, 896);
  });

  // A `flex:1 1 auto; min-height:0` body is free to shrink to ZERO when the card's other rows fill its
  // max-height. The controls stay focusable and the box still "scrolls" — it just paints nothing, so a
  // keyboard user is standing on a control that does not exist on screen. The footer-reachability pins
  // cannot see this; only asking whether the box has any height can.
  it('never collapses the options to zero height, however short the viewport', () => {
    const rows = host.querySelector('[data-modal-scroll]') as HTMLElement;
    const box = host.querySelector('.install-consent-opt input[type="checkbox"]') as HTMLElement;
    expect(rows.clientHeight).toBeGreaterThan(0);
    expect(rows.getBoundingClientRect().height).toBeGreaterThanOrEqual(box.getBoundingClientRect().height);
  });

  it('leaves room for the ring on the BLOCK axis for every checkbox, including ones below the fold', async () => {
    const rows = host.querySelector('[data-modal-scroll]') as HTMLElement;
    const boxes = [...host.querySelectorAll<HTMLElement>('.install-consent-opt input[type="checkbox"]')];
    expect(boxes.length).toBe(4);
    expect(rows.scrollHeight).toBeGreaterThan(rows.clientHeight); // it really does have to scroll

    for (const box of boxes) {
      await tabToProbe(box);
      const cs = getComputedStyle(box);
      const ring = parseFloat(cs.outlineWidth) + parseFloat(cs.outlineOffset);
      expect(ring).toBeGreaterThan(0);
      const r = box.getBoundingClientRect();
      const clip = rows.getBoundingClientRect();
      expect(r.top - clip.top).toBeGreaterThanOrEqual(ring);
      expect(clip.bottom - r.bottom).toBeGreaterThanOrEqual(ring);
    }
  });
});

// §27.9/§19.4 (AC4) — the feedback composer caps its review-todo checklist and scrolls it independently. A
// checkbox at that clip edge keeps its focus ring only if (1) it paints the app's own indicator, not the UA
// default that the surrounding rules do not reach, and (2) the scrollport reserves the ring's extent so
// sequential-focus scroll-into-view lands the control clear of the clip (WCAG SC 2.4.7 / 2.4.11 / 1.4.11).
// The engine (real Chromium) resolves the tokens/calc; the assertions read only what it computed.
describe('the feedback composer todo checklist paints and reserves room for its focus ring', () => {
  let host: HTMLElement;
  let rows: HTMLElement;
  let box: HTMLElement;

  beforeEach(async () => {
    host = document.createElement('div');
    document.body.replaceChildren(host);
    const todos = Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, text: `Review todo ${i}` }));
    createFeedbackComposer(host).render({ step: 'plan', todos }, () => {});
    await vi.waitUntil(() => host.querySelector('.flow-modal .todo-curate') !== null);
    rows = host.querySelector('.todo-curate') as HTMLElement;
    box = rows.querySelector('input[type="checkbox"]') as HTMLElement;
  });

  it('gives a focused todo checkbox the app --signal ring, not the UA default', async () => {
    await tabToProbe(box);
    const cs = getComputedStyle(box);
    expect(cs.outlineStyle).toBe('solid'); // the UA default is `auto`, not solid
    expect(parseFloat(cs.outlineWidth)).toBeGreaterThanOrEqual(2);
    const signal = document.createElement('span');
    signal.style.color = 'var(--signal)';
    host.appendChild(signal);
    expect(cs.outlineColor).toBe(getComputedStyle(signal).color); // the ring is drawn from --signal
    signal.remove();
  });

  it('reserves the ring extent in the scrollport so scroll-into-view never clips it', async () => {
    await tabToProbe(box); // the ring extent is only defined in :focus-visible
    const cs = getComputedStyle(box);
    const ring = parseFloat(cs.outlineWidth) + parseFloat(cs.outlineOffset);
    expect(ring).toBeGreaterThan(0);
    const rc = getComputedStyle(rows);
    expect(parseFloat(rc.scrollPaddingTop)).toBeGreaterThanOrEqual(ring);
    expect(parseFloat(rc.scrollPaddingBottom)).toBeGreaterThanOrEqual(ring);
  });

  it('paints the required-feedback error in the app --attn error colour, not the dim helper colour', () => {
    const submit = host.querySelector('.flow-modal .confirm') as HTMLElement;
    submit.click(); // empty submit → the alert is populated
    const err = host.querySelector('.flow-modal [role="alert"]') as HTMLElement;
    expect(err.textContent?.trim().length).toBeGreaterThan(0);
    const attn = document.createElement('span');
    attn.style.color = 'var(--attn-text)';
    host.appendChild(attn);
    expect(getComputedStyle(err).color).toBe(getComputedStyle(attn).color); // reads as an error, not helper prose
    attn.remove();
  });
});

// `.flow-modal .card` is shared by every dialog built on createModalShell (confirm, error, flow-input).
// Capping its height without giving it a scroll box would clip THEIR content instead of scrolling it — the
// footer is `flex:none`, so it is what gets pushed out (WCAG 2.1.1, 2.4.3).
describe('capping the card does not clip the OTHER dialogs built on the same shell', () => {
  let modal: HTMLElement;

  beforeEach(async () => {
    await page.viewport(600, 300);
    modal = document.createElement('div');
    modal.className = 'flow-modal';
    const body = Array.from({ length: 40 }, (_, i) => `<p class="ph">Line ${i} of a dialog with a lot to say.</p>`).join('');
    modal.innerHTML = `<div class="card"><h3 class="serif">Terminate the flow?</h3>${body}
      <div class="mfoot"><button type="button" class="pill cancel">Cancel</button><button type="button" class="pill danger confirm">Terminate</button></div>
    </div>`;
    document.body.replaceChildren(modal);
  });

  afterEach(async () => {
    await page.viewport(1280, 896);
  });

  it('keeps a tall dialog’s actions reachable by scrolling', () => {
    // Capping `.card` without a scroll box would put the footer where no input method can reach it. Assert
    // the OUTCOME — scroll the modal to its end and look for the button — not a property pair, and not that
    // two flex siblings fail to overlap (normal flow guarantees that, so it could never fail).
    const confirm = modal.querySelector('button.confirm') as HTMLElement;
    modal.scrollTop = modal.scrollHeight;
    const r = confirm.getBoundingClientRect();
    expect(r.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
    expect(r.top).toBeGreaterThanOrEqual(-1);
  });
});

// The ring's alpha has TWO independent sources — the outline colour's own alpha and any group opacity
// above it — and dropping either one grades a washed-out ring as a solid one, which is how a control can
// lose its visible focus indicator (WCAG 2.1 SC 1.4.11) with every ring pin still green.
describe('focusRing (the helper the ring pins are graded through)', () => {
  beforeEach(() => {
    card = document.createElement('div');
    card.style.background = 'var(--card)';
    document.body.replaceChildren(card);
  });

  it('honours the outline colour\'s OWN alpha, not just the group opacity', () => {
    const el = mount('<button style="outline-style:solid;outline-width:2px;outline-color:rgba(0,0,0,0.02)">x</button>');
    // 2% black on the card is, on screen, the card: a ring that invisible must grade as invisible.
    expect(contrast(focusRing(el), paintedBgBehindRing(el))).toBeLessThan(1.2);
  });

  it('still folds in a group opacity above the element', () => {
    const el = mount('<div style="opacity:0.02"><button style="outline-style:solid;outline-width:2px;outline-color:rgb(0,0,0)">x</button></div>')
      .querySelector('button') as HTMLElement;
    expect(contrast(focusRing(el), paintedBgBehindRing(el))).toBeLessThan(1.2);
  });

  it('grades an opaque ring on the card at its full contrast', () => {
    const el = mount('<button style="outline-style:solid;outline-width:2px;outline-color:rgb(0,0,0)">x</button>');
    expect(contrast(focusRing(el), paintedBgBehindRing(el))).toBeGreaterThan(3);
  });
});
