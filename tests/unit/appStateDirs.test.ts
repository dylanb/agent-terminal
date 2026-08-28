import { describe, it, expect } from 'vitest';
import { APP_STATE_DIRS, isUnderAppStateDir } from '../../src/main/appStateDirs';

// The single membership predicate the clean-tree gate and the RED working-tree check both derive from, so
// "is this path app state" cannot drift between two hand-spelled copies (CLAUDE.md shared-semantics).
describe('isUnderAppStateDir', () => {
  it('matches every app-state dir itself and any path beneath it', () => {
    for (const dir of APP_STATE_DIRS) {
      expect(isUnderAppStateDir(dir)).toBe(true); // the bare dir
      expect(isUnderAppStateDir(`${dir}/loop/run-state.yaml`)).toBe(true); // a child
    }
  });

  it('does not match a sibling that merely shares the prefix', () => {
    for (const dir of APP_STATE_DIRS) {
      expect(isUnderAppStateDir(`${dir}X/foo`)).toBe(false); // .agent-terminalX is not .agent-terminal
      expect(isUnderAppStateDir(`${dir}-notes/x`)).toBe(false);
    }
  });

  it('does not match ordinary repo paths', () => {
    expect(isUnderAppStateDir('tests/a.test.ts')).toBe(false);
    expect(isUnderAppStateDir('src/x.ts')).toBe(false);
    expect(isUnderAppStateDir('loop-capabilities.yaml')).toBe(false);
  });
});
