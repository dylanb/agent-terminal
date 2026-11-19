import { afterEach, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync: run }));
import { readProcessEntry, sessionRecipient } from '../../src/main/mcpSessionProcess';

afterEach(() => { vi.restoreAllMocks(); run.mockReset(); });

it('reports unexpected process lookup failures once until that process recovers', () => {
  const messages: string[] = [];
  vi.spyOn(console, 'error').mockImplementation(message => { messages.push(String(message)); });
  run.mockImplementation(() => { throw new Error('process lookup unavailable'); });
  expect(readProcessEntry(62001)).toBeNull();
  expect(readProcessEntry(62001)).toBeNull();
  expect(messages).toEqual([expect.stringContaining('process lookup unavailable')]);
  run.mockReturnValue(' 100 claude');
  expect(readProcessEntry(62002)).toEqual({ ppid: 100, args: 'claude' });
  run.mockImplementation(() => { throw new Error('process lookup unavailable'); });
  expect(readProcessEntry(62001)).toBeNull();
  expect(messages).toHaveLength(1);
  run.mockReturnValue(' 100 claude');
  expect(readProcessEntry(62001)).toEqual({ ppid: 100, args: 'claude' });
  run.mockImplementation(() => { throw new Error('process lookup unavailable'); });
  expect(readProcessEntry(62001)).toBeNull();
  expect(messages).toEqual([messages[0], messages[0]]);
});

it('treats a vanished process as absence but reports a failed ps command with diagnostics', () => {
  const messages: string[] = [];
  vi.spyOn(console, 'error').mockImplementation(message => { messages.push(String(message)); });
  run.mockImplementation(() => { throw Object.assign(new Error('no process'), { status: 1, stdout: '', stderr: '' }); });
  expect(readProcessEntry(62003)).toBeNull();
  expect(messages).toEqual([]);
  run.mockImplementation(() => { throw Object.assign(new Error('ps permission denied'), { status: 1, stdout: '', stderr: 'permission denied' }); });
  expect(readProcessEntry(62003)).toBeNull();
  expect(messages).toEqual([expect.stringContaining('ps permission denied')]);
});

it('reports missing ps executables and non-Error throws without authorizing a session', () => {
  const messages: string[] = [];
  vi.spyOn(console, 'error').mockImplementation(message => { messages.push(String(message)); });
  run.mockImplementation(() => { throw Object.assign(new Error('spawn ps ENOENT'), { code: 'ENOENT' }); });
  expect(readProcessEntry(62004)).toBeNull();
  run.mockImplementation(() => { throw 'unexpected process failure'; });
  expect(readProcessEntry(62004)).toBeNull();
  expect(messages).toEqual([expect.stringContaining('spawn ps ENOENT'), expect.stringContaining('unexpected process failure')]);
});

it('reports recipient observation failures again after the destination recovers', () => {
  const messages: string[] = [];
  vi.spyOn(console, 'error').mockImplementation(message => { messages.push(String(message)); });
  run.mockImplementation(() => { throw new Error('recipient unavailable'); });
  expect(sessionRecipient(62006, 62005)).toBeNull();
  expect(sessionRecipient(62006, 62005)).toBeNull();
  expect(messages).toEqual([expect.stringContaining('recipient unavailable')]);
  run.mockReturnValue('62005 1 S 62005 62006 pts/0\n62006 62005 S+ 62006 62006 pts/0');
  expect(sessionRecipient(62006, 62005)).not.toBeNull();
  run.mockImplementation(() => { throw new Error('recipient unavailable'); });
  expect(sessionRecipient(62006, 62005)).toBeNull();
  expect(messages).toEqual([messages[0], messages[0]]);
});

it('reports malformed process data without logging its contents', () => {
  const messages: string[] = [];
  vi.spyOn(console, 'error').mockImplementation(message => { messages.push(String(message)); });
  run.mockReturnValue('unparseable private command arguments');
  expect(readProcessEntry(62007)).toBeNull();
  expect(messages).toEqual([expect.stringContaining('malformed process data')]);
  expect(messages.join('\n')).not.toContain('private command arguments');
});
