import { describe, expect, it } from 'vitest';
import { HUMAN_DECIDER, runAppApprove } from '../../src/main/appGateDecision';
import { createMcpActions } from '../../src/main/mcpActions';
import { toolResult, type McpToolResult } from '../../src/main/mcpTools';
import type { McpWindowState } from '../../src/shared/mcpWindowState';
import type { TurnOrigin } from '../../src/shared/turnOrigin';
import { APPROVE_MARK_READY, defWithGate, mkDeps } from '../helpers/appGateDecisionDeps';
import type { LoopDefV2 } from '../../src/main/loopDefV2';
import { APP_LOOP_NAMESPACE, MARKED_BINDING_REASON, RETIRED_LOOP_NAMESPACE, type LoopBinding } from '../../src/shared/loopNamespace';

// Approve through MCP (#322 slice 2): the window checks the ticket's refusal reasons in order before any decision
// reaches the gate, then runs the same approve its Approve control runs and answers with that approve's outcome.

const WINDOW = 'window-1';
const REPO = '/repo';
const GATE = { step: 'plan', turn: 'consolidate-plan' };

const atGate = (gate: Partial<NonNullable<McpWindowState['gate']>> | null = {}): McpWindowState => ({
  window: { id: WINDOW },
  repo: { key: REPO },
  flow: { selected: null, steps: ['plan', 'done'], step: 'plan', status: 'in_progress', runStarted: true },
  selectionUnusable: false,
  gate: gate === null ? null : { step: GATE.step, turn: GATE.turn, options: ['approve', 'request-changes'], reasons: [], engineDeciding: false, ...gate },
  stalledTurn: null,
  loopMessage: null,
  roundReport: null,
  todos: [],
  startable: null,
  startableError: null,
  terminateTodoCount: 0,
});

const OWN_TARGET = { window: WINDOW, repo: REPO, step: GATE.step, turn: GATE.turn };

/** The ticket's refusal reasons, in its order, each as the wording its message carries. */
const REFUSALS = [
  ['not this window', /not this session.s window/i],
  ['origin undetermined', /turn origin could not be determined/i],
  ['not human-started', /not a human-started turn/i],
  ['no gate waiting', /no gate waiting/i],
  ['not valid', /not valid in the current state/i],
] as const;

const text = (result: McpToolResult): string => result.content.map((c) => c.text).join('\n');
/** The message the agent relays, as the result carries it. */
const messageOf = (result: McpToolResult): string => String((JSON.parse(text(result)) as { message?: unknown }).message);

/** Which refusal a result is: `taken` for a success, `neither` for an error naming no refusal reason. */
function classOf(result: McpToolResult): string {
  if (!result.isError) return 'taken';
  const named = REFUSALS.filter(([, wording]) => wording.test(text(result))).map(([name]) => name);
  return named.length === 1 ? named[0] : named.length === 0 ? 'neither' : `ambiguous: ${named.join(', ')}`;
}

const CALLER = 4101;

/** A window whose approve is the real gate approve, over ports that record what it did. `origin` is the calling
 *  session's turn; `origins` gives each session's own. */
function window(opts: { origin?: TurnOrigin; origins?: Record<number, TurnOrigin>; state?: McpWindowState; gate?: Parameters<typeof mkDeps>[0]; pickupHold?: string; binding?: LoopBinding } = {}) {
  const { deps, rec } = mkDeps(opts.gate ?? {});
  /** Each human decision the gate was told of, and whether it landed once settled. */
  const decisions: { repoKey: string; step: string; turnKey: string | null; beforeAccept: boolean; landed?: boolean }[] = [];
  const actions = createMcpActions({
    windowId: WINDOW,
    originOf: async (caller) => (caller.session === null ? undefined : (opts.origins ?? { [CALLER]: opts.origin ?? 'human' })[caller.session]) ?? 'undetermined',
    readState: async () => structuredClone(opts.state ?? atGate()),
    readGateState: () => structuredClone(opts.state ?? atGate()),
    gate: {
      autoGate: {
        humanDecision: (repoKey, step, turnKey) => {
          const decision: (typeof decisions)[number] = { repoKey, step, turnKey, beforeAccept: rec.accepts.length === 0 };
          decisions.push(decision);
          return (landed) => void (decision.landed = landed);
        },
      },
      pickupHold: () => opts.pickupHold ?? null,
      bindingOf: () => opts.binding ?? APP_LOOP_NAMESPACE,
      approve: (repoKey, step, turnKey) => runAppApprove(repoKey, step, turnKey, deps, HUMAN_DECIDER),
    },
  });
  const call = async (tool: string, args: Record<string, unknown>, session = CALLER): Promise<McpToolResult> =>
    toolResult({ kind: 'answered', value: await actions.call({ tool, args }, { session }) });
  /** What the approve changed: an accept, a side effect, an advance, a loop message, or a human decision the gate was
   *  told of. */
  const acted = (): boolean => rec.accepts.length + rec.sideEffects.length + rec.advances.length + rec.errors.length + rec.notices.length > 0;
  const changed = (): boolean => acted() || decisions.length > 0;
  return { call, rec, acted, changed, decisions };
}

