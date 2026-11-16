import { describe, expect, it } from 'vitest';
import { setupCheckEnabled } from '../../src/main/setupCheck';

describe('APP_SETUP_CHECK turns the startup setup check off only when it is exactly off', () => {
  it('runs the check unless the variable is off', () => {
    expect({
      unset: setupCheckEnabled({}),
      off: setupCheckEnabled({ APP_SETUP_CHECK: 'off' }),
      on: setupCheckEnabled({ APP_SETUP_CHECK: 'on' }),
      empty: setupCheckEnabled({ APP_SETUP_CHECK: '' }),
      otherCase: setupCheckEnabled({ APP_SETUP_CHECK: 'OFF' }),
    }).toEqual({ unset: true, off: false, on: true, empty: true, otherCase: true });
  });
});
