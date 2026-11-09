import path from 'node:path';
import type { ValidateFlowResult } from './validateFlow';
import { MAX_LOOP_ARTIFACT_BYTES } from './appLoopPaths';
import { readBoundedResolved, type BoundedRead } from './boundedRead';
import { CHECK_REPEAT_LIST_FLAG, CLI_COMMAND_NAME } from './cliShim';
import { errMsg } from './errno';
import { stripDisplayControlChars } from '../shared/controlChars';
import { checkJsonList, type JsonListCheck, type JsonListDocumentRule, type JsonListEntryRule } from '../shared/jsonList';

export interface CheckRepeatListDeps {
  cwd: () => string;
}

export type CheckRepeatListResult = ValidateFlowResult;

type ReadFailure = Extract<BoundedRead, { ok: false }>['cause'];

const READ_PROBLEMS: Readonly<Record<ReadFailure, string>> = {
  absent: 'does not exist',
  'over-cap': `is larger than the ${MAX_LOOP_ARTIFACT_BYTES}-byte read bound`,
  unreadable: 'is not a readable regular UTF-8 file',
};

const DOCUMENT_PROBLEMS: Readonly<Record<JsonListDocumentRule, (list: string) => string>> = {
  parses: () => 'is not valid JSON',
  'top-level-object': () => 'is not a JSON object',
  'key-present': (list) => `has no key ${JSON.stringify(list)}`,
  'value-array': (list) => `its ${JSON.stringify(list)} is not an array`,
  'at-least-one-entry': (list) => `its ${JSON.stringify(list)} has no entries`,
};

const ENTRY_PROBLEMS: Readonly<Record<JsonListEntryRule, string>> = {
  'entry-object': 'is not an object',
  'title-string': 'has no string title',
  'title-not-blank': 'has a blank title',
  'title-no-control-character': 'has a title holding a control character',
};

function ruleProblem(check: Exclude<JsonListCheck, { ok: true }>, list: string): string {
  return 'position' in check ? `entry ${check.position} ${ENTRY_PROBLEMS[check.rule]}` : DOCUMENT_PROBLEMS[check.rule](list);
}

const line = (text: string): string => `${stripDisplayControlChars(text)}\n`;

export function runCheckRepeatList(operands: readonly string[], deps: CheckRepeatListDeps): CheckRepeatListResult {
  if (operands.length !== 2) {
    return { exitCode: 2, stdout: '', stderr: `usage: ${CLI_COMMAND_NAME} ${CHECK_REPEAT_LIST_FLAG} <file> <list>\n` };
  }
  const [operand, list] = operands;
  let file: string;
  try {
    file = path.isAbsolute(operand) ? path.resolve(operand) : path.resolve(deps.cwd(), operand);
  } catch (e) {
    return { exitCode: 1, stdout: line(`${operand}: the working directory it is named from cannot be read: ${errMsg(e)}`), stderr: '' };
  }
  const read = readBoundedResolved(file, MAX_LOOP_ARTIFACT_BYTES);
  if (!read.ok) return { exitCode: 1, stdout: line(`${file}: ${READ_PROBLEMS[read.cause]}`), stderr: '' };
  const check = checkJsonList(read.text, list);
  if (!check.ok) return { exitCode: 1, stdout: line(`${file}: ${ruleProblem(check, list)}`), stderr: '' };
  return { exitCode: 0, stdout: line(`OK: ${file} holds a well-formed list of ${check.titles.length} entries`), stderr: '' };
}
