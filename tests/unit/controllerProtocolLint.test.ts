import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { resolve } from 'node:path';

const PROTOCOL_CONSTANTS = /CONTROLLER_PROTOCOL_MAJOR/;
const root = resolve(__dirname, '../..');
const eslint = new ESLint({ cwd: root });

async function ruleErrors(code: string, filePath = 'tests/integration/controllerProbe.test.ts'): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) });
  return result.messages.filter((m) => PROTOCOL_CONSTANTS.test(m.message)).length;
}

describe('controller test stand-ins build messages with the protocol constants', () => {
  it('flags a typed-in version or minor on a message a controller test builds', async () => {
    expect({
      encodedVersion: await ruleErrors("socket.send(encodeControllerMessage({ version: 2, type: 'registered' }));\n"),
      encodedInTernary: await ruleErrors("socket.send(encodeControllerMessage(ok ? { version: 2, type: 'registered' } : { version: 2, type: 'activate', requestId: 'r' }));\n"),
      stringifiedVersion: await ruleErrors("socket.send(JSON.stringify({ version: 2, type: 'status', work }));\n"),
      stringifiedMinor: await ruleErrors("socket.send(JSON.stringify({ version: MAJOR, minor: 0, type: 'register' }));\n"),
    }).toEqual({ encodedVersion: 1, encodedInTernary: 2, stringifiedVersion: 1, stringifiedMinor: 1 });
  });

  it('leaves the protocol constants, non-message JSON, wire-format tests and other tests alone', async () => {
    expect({
      constants: await ruleErrors("socket.send(encodeControllerMessage({ version: CONTROLLER_PROTOCOL_MAJOR, minor: CONTROLLER_PROTOCOL_MINOR, type: 'register' }));\n"),
      notAMessage: await ruleErrors("JSON.stringify({ version: 1, tests: [] });\n"),
      wireFormatTest: await ruleErrors("JSON.stringify({ version: 3, type: 'status', work });\n", 'tests/unit/controllerProtocol.test.ts'),
      otherTest: await ruleErrors("encodeControllerMessage({ version: 2, type: 'registered' });\n", 'tests/unit/redCheck.test.ts'),
    }).toEqual({ constants: 0, notAMessage: 0, wireFormatTest: 0, otherTest: 0 });
  });

  it('the controller tests in the tree follow the rule', async () => {
    const results = await eslint.lintFiles(['tests/**/controller*.ts']);
    const offenders = results.flatMap((r) =>
      r.messages.filter((m) => PROTOCOL_CONSTANTS.test(m.message)).map((m) => `${r.filePath.slice(root.length + 1)}:${m.line}`),
    );
    expect(offenders).toEqual([]);
  });
});
