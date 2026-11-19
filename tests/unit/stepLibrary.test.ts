import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStepLibrary, MAX_STEP_DEFINITION_BYTES, stepLibraryDir } from '../../src/main/stepLibrary';

describe('step library lookup (§18.2)', () => {
  let repo: string;
  let outside: string;
  const lib = () => createStepLibrary([{ name: 'repo', worktreeDir: repo }]);
  const writeStep = (name: string, text: string): string => {
    mkdirSync(stepLibraryDir(repo), { recursive: true });
    const file = join(stepLibraryDir(repo), `${name}.yaml`);
    writeFileSync(file, text);
    return file;
  };
  const errorOf = (name: string): string => {
    const r = lib()(name);
    if (r.ok) throw new Error(`expected ${name} to be refused`);
    return r.error;
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'step-lib-repo-'));
    outside = mkdtempSync(join(tmpdir(), 'step-lib-outside-'));
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('finds a repo step definition and returns its text', () => {
    writeStep('step-a', 'kind: manual\n');
    const r = lib()('step-a');
    expect(r).toMatchObject({ ok: true, tier: 'repo', raw: 'kind: manual\n' });
  });

  it('reports a name no tier holds as not found', () => {
    const error = errorOf('step-a');
    expect(error).toContain('step-a');
    expect(error).toContain('was not found');
  });

  it.each(['../x', '/etc/passwd', 'a/b'])('refuses the unsafe name %s', (name) => {
    expect(errorOf(name)).toContain('is not a valid step name');
  });

  it('refuses a step file that links outside the library', () => {
    const target = join(outside, 'evil.yaml');
    writeFileSync(target, 'kind: manual\n');
    mkdirSync(stepLibraryDir(repo), { recursive: true });
    symlinkSync(target, join(stepLibraryDir(repo), 'step-a.yaml'));
    expect(errorOf('step-a')).toContain('escapes');
  });

  it('reports a library path that is a regular file as unreadable, not as not found', () => {
    mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
    writeFileSync(stepLibraryDir(repo), 'not a directory');
    const error = errorOf('step-a');
    expect(error).toContain('repo step library');
    expect(error).toContain('could not be read');
    expect(error).not.toContain('was not found');
  });

  it('refuses a step file larger than the read cap', () => {
    writeStep('step-a', 'x'.repeat(MAX_STEP_DEFINITION_BYTES + 1));
    expect(errorOf('step-a')).toContain('larger than');
  });

  it('refuses a FIFO without blocking', () => {
    mkdirSync(stepLibraryDir(repo), { recursive: true });
    execFileSync('mkfifo', [join(stepLibraryDir(repo), 'step-a.yaml')]);
    expect(errorOf('step-a')).toContain('step-a');
  });
});
