import { describe, expect, it } from 'vitest';
import { normalizeTicketInputs, stepInputTypes, submitTicketInputs } from '../../src/main/ticketInput';
import { BOOTSTRAP_PICKUP } from '../../src/main/flowEntryActions';

const here = { selector: 'github.com/dequelabs/software-factory', owner: 'dequelabs', name: 'software-factory' };
const origin = () => Promise.resolve(here);
const types = { ticket: 'github-ticket', notes: 'free-text' };

describe('normalizeTicketInputs', () => {
  it('stores only the number when the issue URL is in the current repository', async () => {
    const result = await normalizeTicketInputs(
      { ticket: 'https://github.com/dequelabs/software-factory/issues/42', notes: 'x' },
      types,
      origin,
    );
    expect(result).toEqual({ ok: true, values: { ticket: '42', notes: 'x' } });
  });

  it('matches the repository case-insensitively and tolerates surrounding whitespace', async () => {
    const result = await normalizeTicketInputs(
      { ticket: '  https://GitHub.com/DequeLabs/Software-Factory/issues/7  ' },
      types,
      origin,
    );
    expect(result).toEqual({ ok: true, values: { ticket: '7' } });
  });

  it('leaves a bare number untouched without resolving the repository', async () => {
    const result = await normalizeTicketInputs({ ticket: '42' }, types, () => Promise.reject(new Error('no origin')));
    expect(result).toEqual({ ok: true, values: { ticket: '42' } });
  });

  it('refuses an issue URL from another repository and names both repositories', async () => {
    const result = await normalizeTicketInputs(
      { ticket: 'https://github.com/dequelabs/axe-core/issues/42' },
      types,
      origin,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.notice).toContain('https://github.com/dequelabs/axe-core/issues/42');
    expect(result.notice).toContain('dequelabs/software-factory');
  });

  it('refuses an issue URL when the current repository cannot be determined', async () => {
    const result = await normalizeTicketInputs(
      { ticket: 'https://github.com/dequelabs/software-factory/issues/42' },
      types,
      () => Promise.reject(new Error('invalid origin repository')),
    );
    expect(result).toMatchObject({ ok: false, reason: 'origin-unavailable' });
  });

  it('refuses a URL that is not an issue URL', async () => {
    const result = await normalizeTicketInputs(
      { ticket: 'https://github.com/dequelabs/software-factory/pull/42' },
      types,
      origin,
    );
    expect(result).toMatchObject({ ok: false, reason: 'not-an-issue-url' });
  });

  it.each(['#43', 'abc', '43abc', '0', '-4', '4.5'])('refuses %j, which is neither an issue number nor an issue URL', async (raw) => {
    const result = await normalizeTicketInputs({ ticket: raw }, types, origin);
    expect(result).toMatchObject({ ok: false, reason: 'not-an-issue-number' });
  });

  it('stores a bare number without surrounding whitespace', async () => {
    const result = await normalizeTicketInputs({ ticket: ' 43 ' }, types, origin);
    expect(result).toEqual({ ok: true, values: { ticket: '43' } });
  });

  it.each(['#issuecomment-1', '?q=1', '?q=1#top'])('stores the number of a same-repository issue link carrying %j', async (suffix) => {
    const result = await normalizeTicketInputs(
      { ticket: `https://github.com/dequelabs/software-factory/issues/42${suffix}` },
      types,
      origin,
    );
    expect(result).toEqual({ ok: true, values: { ticket: '42' } });
  });

  it.each([
    ['#43', 'not-an-issue-number'],
    ['abc', 'not-an-issue-number'],
    ['0', 'not-an-issue-number'],
    ['https://github.com/dequelabs/software-factory/pull/42', 'not-an-issue-url'],
    ['http://github.com/dequelabs/software-factory/issues/42', 'not-an-issue-url'],
    ['https://github.com/dequelabs/software-factory/issues/42/extra', 'not-an-issue-url'],
    ['https://github.com/dequelabs/software-factory/issues', 'not-an-issue-url'],
    ['https://github.com/dequelabs/axe-core/issues/42', 'other-repository'],
    ['https://gitlab.com/dequelabs/software-factory/issues/42', 'other-repository'],
  ])('refuses %j for the reason %j', async (raw, reason) => {
    const result = await normalizeTicketInputs({ ticket: raw }, types, origin);
    expect(result).toMatchObject({ ok: false, reason });
  });

  it('refuses an issue URL for an unavailable origin with that reason', async () => {
    const result = await normalizeTicketInputs(
      { ticket: 'https://github.com/dequelabs/software-factory/issues/42' },
      types,
      () => Promise.reject(new Error('no origin')),
    );
    expect(result).toMatchObject({ ok: false, reason: 'origin-unavailable' });
  });

  it('normalizes a ticket input named __proto__', async () => {
    const step = { inputs: [{ name: '__proto__', type: 'github-ticket' }] };
    const values = JSON.parse('{"__proto__":"https://github.com/dequelabs/software-factory/issues/9"}') as Record<string, string>;
    const result = await normalizeTicketInputs(values, stepInputTypes(step), origin);
    expect(result.ok && Object.getOwnPropertyDescriptor(result.values, '__proto__')?.value).toBe('9');
  });

  it('does not touch URLs in inputs of other types', async () => {
    const result = await normalizeTicketInputs(
      { notes: 'https://github.com/dequelabs/axe-core/issues/42' },
      types,
      origin,
    );
    expect(result).toEqual({ ok: true, values: { notes: 'https://github.com/dequelabs/axe-core/issues/42' } });
  });
});

describe('submitTicketInputs', () => {
  const step = { inputs: [{ name: 'ticket', type: 'github-ticket' }, { name: 'notes', type: 'free-text' }] };
  const url = 'https://github.com/dequelabs/software-factory/issues/42';

  it('discards the result when the flow is re-entered while the repository resolves', async () => {
    let token = 1;
    const result = await submitTicketInputs({ ticket: url }, step, {
      currentRepository: () => { token = 2; return origin(); },
      entryToken: () => token,
    });
    expect(result).toEqual({ kind: 'stale' });
  });

  it('accepts the normalized values when the flow was not re-entered', async () => {
    const result = await submitTicketInputs({ ticket: url }, step, { currentRepository: origin, entryToken: () => 1 });
    expect(result).toEqual({ kind: 'accepted', values: { ticket: '42' } });
  });

  it('reissues the prompt for the submitted fields with the refusal notice', async () => {
    const result = await submitTicketInputs({ ticket: 'abc' }, step, { currentRepository: origin, entryToken: () => 1 });
    expect(result).toMatchObject({
      kind: 'refused',
      notice: expect.stringContaining('abc'),
      prompt: {
        inputs: [{ name: 'ticket', type: 'github-ticket' }],
        bootstrap: BOOTSTRAP_PICKUP,
        refusal: { input: 'ticket', notice: expect.stringContaining('abc'), values: { ticket: 'abc' } },
      },
    });
  });
});
