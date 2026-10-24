// The one place a browser test names the renderer's token sheet. Import it for its side effect, before
// `styles.css`, as both windows link it. A glob, not a static import: before #245's GREEN the sheet does not
// exist, and a missing static import is a collection error the red check (§28.5.3) refuses as a RED.
import.meta.glob('../../src/renderer/src/tokens.css', { eager: true });
