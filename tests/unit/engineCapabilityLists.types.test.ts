import { describe, expectTypeOf, it } from 'vitest';
import type { ActedInputType } from '../../src/shared/engineCapabilities/flow';
import type { ActedGhAction, ActedSideEffectKind } from '../../src/shared/engineCapabilities/loop';
import type { GateDecisionOption } from '../../src/shared/ipc/flow';
import type { OracleActedGateOption, OracleActedGhAction, OracleActedInputType, OracleActedSideEffectKind } from '../helpers/engineCapabilityOracle';

// `pnpm typecheck` compiles this file, so each `expectTypeOf` fails the type check when a descriptor list and
// the oracle disagree in either direction; vitest strips them.

describe("the descriptor's acted-on lists are the oracle's", () => {
  it('input types', () => {
    expectTypeOf<ActedInputType>().toEqualTypeOf<OracleActedInputType>();
  });

  it('gate options', () => {
    expectTypeOf<GateDecisionOption>().toEqualTypeOf<OracleActedGateOption>();
  });

  it('side-effect kinds', () => {
    expectTypeOf<ActedSideEffectKind>().toEqualTypeOf<OracleActedSideEffectKind>();
  });

  it('gh actions', () => {
    expectTypeOf<ActedGhAction>().toEqualTypeOf<OracleActedGhAction>();
  });
});
