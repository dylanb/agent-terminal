import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { parseElapsed, processStartedAt } from '../../src/main/foregroundCommand';

let child: ChildProcess | null = null;
afterEach(() => {
  child?.kill();
  child = null;
});

describe('when a process started, read from the process table', () => {
  it('reads the start of a running process, never after now', () => {
    child = spawn('sleep', ['30']);

    const startedAt = processStartedAt(child.pid as number);

    expect(startedAt).not.toBeNull();
    expect(startedAt as number).toBeLessThanOrEqual(Date.now());
  });

  it('places the start at least a second before the moment it was asked', () => {
    child = spawn('sleep', ['30']);
    const asked = 1_000_000_000_000;

    expect(processStartedAt(child.pid as number, () => asked) as number).toBeLessThanOrEqual(asked - 1000);
  });

  it('is unknown for a process that does not exist', () => {
    expect(processStartedAt(2 ** 22 + 12345)).toBeNull();
  });

  it('reads the elapsed time ps prints, in seconds', () => {
    expect(parseElapsed('   05:07')).toBe(307);
    expect(parseElapsed('02:05:07')).toBe(2 * 3600 + 307);
    expect(parseElapsed('3-02:05:07')).toBe(3 * 86400 + 2 * 3600 + 307);
    expect(parseElapsed('')).toBeNull();
    expect(parseElapsed('not elapsed')).toBeNull();
  });
});
