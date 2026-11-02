import { describe, expect, expectTypeOf, it } from 'vitest';
import { GATE_OPTION_HANDLERS, SIDE_EFFECT_HANDLERS } from '../../src/main/appGateDecision';
import { GH_ACTION_HANDLERS } from '../../src/main/appGateGithub';
import { INPUT_TYPE_REFS } from '../../src/main/flow';
import { INPUT_TYPE_AUDIT_EVENT } from '../../src/shared/audit';
import type { ActedInputType } from '../../src/shared/engineCapabilities/flow';
import type { ActedGhAction, ActedSideEffectKind } from '../../src/shared/engineCapabilities/loop';
import type { GateDecisionOption } from '../../src/shared/ipc/flow';
import {
  ACTED_GATE_OPTIONS as ORACLE_ACTED_GATE_OPTIONS,
  ACTED_GH_ACTIONS as ORACLE_ACTED_GH_ACTIONS,
  ACTED_INPUT_TYPES as ORACLE_ACTED_INPUT_TYPES,
  ACTED_SIDE_EFFECT_KINDS as ORACLE_ACTED_SIDE_EFFECT_KINDS,
  type OracleActedGateOption,
  type OracleActedGhAction,
  type OracleActedInputType,
  type OracleActedSideEffectKind,
} from '../helpers/engineCapabilityOracle';

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

describe('gate-option handler table is bound to the acted-on gate-option list', () => {
  it("the descriptor's gate options are the oracle's", () => {
    expectTypeOf<GateDecisionOption>().toEqualTypeOf<OracleActedGateOption>();
  });

  it('the gate decision dispatches through one handler per acted-on gate option', () => {
    expectTypeOf<keyof typeof GATE_OPTION_HANDLERS>().toEqualTypeOf<GateDecisionOption>();
    expectTypeOf<keyof typeof GATE_OPTION_HANDLERS>().toEqualTypeOf<OracleActedGateOption>();
    expect(Object.keys(GATE_OPTION_HANDLERS).sort()).toEqual([...ORACLE_ACTED_GATE_OPTIONS].sort());
  });
});

describe('side-effect handler table is bound to the acted-on side-effect-kind list', () => {
  it("the descriptor's acted-on side-effect kinds are the oracle's", () => {
    expectTypeOf<ActedSideEffectKind>().toEqualTypeOf<OracleActedSideEffectKind>();
  });

  it('the approve side-effects dispatch through one handler per acted-on kind', () => {
    expectTypeOf<keyof typeof SIDE_EFFECT_HANDLERS>().toEqualTypeOf<ActedSideEffectKind>();
    expectTypeOf<keyof typeof SIDE_EFFECT_HANDLERS>().toEqualTypeOf<OracleActedSideEffectKind>();
    expect(Object.keys(SIDE_EFFECT_HANDLERS).sort()).toEqual([...ORACLE_ACTED_SIDE_EFFECT_KINDS].sort());
  });
});

describe('gh action handler table is bound to the acted-on gh-action list', () => {
  it("the descriptor's acted-on gh actions are the oracle's", () => {
    expectTypeOf<ActedGhAction>().toEqualTypeOf<OracleActedGhAction>();
  });

  it('the gh side-effect dispatches through one handler per acted-on action', () => {
    expectTypeOf<keyof typeof GH_ACTION_HANDLERS>().toEqualTypeOf<ActedGhAction>();
    expectTypeOf<keyof typeof GH_ACTION_HANDLERS>().toEqualTypeOf<OracleActedGhAction>();
    expect(Object.keys(GH_ACTION_HANDLERS).sort()).toEqual([...ORACLE_ACTED_GH_ACTIONS].sort());
  });
});
