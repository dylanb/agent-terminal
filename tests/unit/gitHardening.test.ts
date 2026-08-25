import { describe, it, expect } from 'vitest';
import { coreExecHardeningArgs } from '../../src/main/gitHardening';
import { bootstrapProtectedArgs } from '../../src/main/appBootstrapGit';

// The OBSERVABLE protection — a hostile repo-local git config never runs a command during a bootstrap
// operation — is covered behaviorally in tests/integration/bootstrapPorts.test.ts (inherited core.hooksPath
// hooks, a custom remote.*.uploadpack, and core.sshCommand each assert their marker file stays absent). This
// unit keeps ONLY the shared-semantics guarantee a behavioral test cannot express: bootstrap composes the
// single-sourced local-exec set rather than carrying a second copy that could silently drift (CLAUDE.md).
describe('git local-exec hardening — single source, not a second copy', () => {
  it('bootstrapProtectedArgs begins with the shared coreExecHardeningArgs (composition, not duplication)', () => {
    const core = coreExecHardeningArgs('/tmp/h');
    expect(bootstrapProtectedArgs('/tmp/h').slice(0, core.length)).toEqual(core);
  });
});
