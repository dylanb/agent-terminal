import { describe, expect, it } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };

// §8.2: two VT parsers at different versions silently corrupt captures. This guard
// makes that invariant fail CI instead of silently shipping a one-sided bump.
describe('@xterm version pin (§8.2)', () => {
  const xterm = pkg.dependencies['@xterm/xterm'];
  const headless = pkg.dependencies['@xterm/headless'];

  it('pins @xterm/xterm and @xterm/headless to the same version', () => {
    expect(xterm).toBe(headless);
  });

  it('pins both exactly (no ^ or ~ range)', () => {
    expect(xterm).toMatch(/^\d+\.\d+\.\d+$/);
    expect(headless).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
