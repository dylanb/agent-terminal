import { describe, expect, expectTypeOf, it } from 'vitest';
import { INPUT_TYPE_REFS } from '../../src/main/flow';
import { INPUT_TYPE_AUDIT_EVENT } from '../../src/shared/audit';
import type { ActedInputType } from '../../src/shared/engineCapabilities/flow';
import { ACTED_INPUT_TYPES as ORACLE_ACTED_INPUT_TYPES, type OracleActedInputType } from '../helpers/engineCapabilityOracle';

// `pnpm typecheck` compiles this file, so each `expectTypeOf` fails the type check when a handler table and
// its acted-on list disagree in either direction; vitest strips them, and the key-set checks are their run-time face.

const oracleNames = [...ORACLE_ACTED_INPUT_TYPES].sort();

describe('typed-input handler tables are bound to the acted-on input-type list', () => {
  it("the descriptor's acted-on input types are the oracle's", () => {
    expectTypeOf<ActedInputType>().toEqualTypeOf<OracleActedInputType>();
  });

  it('the flow refs table has one entry per acted-on input type', () => {
    expectTypeOf<keyof typeof INPUT_TYPE_REFS>().toEqualTypeOf<ActedInputType>();
    expectTypeOf<keyof typeof INPUT_TYPE_REFS>().toEqualTypeOf<OracleActedInputType>();
    expect(Object.keys(INPUT_TYPE_REFS).sort()).toEqual(oracleNames);
  });

  it('the audit event table has one entry per acted-on input type', () => {
    expectTypeOf<keyof typeof INPUT_TYPE_AUDIT_EVENT>().toEqualTypeOf<ActedInputType>();
    expectTypeOf<keyof typeof INPUT_TYPE_AUDIT_EVENT>().toEqualTypeOf<OracleActedInputType>();
    expect(Object.keys(INPUT_TYPE_AUDIT_EVENT).sort()).toEqual(oracleNames);
  });
});
