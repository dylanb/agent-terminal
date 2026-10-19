import { expect, test } from '@playwright/test';

test('fails at its check', () => {
  expect(1 + 1).toBe(3);
});

test('fails two soft checks', () => {
  expect.soft(1).toBe(2);
  expect.soft('a').toBe('b');
});

test('passes', () => {
  expect(true).toBe(true);
});

test('throws a TypeError', () => {
  const missing = undefined as unknown as { call(): void };
  missing.call();
});

test('runs out of time', async () => {
  test.setTimeout(300);
  await new Promise((resolve) => setTimeout(resolve, 5_000));
});

test('is not selected', () => {
  expect(1).toBe(2);
});
