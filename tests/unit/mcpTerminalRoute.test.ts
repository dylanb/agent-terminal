import { expect, it } from 'vitest';
import { terminalRecipient } from '../../src/main/mcpTerminalRoute';

const direct = '10 1 S 10 20 pts/0\n20 10 S+ 20 20 pts/0';
const nested = `${direct}\n30 20 S 30 40 pts/1\n40 30 S+ 40 40 pts/1`;
const multiplexed = '10 1 S 10 20 pts/0\n20 10 S+ 20 20 pts/0\n30 1 S 30 -1 ?\n40 30 S 40 50 pts/1\n50 40 S+ 50 50 pts/1\n60 30 S+ 60 60 pts/2';

it('identifies a direct foreground caller, including a shell replaced by the caller', () => {
  expect(terminalRecipient(direct, 20, 10)).not.toBe(null);
  expect(terminalRecipient('10 1 S+ 10 10 pts/0', 10, 10)).not.toBe(null);
});

it('accepts nested terminal routes but rejects a stopped or background intermediate wrapper', () => {
  expect(terminalRecipient(nested, 40, 10)).not.toBe(null);
  expect(terminalRecipient(nested.replace('20 10 S+', '20 10 T'), 40, 10)).toBe(null);
  expect(terminalRecipient(nested.replace('10 20 pts/0', '10 10 pts/0').replace('20 20 pts/0', '20 10 pts/0'), 40, 10)).toBe(null);
});

it('accepts only the tmux client whose selected pane routes to this caller and this window', () => {
  expect(terminalRecipient(multiplexed, 50, 10, '20 40 0 0 root 0 %1')).not.toBe(null);
  expect(terminalRecipient(multiplexed, 50, 10, '20 60 0 0 root 0 %1')).toBe(null);
  expect(terminalRecipient(multiplexed, 50, 10, '99 40 0 0 root 0 %1')).toBe(null);
});

it.each(['20 40 1 0 root 0 %1', '20 40 0 1 root 0 %1', '20 40 0 0 prefix 0 %1', '20 40 0 0 root 1 %1', 'unreadable'])('refuses diverted or broadcast tmux input: %s', clients => {
  expect(terminalRecipient(multiplexed, 50, 10, clients)).toBe(null);
});

it('fails closed on missing, stopped, cyclic or unreadable process routes', () => {
  for (const processes of ['', 'invalid', direct.replace('20 10 S+', '20 10 T'), direct.replace('20 10 S+', '20 20 S+')]) {
    expect(terminalRecipient(processes, 20, 10)).toBe(null);
  }
});

it('keeps identity stable across runnable/sleeping states but changes it when the recipient route changes', () => {
  const first = terminalRecipient(direct, 20, 10);
  expect(first).not.toBe(null);
  expect(terminalRecipient(direct.replace('S+', 'R+'), 20, 10)).toEqual(first);
  expect(terminalRecipient(direct.replaceAll('20', '21'), 21, 10)).not.toEqual(first);
});

it('finds this window’s client when another terminal’s attached client is listed first', () => {
  const processes = `${multiplexed}\n90 1 S 90 99 pts/3\n99 90 S+ 99 99 pts/3`;
  expect(terminalRecipient(processes, 50, 10, '99 40 0 0 root 0 %1\n20 40 0 0 root 0 %1')).not.toBe(null);
});

it('identifies the selected caller pane as the delivery destination', () => {
  expect(terminalRecipient(multiplexed, 50, 10, '20 40 0 0 root 0 %1')).toMatchObject({ pane: '%1' });
});
