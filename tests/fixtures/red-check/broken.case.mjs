import { it } from 'vitest';
import { nothing } from './does-not-exist.mjs';

it('never runs', () => {
  nothing();
});