describe('the refusal reasons an approve is checked against', () => {
  it('every combination is refused with the first reason that applies, in the ticket order, and a refusal changes nothing', async () => {
    const got: Record<string, { result: string; changed: boolean }> = {};
    const want: Record<string, { result: string; changed: boolean }> = {};
    for (const otherWindow of [false, true]) {
      for (const origin of ['human', 'undetermined', 'not-human'] as const) {
        for (const gateWaiting of [true, false]) {
          for (const staleStep of [false, true]) {
            const key = `otherWindow=${otherWindow} origin=${origin} gateWaiting=${gateWaiting} staleStep=${staleStep}`;
            const w = window({ origin, state: atGate(gateWaiting ? {} : null) });
            const result = await w.call('approve', { ...OWN_TARGET, ...(otherWindow ? { window: 'window-2' } : {}), ...(staleStep ? { step: 'review' } : {}) });
            got[key] = { result: classOf(result), changed: w.changed() };
            const first = otherWindow
              ? 'not this window'
              : origin === 'undetermined'
                ? 'origin undetermined'
                : origin === 'not-human'
                  ? 'not human-started'
                  : !gateWaiting
                    ? 'no gate waiting'
                    : staleStep
                      ? 'not valid'
                      : 'taken';
            want[key] = { result: first, changed: first === 'taken' };
          }
        }
      }
    }
    expect(got).toEqual(want);
  });

  it("judges the calling session's own turn: the same approve is taken for a human-started session and refused for another session beside it", async () => {
    const SCRIPTED = CALLER + 1;
    const fromScripted = window({ origins: { [CALLER]: 'human', [SCRIPTED]: 'not-human' } });
    const scripted = await fromScripted.call('approve', OWN_TARGET, SCRIPTED);
    const human = await window({ origins: { [CALLER]: 'human', [SCRIPTED]: 'not-human' } }).call('approve', OWN_TARGET, CALLER);
    expect({ scripted: classOf(scripted), scriptedChanged: fromScripted.changed(), human: classOf(human) }).toEqual({ scripted: 'not human-started', scriptedChanged: false, human: 'taken' });
  });

  it('a read works in a turn that is not human-started and in one whose origin is undetermined', async () => {
    const notHuman = await window({ origin: 'not-human' }).call('read_state', {});
    const undetermined = await window({ origin: 'undetermined' }).call('read_state', {});
    const read = (result: McpToolResult) => ({ isError: result.isError, window: (JSON.parse(text(result)) as { window?: unknown }).window });
    expect({ notHuman: read(notHuman), undetermined: read(undetermined) }).toEqual({
      notHuman: { isError: false, window: { id: WINDOW } },
      undetermined: { isError: false, window: { id: WINDOW } },
    });
  });
});

