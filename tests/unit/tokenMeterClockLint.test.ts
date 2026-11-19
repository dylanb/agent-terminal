import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

const INJECTED_TIME = /injected now\(\) and refresh scheduler/;
const root = resolve(__dirname, '../..');
const eslint = new ESLint({ cwd: root });

async function ruleErrors(code: string, filePath = 'src/main/tokenMeter.ts'): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) });
  return result.messages.filter((m) => INJECTED_TIME.test(m.message)).length;
}

describe('token counting reads time only through its injected seams', () => {
  it('flags the real clock and real timers in the meter, the attribution and the log readers', async () => {
    expect({
      dateNow: await ruleErrors('const t = Date.now();\n'),
      newDate: await ruleErrors('const t = new Date();\n'),
      dateCall: await ruleErrors('const t = Date();\n'),
      performanceNow: await ruleErrors('const t = performance.now();\n', 'src/main/stepTokens.ts'),
      setInterval: await ruleErrors('setInterval(refresh, 2000);\n'),
      setTimeout: await ruleErrors('setTimeout(refresh, 0);\n', 'src/main/agentUsage/sweep.ts'),
      nestedReader: await ruleErrors('const t = Date.now();\n', 'src/main/agentUsage/codex/read.ts'),
      promisesSleep: await ruleErrors("import { setTimeout as sleep } from 'node:timers/promises';\n"),
      timersInterval: await ruleErrors("import { setInterval } from 'timers';\n"),
      promisesScheduler: await ruleErrors("import { scheduler } from 'timers/promises';\n", 'src/main/stepTokens.ts'),
    }).toEqual({
      dateNow: 1, newDate: 1, dateCall: 1, performanceNow: 1, setInterval: 1, setTimeout: 1, nestedReader: 1,
      promisesSleep: 1, timersInterval: 1, promisesScheduler: 1,
    });
  });

  it('allows reading a logged time and leaves other modules alone', async () => {
    expect({
      parse: await ruleErrors("const t = Date.parse('2026-11-10T12:00:00.123Z');\n"),
      fromString: await ruleErrors('const t = new Date(line.timestamp).getTime();\n', 'src/main/agentUsage/claudeCode.ts'),
      injected: await ruleErrors('const t = deps.now();\n'),
      compositionRoot: await ruleErrors('setInterval(refresh, 2000);\n', 'src/main/index.ts'),
      otherModule: await ruleErrors('const t = Date.now();\n', 'src/main/auditRecorder.ts'),
    }).toEqual({ parse: 0, fromString: 0, injected: 0, compositionRoot: 0, otherModule: 0 });
  });
});
