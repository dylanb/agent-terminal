import { expectTypeOf, it } from 'vitest';
import {
  createRealAppBootstrapPorts,
  type RealAppBootstrapPorts,
} from '../../src/main/appBootstrapPorts';

it('returns the real app bootstrap ports through an async factory', () => {
  expectTypeOf(createRealAppBootstrapPorts).returns.toEqualTypeOf<
    Promise<RealAppBootstrapPorts>
  >();
});