describe('an approve naming a target the window no longer shows', () => {
  it('is not valid in the current state, names what the window shows, and changes nothing', async () => {
    const cases = {
      otherRepo: { args: { ...OWN_TARGET, repo: '/elsewhere' }, names: REPO },
      staleStep: { args: { ...OWN_TARGET, step: 'review' }, names: GATE.step, besides: [GATE.turn, 'plan-loop'] },
      staleTurn: { args: { ...OWN_TARGET, turn: 'review-round-3' }, names: GATE.turn },
    };
    const got: Record<string, unknown> = {};
    for (const [name, c] of Object.entries(cases)) {
      const w = window();
      const result = await w.call('approve', c.args);
      const besides: readonly string[] = 'besides' in c ? c.besides : [];
      const said = besides.reduce((t, other) => t.split(other).join(''), text(result));
      got[name] = { result: classOf(result), namesShown: said.includes(c.names), changed: w.changed() };
    }
    const w = window({ state: atGate({ options: ['request-changes', 'redo'] }) });
    const notOffered = await w.call('approve', OWN_TARGET);
    got.notOffered = { result: classOf(notOffered), namesShown: text(notOffered).includes('request-changes'), changed: w.changed() };
    const refused = { result: 'not valid', namesShown: true, changed: false };
    expect(got).toEqual({ otherRepo: refused, staleStep: refused, staleTurn: refused, notOffered: refused });
  });

  it('is not taken, neither success nor refusal, without a loop message, when the gate moved on after the window was read', async () => {
    const w = window({ gate: { run: { loop: 'plan-loop', step: 'plan', turnKey: 'consolidate-plan-2', status: 'complete', round: 3, verdict: 'clean' } } });
    const result = await w.call('approve', OWN_TARGET);
    expect({ result: classOf(result), acted: w.acted(), decisionLanded: w.decisions.some((d) => d.landed !== false) }).toEqual({ result: 'neither', acted: false, decisionLanded: false });
  });
});

describe('an approve the window cannot decide now', () => {
  it.each([
    ['a pending pickup confirmation', { pickupHold: 'Confirm the run\'s ticket and pull request before deciding the gate.' }, 'Confirm the run'],
    ['a step bound to the retired engine', { binding: RETIRED_LOOP_NAMESPACE }, MARKED_BINDING_REASON],
  ] as const)('%s refuses it as not valid in the current state, naming why, before anything is accepted or posted', async (_name, opts, reason) => {
    const w = window(opts);
    const result = await w.call('approve', OWN_TARGET);
    expect({ result: classOf(result), namesWhy: messageOf(result).includes(reason), changed: w.changed() }).toEqual({ result: 'not valid', namesWhy: true, changed: false });
  });
});

