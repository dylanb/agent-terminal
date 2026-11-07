import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const eslint = new ESLint({ cwd: root, errorOnUnmatchedPattern: false });

const CLOCK_SEAM = /through the clock dependency/;
const NO_LIVE_REGION = /add no live region/;
const SORT_CONTROL_HELPER = /sort control through tests\/helpers\/controllerCards\.ts/;
const NO_TEST_SLEEP = /never a fixed time/;
const NO_TEST_WALL_CLOCK = /never the wall clock/;
const PRESSABLE = /createPressGroup\/onPress/;
const WINDOW_FOCUS_SEAM = /through the window focus dependency/;
const TYPED_VERSION = /CONTROLLER_PROTOCOL_MAJOR/;

async function errors(pattern: RegExp, code: string, filePath: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) });
  return result.messages.filter((m) => pattern.test(m.message)).length;
}

const ORDERING_CODE = [
  'src/renderer/src/controllerCardOrder.ts',
  'src/renderer/src/controllerPanes.ts',
  'src/renderer/src/controllerCard.ts',
  'src/renderer/src/sortModeControl.ts',
];

describe('the controller card order reads time only through its clock dependency', () => {
  it('flags a wall-clock read or a timer of its own in each ordering file', async () => {
    for (const file of ORDERING_CODE) {
      expect({
        file,
        dateNow: await errors(CLOCK_SEAM, 'export const t = Date.now();\n', file),
        performanceNow: await errors(CLOCK_SEAM, 'export const t = performance.now();\n', file),
        newDate: await errors(CLOCK_SEAM, 'export const t = new Date();\n', file),
        interval: await errors(CLOCK_SEAM, 'setInterval(() => {}, 10_000);\n', file),
        timeout: await errors(CLOCK_SEAM, 'setTimeout(() => {}, 10_000);\n', file),
        windowInterval: await errors(CLOCK_SEAM, 'window.setInterval(() => {}, 10_000);\n', file),
      }).toEqual({ file, dateNow: 1, performanceNow: 1, newDate: 1, interval: 1, timeout: 1, windowInterval: 1 });
    }
  });

  it('accepts the clock dependency, a formatted timestamp, and the production clock in the frame', async () => {
    expect({
      seam: await errors(CLOCK_SEAM, 'export const read = (deps: { clock: { now(): number } }) => deps.clock.now();\n', ORDERING_CODE[0]),
      formatted: await errors(CLOCK_SEAM, 'export const at = (ms: number) => new Date(ms).toISOString();\n', 'src/renderer/src/controllerCard.ts'),
      frame: await errors(CLOCK_SEAM, 'export const t = Date.now();\nsetInterval(() => {}, 10_000);\n', 'src/renderer/src/controllerFrame.ts'),
    }).toEqual({ seam: 0, formatted: 0, frame: 0 });
  });

  it('flags reading window focus other than through its dependency in each ordering file', async () => {
    for (const file of ORDERING_CODE) {
      expect({ file, hasFocus: await errors(WINDOW_FOCUS_SEAM, 'export const f = document.hasFocus();\n', file) }).toEqual({ file, hasFocus: 1 });
    }
    expect(await errors(WINDOW_FOCUS_SEAM, 'export const f = document.hasFocus();\n', 'src/renderer/src/controllerFrame.ts')).toBe(0);
  });

  it('still runs every press through pressable in those files', async () => {
    for (const file of ORDERING_CODE) {
      expect({ file, click: await errors(PRESSABLE, "document.body.addEventListener('click', () => {});\n", file) }).toEqual({ file, click: 1 });
    }
  });
});

describe('a card, the card order and the sort control announce nothing', () => {
  const QUIET = ['src/renderer/src/controllerCard.ts', 'src/renderer/src/controllerCardOrder.ts', 'src/renderer/src/sortModeControl.ts'];

  it('flags a live-region attribute or role in each of them', async () => {
    for (const file of QUIET) {
      expect({
        file,
        ariaLive: await errors(NO_LIVE_REGION, "label.setAttribute('aria-live', 'polite');\n", file),
        ariaLiveProperty: await errors(NO_LIVE_REGION, "label.ariaLive = 'polite';\n", file),
        status: await errors(NO_LIVE_REGION, "label.setAttribute('role', 'status');\n", file),
        alert: await errors(NO_LIVE_REGION, "label.setAttribute('role', 'alert');\n", file),
        log: await errors(NO_LIVE_REGION, "label.setAttribute('role', 'log');\n", file),
      }).toEqual({ file, ariaLive: 1, ariaLiveProperty: 1, status: 1, alert: 1, log: 1 });
    }
  });

  it('accepts other roles there, and the live regions the panes own', async () => {
    expect({
      radio: await errors(NO_LIVE_REGION, "option.setAttribute('role', 'radio');\n", 'src/renderer/src/sortModeControl.ts'),
      panes: await errors(NO_LIVE_REGION, "status.setAttribute('role', 'status');\nalert.setAttribute('aria-live', 'assertive');\n", 'src/renderer/src/controllerPanes.ts'),
    }).toEqual({ radio: 0, panes: 0 });
  });
});

