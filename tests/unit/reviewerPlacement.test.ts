import { describe, it, expect } from 'vitest';
import { installsPerRun } from '../../src/main/reviewerPlacement';

describe('which agents get their reviewers installed in the run folder', () => {
  it('installs per run for Claude Code, and when no agent is identified yet', () => {
    expect(installsPerRun('claude-code')).toBe(true);
    expect(installsPerRun(null)).toBe(true);
  });

  it('leaves Codex reviewers in the Codex home', () => {
    expect(installsPerRun('codex')).toBe(false);
  });
});