describe('what an approve in a human-started turn returns', () => {
  it('a taken approve is a success, advances the flow and ends Polish', async () => {
    const w = window();
    const result = await w.call('approve', OWN_TARGET);
    expect({ result: classOf(result), saysTaken: /taken/i.test(text(result)), advanced: w.rec.advances, polishEnded: w.rec.polishClears, loopErrors: w.rec.errors, gateToldOfDecision: w.decisions }).toEqual({
      result: 'taken',
      saysTaken: true,
      advanced: [REPO],
      polishEnded: [REPO],
      loopErrors: [],
      gateToldOfDecision: [{ repoKey: REPO, step: GATE.step, turnKey: GATE.turn, beforeAccept: true, landed: true }],
    });
  });

  it('at an auto gate, a side effect that fails after the accept is a success that names it and why, with the Loop error kept', async () => {
    const w = window({ gate: { holds: false, sideEffectThrows: 'HTTP 502 from GitHub' } });
    const result = await w.call('approve', OWN_TARGET);
    expect({
      result: classOf(result),
      saysTaken: /taken/i.test(text(result)),
      namesEffect: text(result).includes('mark-ready'),
      namesReason: text(result).includes('HTTP 502 from GitHub'),
      saysFailed: /fail/i.test(text(result)),
      advanced: w.rec.advances,
      loopErrorKept: w.rec.errors.length,
      decisionLanded: w.decisions.map((d) => d.landed),
    }).toEqual({ result: 'taken', saysTaken: true, namesEffect: true, namesReason: true, saysFailed: true, advanced: [REPO], loopErrorKept: 1, decisionLanded: [true] });
  });

  it('at a human gate, a failed side effect is neither success nor refusal: not taken, naming it and why, saying approving again re-runs every side effect', async () => {
    const w = window({ gate: { holds: true, sideEffectThrows: 'HTTP 502 from GitHub' } });
    const result = await w.call('approve', OWN_TARGET);
    expect({
      result: classOf(result),
      namesEffect: text(result).includes('mark-ready'),
      namesReason: text(result).includes('HTTP 502 from GitHub'),
      saysNotTaken: /not taken/i.test(text(result)),
      saysRetryRerunsAll: /approv\w* again/i.test(text(result)) && /every side effect/i.test(text(result)),
      accepted: w.rec.accepts.length,
      loopErrorKept: w.rec.errors.length,
      decisionLanded: w.decisions.map((d) => d.landed),
    }).toEqual({ result: 'neither', namesEffect: true, namesReason: true, saysNotTaken: true, saysRetryRerunsAll: true, accepted: 0, loopErrorKept: 1, decisionLanded: [false] });
  });

  it('an accept that could not be saved is neither success nor refusal, naming why, with the Loop error kept', async () => {
    const w = window({
      gate: {
        persistAccept: () => {
          throw new Error('ENOSPC: no space left on device');
        },
      },
    });
    const result = await w.call('approve', OWN_TARGET);
    expect({ result: classOf(result), namesReason: text(result).includes('ENOSPC'), saysNotSaved: /sav|persist/i.test(text(result)), advanced: w.rec.advances, loopErrorKept: w.rec.errors.length > 0, decisionLanded: w.decisions.map((d) => d.landed) }).toEqual({
      result: 'neither',
      namesReason: true,
      saysNotSaved: true,
      advanced: [],
      loopErrorKept: true,
      decisionLanded: [false],
    });
  });

  it('an approve that raises the epic-promotion preview is a success waiting on that dialog at the machine, naming it', async () => {
    const w = window({ gate: { maybeBeginEpicPromotion: () => ({ kind: 'preview-raised' }) } });
    const result = await w.call('approve', OWN_TARGET);
    expect({ result: classOf(result), saysWaiting: /waiting/i.test(text(result)), namesDialog: /epic[- ]promotion preview/i.test(text(result)), advanced: w.rec.advances, decisionLanded: w.decisions.map((d) => d.landed) }).toEqual({
      result: 'taken',
      saysWaiting: true,
      namesDialog: true,
      advanced: [],
      decisionLanded: [false],
    });
  });

  it('an approve whose epic promotion is blocked is neither success nor refusal, saying so', async () => {
    const w = window({ gate: { maybeBeginEpicPromotion: () => ({ kind: 'blocked' }) } });
    const result = await w.call('approve', OWN_TARGET);
    expect({ result: classOf(result), saysBlocked: /epic promotion/i.test(text(result)) && /blocked/i.test(text(result)), advanced: w.rec.advances, decisionLanded: w.decisions.map((d) => d.landed) }).toEqual({
      result: 'neither',
      saysBlocked: true,
      advanced: [],
      decisionLanded: [false],
    });
  });
});

