import { describe, it, expect } from 'vitest';
import { coreExecHardeningArgs } from '../../src/main/gitHardening';
import { bootstrapProtectedArgs } from '../../src/main/appBootstrapGit';

describe('git local-exec hardening (single-sourced)', () => {
  it('coreExecHardeningArgs neutralizes exactly the two local-code-execution levers', () => {
    expect(coreExecHardeningArgs('/tmp/disabled-hooks')).toEqual([
      '-c',
      'core.hooksPath=/tmp/disabled-hooks',
      '-c',
      'core.fsmonitor=false',
    ]);
  });

  it('bootstrapProtectedArgs composes the shared local-exec set with the network-op hardening, byte-for-byte', () => {
    // Byte-equality pin: proves the extraction preserves appBootstrapGit's historical protectedArgs exactly.
    expect(bootstrapProtectedArgs('/tmp/disabled-hooks')).toEqual([
      '-c',
      'core.hooksPath=/tmp/disabled-hooks',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.sshCommand=ssh',
      '-c',
      'credential.interactive=false',
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.ext.allow=never',
      '-c',
      'protocol.file.allow=always',
      '-c',
      'protocol.https.allow=always',
      '-c',
      'protocol.ssh.allow=always',
    ]);
  });

  it('the shared local-exec set is a prefix of the bootstrap set (composition, not a second copy)', () => {
    const core = coreExecHardeningArgs('/tmp/h');
    expect(bootstrapProtectedArgs('/tmp/h').slice(0, core.length)).toEqual(core);
  });
});
