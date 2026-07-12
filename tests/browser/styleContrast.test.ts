import { userEvent, page } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/renderer/src/styles.css';
import { createInstallExamples } from '../../src/renderer/src/installExamples';
import type { DestRelativePath, InstallExamplesPreview, InstallExamplesResult } from '../../src/shared/ipc';
import { parseColor as parse, compositeOver as over, contrastRatio as contrast, type RGBA } from '../helpers/wcag';

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
/** The painted colour of el's focus ring: its outline colour under the accumulated group alpha,
 *  composited over the surface behind the offset ring. */
function focusRing(el: HTMLElement): RGBA {
  return over(
    [...parse(getComputedStyle(el).outlineColor).slice(0, 3), paintedAlpha(el)] as RGBA,
    paintedBgBehindRing(el),
  );
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

    // The attn-bar dismiss ring is a non-text indicator on the bar's tinted wash, not the plain card;
    // the global --signal outline falls short there in light theme, so the bar scopes its own ring.
    describe('attn-bar dismiss focus ring contrast (WCAG 2.1 SC 1.4.11)', () => {
      it('the dismiss focus ring clears 3:1 on the attn-bar background', async () => {
        const bar = mount(`<div class="attn-bar"><span class="msg">m</span><button class="x">×</button></div>`);
        const x = bar.querySelector('.x') as HTMLElement;
        await tabToProbe(x);
        expect(contrast(focusRing(x), paintedBgBehindRing(x))).toBeGreaterThanOrEqual(3);
      });
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

// SC 1.4.10 names 320x256 as the reflow target. There the card's own bound cannot save it: the header and
// the footer are unshrinkable, and together they already exceed the viewport — so the card must be allowed
// to overflow a SCROLLABLE modal, and it must overflow DOWNWARD. `align-items:center` would push the top
// edge above the viewport, and no scroll can reach content above the origin.
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

  it('never pushes the card above the top of the viewport, where no scroll can reach it', () => {
    const cardEl = host.querySelector('.flow-modal .card') as HTMLElement;
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

  it('leaves room for the ring to paint inside the clip', () => {
    const rows = host.querySelector('.install-consent-rows') as HTMLElement;
    const box = host.querySelector('.install-consent-opt input[type="checkbox"]') as HTMLElement;
    const ring = 2 + 2; // outline-width + outline-offset
    expect(box.getBoundingClientRect().left - rows.getBoundingClientRect().left).toBeGreaterThanOrEqual(ring);
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

  it('does not let a tall dialog’s body overprint its own footer', () => {
    // The card has no `overflow`, so capping its height does not CLIP the body — it lets it paint straight
    // over the footer, which is `flex:none` and cannot move. Same defect as the consent manifest, on every
    // other dialog that composes this shell.
    const foot = modal.querySelector('.mfoot') as HTMLElement;
    const lastLine = [...modal.querySelectorAll('.ph')].pop() as HTMLElement;
    expect(lastLine.getBoundingClientRect().bottom).toBeLessThanOrEqual(foot.getBoundingClientRect().top + 1);
  });
});
