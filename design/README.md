# Design

## Design tokens — `src/renderer/src/tokens.css`

`src/renderer/src/tokens.css` is the one source of the app's design tokens. Both windows (`src/renderer/index.html` and `src/renderer/controller.html`) link it before `styles.css`, and no other renderer stylesheet defines a colour token, so the two windows cannot drift apart. Each token is set on `:root` (light) and overridden under `[data-theme="dark"]`.

Accents (`--signal`, `--attn`, `--pass`) paint dots, borders and washes; each has a `-text` pair because the accent itself does not clear 4.5:1 as small text on `--card`.

The controller's needs-human status tokens are defined on their own, never by reference to the cross-highlight `--reveal` tokens, so changing one never changes the other. In both themes each status text clears 4.5:1 on `--card` and on its tint (WCAG 2.2 SC 1.4.3), and each accent clears 3:1 on `--card` (SC 1.4.11).

### Colour rule

Saturated colour is spent only where it carries meaning; everything else is quiet ink on a bright board.

- **Controller status:** blue for working, red for errors and action, amber for needs a human, green for completed.
- **Agent-terminal window:** **signal** (blue: where the work is, provenance links) and **act** (red: something needs the operator, including needs-a-human).

Type: display **Fraunces**, body **IBM Plex Sans**, data **IBM Plex Mono**.

## Reference mockups — `shell/`

`shell/converged.html` (the three-view shell) and `shell/loop-flow.html` (the loop read-out, typed-input modal and gate surfaces) are the reference mockups the renderer's rail and loop panel are drawn from; open either with `?theme=dark` for the dark theme. `shell/tokens.css` is the mockups' own copy of the palette, not the app's.
