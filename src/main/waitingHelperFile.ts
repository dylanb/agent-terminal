import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { errMsg, isErrno } from './errno';
import { flowHomeDir } from './flowHome';

const HELPER_PROGRAMS_FILE = 'helper-programs.yaml';

const HELPER_PROGRAMS_REFRESH_MS = 15_000;

const NO_NAMES: readonly string[] = Object.freeze([]);

export interface HelperProgramsDeps {
  readonly appHome: string;
  now(): number;
}

export interface HelperPrograms {
  names(): readonly string[];
}

type FileReading =
  | { readonly kind: 'names'; readonly names: readonly string[] }
  | { readonly kind: 'broken'; readonly key: string; readonly reason: string };

function readFile(file: string): FileReading {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return { kind: 'names', names: [] };
    return { kind: 'broken', key: `error:${errMsg(e)}`, reason: `cannot be read: ${errMsg(e)}` };
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(text);
  } catch (e) {
    return { kind: 'broken', key: `content:${text}`, reason: `is not YAML: ${errMsg(e)}` };
  }
  if (!Array.isArray(parsed) || !parsed.every((entry): entry is string => typeof entry === 'string')) {
    return { kind: 'broken', key: `content:${text}`, reason: 'is not a list of program names' };
  }
  return { kind: 'names', names: parsed };
}

export function createHelperPrograms({ appHome, now }: HelperProgramsDeps): HelperPrograms {
  const file = path.join(flowHomeDir(appHome), HELPER_PROGRAMS_FILE);
  let readAt: number | null = null;
  let current: readonly string[] = NO_NAMES;
  let lastBroken: string | null = null;
  return {
    names: () => {
      const at = now();
      if (readAt !== null && at - readAt < HELPER_PROGRAMS_REFRESH_MS) return current;
      readAt = at;
      const reading = readFile(file);
      if (reading.kind === 'names') {
        lastBroken = null;
        current = Object.freeze([...reading.names]);
      } else {
        if (reading.key !== lastBroken) console.error(`Ignoring the helper programs in ${file}: it ${reading.reason}`);
        lastBroken = reading.key;
        current = NO_NAMES;
      }
      return current;
    },
  };
}
