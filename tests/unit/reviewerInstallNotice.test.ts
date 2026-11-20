import { describe, it, expect } from 'vitest';
import { reviewerInstallNotice } from '../../src/main/runReviewers';

const wrote = { wrote: ['/run/.claude/agents/plan-loop--review-plan-intent.md'], problems: [] };

describe('what Start tells the operator about the reviewers it installed', () => {
  it('asks for a restart when it wrote reviewers while Claude Code was running', () => {
    expect(reviewerInstallNotice(wrote, 'claude-code')).toMatch(/restart/i);
  });

  it('says nothing when it wrote nothing', () => {
    expect(reviewerInstallNotice({ wrote: [], problems: [] }, 'claude-code')).toBeNull();
  });

  it('says nothing when no agent is running at the prompt', () => {
    expect(reviewerInstallNotice(wrote, null)).toBeNull();
  });

  it('says nothing to a Codex session, which does not read these reviewers', () => {
    expect(reviewerInstallNotice(wrote, 'codex')).toBeNull();
  });

  it('names every problem whether one or many reviewers failed', () => {
    for (const problems of [['only problem'], ['first problem', 'second', 'third']]) {
      const notice = reviewerInstallNotice({ wrote: [], problems }, null) ?? '';
      for (const problem of problems) expect(notice).toContain(problem);
    }
  });

  it('retains every diagnostic in a large failed catalog', () => {
    const problems = Array.from({ length: 30 }, (_, i) => `problem number ${i} with a long path /Users/someone/loops/charter-${i}.md`);
    const notice = reviewerInstallNotice({ wrote: [], problems }, null) ?? '';
    for (const problem of problems) expect(notice).toContain(problem);
  });
});