describe('controller tests find the sort control only through the helper', () => {
  it('flags a hand-written radio or radio-group query', async () => {
    for (const file of ['tests/unit/controllerProbe.test.ts', 'tests/unit/sortModeControl.test.ts', 'tests/e2e/controllerRecentOrder.spec.ts']) {
      expect({
        file,
        radio: await errors(SORT_CONTROL_HELPER, "page.getByRole('radio', { name: 'Attention' });\n", file),
        group: await errors(SORT_CONTROL_HELPER, "page.getByRole('radiogroup');\n", file),
        selector: await errors(SORT_CONTROL_HELPER, "host.querySelectorAll('[role=\"radio\"]');\n", file),
      }).toEqual({ file, radio: 1, group: 1, selector: 1 });
    }
  });

  it('leaves the helper and other roles alone', async () => {
    expect({
      inHelper: await errors(SORT_CONTROL_HELPER, "scope.getByRole('radio');\n", 'tests/helpers/controllerCards.ts'),
      button: await errors(SORT_CONTROL_HELPER, "page.getByRole('button', { name: 'Attention' });\n", 'tests/unit/sortModeControl.test.ts'),
      outsideScope: await errors(SORT_CONTROL_HELPER, "page.getByRole('radio');\n", 'tests/unit/monitorPane.test.ts'),
    }).toEqual({ inHelper: 0, button: 0, outsideScope: 0 });
  });
});

const ORDER_TESTS = [
  'tests/unit/controllerCardOrder.test.ts',
  'tests/unit/controllerSortOrder.test.ts',
  'tests/unit/controllerRecentOrder.test.ts',
  'tests/unit/sortModeControl.test.ts',
  'tests/browser/controllerHold.test.ts',
  'tests/e2e/controllerAttentionOrder.spec.ts',
  'tests/e2e/controllerRecentOrder.spec.ts',
  'tests/e2e/controllerRecency.spec.ts',
  'tests/e2e/controllerHold.spec.ts',
];

describe('the card order tests wait on observed state and read no wall clock', () => {
  it('flags a fixed-time sleep or a wall-clock read in each of them', async () => {
    for (const file of ORDER_TESTS) {
      expect({
        file,
        waitForTimeout: await errors(NO_TEST_SLEEP, 'await page.waitForTimeout(500);\n', file),
        promiseSleep: await errors(NO_TEST_SLEEP, 'await new Promise((done) => setTimeout(done, 500));\n', file),
        timersPromises: await errors(NO_TEST_SLEEP, "import { setTimeout as delay } from 'node:timers/promises';\n", file),
        dateNow: await errors(NO_TEST_WALL_CLOCK, 'const started = Date.now();\n', file),
        performanceNow: await errors(NO_TEST_WALL_CLOCK, 'const started = performance.now();\n', file),
        newDate: await errors(NO_TEST_WALL_CLOCK, 'const started = new Date();\n', file),
      }).toEqual({ file, waitForTimeout: 1, promiseSleep: 1, timersPromises: 1, dateNow: 1, performanceNow: 1, newDate: 1 });
    }
  });

  it('flags a wall-clock read in the card tests, which hold the time-label checks', async () => {
    const file = 'tests/unit/controllerCard.test.ts';
    expect({
      dateNow: await errors(NO_TEST_WALL_CLOCK, 'const started = Date.now();\n', file),
      performanceNow: await errors(NO_TEST_WALL_CLOCK, 'const started = performance.now();\n', file),
      newDate: await errors(NO_TEST_WALL_CLOCK, 'const started = new Date();\n', file),
      fixedDate: await errors(NO_TEST_WALL_CLOCK, 'const at = new Date(2026, 10, 6, 9, 0);\n', file),
    }).toEqual({ dateNow: 1, performanceNow: 1, newDate: 1, fixedDate: 0 });
  });

  it('accepts an observed-state wait and the fake clock, and leaves other tests alone', async () => {
    expect({
      poll: await errors(NO_TEST_SLEEP, 'await expect.poll(() => read()).toEqual([]);\n', ORDER_TESTS[0]),
      fakeClock: await errors(NO_TEST_WALL_CLOCK, 'clock.advance(60_000);\nconst t = clock.clock.now();\n', ORDER_TESTS[1]),
      frameClock: await errors(NO_TEST_WALL_CLOCK, 'const t = Date.now();\n', 'tests/unit/controllerFrame.test.ts'),
    }).toEqual({ poll: 0, fakeClock: 0, frameClock: 0 });
  });

  it('keeps the card-helper, sort-control and protocol-version rules in them and in the other blocks that restate them', async () => {
    for (const file of [...ORDER_TESTS, 'tests/unit/controllerCard.test.ts', 'tests/e2e/controllerWindowPreferences.spec.ts']) {
      expect({
        file,
        card: await errors(/tests\/helpers\/controllerCards\.ts/, "page.getByRole('article');\n", file),
        sortControl: await errors(SORT_CONTROL_HELPER, "page.getByRole('radio');\n", file),
        version: await errors(TYPED_VERSION, "socket.send(encodeControllerMessage({ version: 2, type: 'registered' }));\n", file),
      }).toEqual({ file, card: 1, sortControl: 1, version: 1 });
    }
  });
});

describe('the tree follows the card order rules', () => {
  it('reports no offender in the files the rules cover', async () => {
    const results = await eslint.lintFiles([...ORDERING_CODE, 'tests/**/controller*.ts', 'tests/**/sortModeControl.test.ts']);
    const offenders = results.flatMap((r) =>
      r.messages
        .filter((m) => [CLOCK_SEAM, WINDOW_FOCUS_SEAM, NO_LIVE_REGION, SORT_CONTROL_HELPER, NO_TEST_SLEEP, NO_TEST_WALL_CLOCK].some((p) => p.test(m.message)))
        .map((m) => `${r.filePath.slice(root.length + 1)}:${m.line} ${m.message}`),
    );
    expect(offenders).toEqual([]);
  });
});
