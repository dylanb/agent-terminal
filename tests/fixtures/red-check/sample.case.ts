import { expect, it } from 'vitest';

it('fails at its check', () => {
  expect(1 + 1).toBe(3);
});

it('fails two soft checks', () => {
  expect.soft(1).toBe(2);
  expect.soft('a').toBe('b');
});

it('passes', () => {
  expect(true).toBe(true);
});

it('throws a TypeError', () => {
  const missing = undefined as unknown as { call(): void };
  missing.call();
});