describe('what an approve result says happened', () => {
  const withReport = { ...defWithGate(APPROVE_MARK_READY), outputs: [{ id: 'impl-report', path: '.agent-terminal/loop/artifacts/impl-report.md', sectionsDir: '.agent-terminal/loop/artifacts/impl-report' }] } as unknown as LoopDefV2;

  it('at a human gate, a report that cannot be assembled is not taken, naming the report and why', async () => {
    const w = window({
      gate: {
        holds: true,
        resolveDef: () => ({ ok: true, def: withReport, tierRoot: '/tmp/tier', defDir: '/tmp/tier/loop' }),
        assembleReport: () => {
          throw new Error('EACCES: permission denied');
        },
      },
    });
    const said = messageOf(await w.call('approve', OWN_TARGET));
    expect({ namesReport: said.includes('impl-report'), namesReason: said.includes('EACCES'), saysRetryRerunsAll: /approv\w* again/i.test(said) && /every side effect/i.test(said) }).toEqual({
      namesReport: true,
      namesReason: true,
      saysRetryRerunsAll: true,
    });
  });

  it('an approve waiting on the epic-promotion preview never says it was taken', async () => {
    const said = messageOf(await window({ gate: { maybeBeginEpicPromotion: () => ({ kind: 'preview-raised' }) } }).call('approve', OWN_TARGET));
    expect(/\btaken\b/i.test(said) && !/not (yet )?taken/i.test(said)).toBe(false);
  });

  it('a taken approve whose only failure is one the window shows no Loop error for never points the operator at a Loop error', async () => {
    const w = window({
      gate: {
        clearPolish: () => {
          throw new Error('EISDIR: illegal operation on a directory');
        },
      },
    });
    const said = messageOf(await w.call('approve', OWN_TARGET));
    expect({ namesReason: said.includes('EISDIR'), loopErrors: w.rec.errors.length, claimsLoopError: /loop error/i.test(said) }).toEqual({ namesReason: true, loopErrors: 0, claimsLoopError: false });
  });

  it('when the gate moved on after the window was read, the result never claims that nothing changed, and says to read the state again', async () => {
    const w = window({ gate: { run: { loop: 'plan-loop', step: 'plan', turnKey: 'consolidate-plan-2', status: 'complete', round: 3, verdict: 'clean' } } });
    const said = messageOf(await w.call('approve', OWN_TARGET));
    expect({ claimsNothingChanged: /nothing was changed/i.test(said), saysReadAgain: /read the (window's )?state again/i.test(said) }).toEqual({ claimsNothingChanged: false, saysReadAgain: true });
  });
});

describe('an approve whose arguments the window cannot read', () => {
  it('is neither success nor refusal, names the argument, and changes nothing', async () => {
    const { step: _step, ...noStep } = OWN_TARGET;
    const got: Record<string, unknown> = {};
    for (const [name, args, argument] of [['numericTurn', { ...OWN_TARGET, turn: 7 }, 'turn'], ['noStep', noStep, 'step']] as const) {
      const w = window();
      const result = await w.call('approve', args);
      got[name] = { result: classOf(result), namesArgument: messageOf(result).includes(argument), changed: w.changed() };
    }
    const unread = { result: 'neither', namesArgument: true, changed: false };
    expect(got).toEqual({ numericTurn: unread, noStep: unread });
  });
});

describe('an approve while another approve of the same gate is running', () => {
  it('is not valid in the current state, naming the running approve, and runs no side effect again', async () => {
    const waiting: (() => void)[] = [];
    const release = (): void => waiting.splice(0).forEach((resolve) => resolve());
    const w = window({
      gate: {
        holds: true,
        runSideEffect: async () => {
          w.rec.sideEffects.push({ action: 'mark-ready', ctx: null });
          await new Promise<void>((resolve) => void waiting.push(resolve));
          return { outcome: 'done' };
        },
      },
    });
    const first = w.call('approve', OWN_TARGET);
    await new Promise((resolve) => setImmediate(resolve));
    const pendingSecond = w.call('approve', OWN_TARGET);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const second = await pendingSecond;
    expect({ first: classOf(await first), second: classOf(second), namesWhy: /already running/.test(messageOf(second)), sideEffects: w.rec.sideEffects.length }).toEqual({
      first: 'taken',
      second: 'not valid',
      namesWhy: true,
      sideEffects: 1,
    });
  });
});

describe('the current target after authorization', () => {
  it('refuses the old repository when the window changes repositories during authorization, before telling either gate', async () => {
    let current = atGate();
    let release: (origin: TurnOrigin) => void = () => {};
    let started: () => void = () => {};
    const checking = new Promise<void>((resolve) => { started = resolve; });
    const { deps, rec } = mkDeps({});
    let gateChanged = false;
    const actions = createMcpActions({
      windowId: WINDOW,
      originOf: () => new Promise<TurnOrigin>((resolve) => { release = resolve; started(); }),
      readState: async () => structuredClone(current),
      readGateState: () => structuredClone(current),
      gate: {
        autoGate: { humanDecision: () => { gateChanged = true; return () => {}; } },
        pickupHold: () => null,
        bindingOf: () => APP_LOOP_NAMESPACE,
        approve: (repoKey, step, turnKey) => runAppApprove(repoKey, step, turnKey, deps, HUMAN_DECIDER),
      },
    });
    const pending = actions.call({ tool: 'approve', args: OWN_TARGET }, { session: CALLER });
    await checking;
    current = { ...atGate(), repo: { key: '/other-repo' } };
    release('human');
    const result = toolResult({ kind: 'answered', value: await pending });
    expect({ result: classOf(result), namesCurrentRepo: messageOf(result).includes('/other-repo'), gateChanged, accepts: rec.accepts, effects: rec.sideEffects, advances: rec.advances, errors: rec.errors }).toEqual({
      result: 'not valid', namesCurrentRepo: true, gateChanged: false, accepts: [], effects: [], advances: [], errors: [],
    });
  });
});
