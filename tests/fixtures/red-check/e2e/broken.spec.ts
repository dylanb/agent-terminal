import { test } from '@playwright/test';

throw new Error('this spec cannot load');

test('never collected', () => {});
