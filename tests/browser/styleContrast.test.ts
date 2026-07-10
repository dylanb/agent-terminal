import { userEvent } from 'vitest/browser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../src/renderer/src/styles.css';

// WCAG contrast pins for the renderer's tokens and controls. The locked "Galley · Lit" mood keeps
// bright accent hues, so dedicated `--*-text` tokens carry the accessible foreground (memory
// wcag-overrides-locked-mood). Chromium resolves the cascade, `var()` and `color-mix()`; the
// assertions below do only the WCAG 2.1 arithmetic on the values it paints.

type RGBA = [number, number, number, number];

function parse(computed: string): RGBA {
  const n = computed.match(/[\d.]+/g);
  if (!n) throw new Error(`unparseable computed colour: ${computed}`);
  return [Number(n[0]), Number(n[1]), Number(n[2]), n[3] === undefined ? 1 : Number(n[3])];
}
const lin = (c: number): number => ((c /= 255), c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (c: RGBA): number => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
function contrast(fg: RGBA, bg: RGBA): number {
  const [hi, lo] = [luminance(fg) + 0.05, luminance(bg) + 0.05].sort((a, b) => b - a);
  return hi / lo;
}
const over = (fg: RGBA, bg: RGBA): RGBA => [
  fg[0] * fg[3] + bg[0] * (1 - fg[3]),
  fg[1] * fg[3] + bg[1] * (1 - fg[3]),
  fg[2] * fg[3] + bg[2] * (1 - fg[3]),
  1,
];

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

let card: HTMLElement;

/** A probe subtree on an opaque `--card` backdrop — the surface every control below sits on. */
function mount(html: string): HTMLElement {
  card.innerHTML = html;
  return card.firstElementChild as HTMLElement;
}
function token(name: string): RGBA {
  const probe = mount(`<span></span>`);
  probe.style.color = `var(${name})`;
  return parse(getComputedStyle(probe).color);
}
const fg = (el: Element): RGBA => parse(getComputedStyle(el).color);

/** Focus by keyboard, because `:focus-visible` need not match a programmatic `focus()`. */
async function focusByKeyboard(el: HTMLElement): Promise<void> {
  await userEvent.tab();
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
        await focusByKeyboard(x);
        const ring = over([...parse(getComputedStyle(x).outlineColor).slice(0, 3), paintedAlpha(x)] as RGBA, paintedBg(bar));
        expect(contrast(ring, paintedBg(bar))).toBeGreaterThanOrEqual(3);
      });
    });

    // The Install button stays focusable while busy (aria-disabled + aria-busy) so the progress
    // announcement reaches a keyboard user still standing on it. A group `opacity` there would
    // alpha-composite the browser-drawn focus ring along with the label.
    describe('busy pill focus ring contrast (WCAG 2.1 SC 1.4.11)', () => {
      const ringOn = (el: HTMLElement): RGBA => {
        const bg = paintedBg(el);
        return over([...parse(getComputedStyle(el).outlineColor).slice(0, 3), paintedAlpha(el)] as RGBA, bg);
      };

      it("the busy pill's focus ring clears 3:1 on --card", async () => {
        const el = mount(`<button class="pill signal" aria-disabled="true" aria-busy="true">Installing…</button>`);
        await focusByKeyboard(el);
        expect(contrast(ringOn(el), paintedBg(el))).toBeGreaterThanOrEqual(3);
      });

      it("an idle pill's focus ring clears 3:1 on --card", async () => {
        const el = mount(`<button class="pill signal">Install examples</button>`);
        await focusByKeyboard(el);
        expect(contrast(ringOn(el), paintedBg(el))).toBeGreaterThanOrEqual(3);
      });

      it('the busy pill still reads as busy — its label differs from the idle pill\'s', () => {
        const idle = fg(mount(`<button class="pill signal">Install examples</button>`));
        const busy = fg(mount(`<button class="pill signal" aria-disabled="true">Installing…</button>`));
        expect(busy).not.toEqual(idle);
        expect(busy).toEqual(token('--dim'));
      });
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
