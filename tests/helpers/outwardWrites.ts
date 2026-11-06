import { existsSync, readFileSync } from 'node:fs';

/** One recorded invocation of a stand-in tool: the tool and its argv, exactly as the caller passed them. */
export interface ToolCall {
  tool: 'git' | 'gh';
  argv: readonly string[];
}

/** The call log's framing, which every writer of the log builds its records from: a record is
 *  `TOOL_CALL_RECORD tool TOOL_CALL_FIELD (arg TOOL_CALL_FIELD)*`. */
export const TOOL_CALL_RECORD = '\x1e';
export const TOOL_CALL_FIELD = '\x1f';

/** The calls in `logFile`, in the order they were made; empty when nothing has run yet. */
export function readToolCalls(logFile: string): ToolCall[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8')
    .split(TOOL_CALL_RECORD)
    .filter((record) => record.length > 0)
    .map((record) => {
      const [tool, ...argv] = record.split(TOOL_CALL_FIELD);
      argv.pop();
      if (tool !== 'git' && tool !== 'gh') throw new Error(`readToolCalls: unknown tool record ${JSON.stringify(record)}`);
      return { tool, argv };
    });
}

const GIT_GLOBALS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix']);

/** Git's subcommand and its arguments, past every leading global option (`-c k=v`, `--git-dir d`, …). */
export function gitSubcommand(argv: readonly string[]): { name: string; args: readonly string[] } {
  let i = 0;
  while (i < argv.length && (argv[i] ?? '').startsWith('-')) i += GIT_GLOBALS_WITH_VALUE.has(argv[i] ?? '') ? 2 : 1;
  return { name: argv[i] ?? '', args: argv.slice(i + 1) };
}

/** The `gh` calls that read GitHub and change nothing. A `gh api` call is a read only when every option it
 *  carries is one that sends nothing and its method, if named, is GET; any other option counts as a send. */
const READ_ONLY_GH = new Set(['auth status', 'repo view', 'pr view', 'pr list', 'pr checks', 'issue view', 'issue list']);
const GH_API_READ_OPTIONS_WITH_VALUE = new Set(['--hostname', '-H', '--header', '-q', '--jq']);
const GH_API_READ_FLAGS = new Set(['--paginate', '--slurp']);

function ghApiIsRead(args: readonly string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (!arg.startsWith('-')) continue;
    const method = arg === '-X' || arg === '--method' ? args[++i] : /^-X(.+)$/.exec(arg)?.[1] ?? /^--method=(.*)$/.exec(arg)?.[1];
    if (method !== undefined) {
      if (method.toUpperCase() !== 'GET') return false;
      continue;
    }
    const name = arg.startsWith('--') && arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (GH_API_READ_FLAGS.has(arg)) continue;
    if (GH_API_READ_OPTIONS_WITH_VALUE.has(name)) {
      if (name === arg) i++;
      continue;
    }
    return false;
  }
  return true;
}

/** Whether `call` can change state outside this machine: any `git push`, and any `gh` call that is not one of
 *  the read-only calls above. A `gh` call this list does not name counts as a write. */
export function isOutwardWrite(call: ToolCall): boolean {
  if (call.tool === 'git') return gitSubcommand(call.argv).name === 'push';
  const [group = '', command = ''] = call.argv;
  if (group === 'api') return !ghApiIsRead(call.argv.slice(1));
  return !READ_ONLY_GH.has(`${group} ${command}`);
}

/** Whether `call` is a push that can overwrite a remote ref: `--force`, `-f` (alone or in a cluster), a `+`
 *  refspec, or any `--force-with-lease` form except the create-only `--force-with-lease=<ref>:`, which can
 *  overwrite nothing. */
export function isForcePush(call: ToolCall): boolean {
  if (call.tool !== 'git') return false;
  const { name, args } = gitSubcommand(call.argv);
  if (name !== 'push') return false;
  let options = true;
  for (const arg of args) {
    if (options && arg === '--') {
      options = false;
      continue;
    }
    if (options && arg.startsWith('--')) {
      if (arg === '--force' || arg === '--mirror') return true;
      if (arg === '--force-with-lease' || (arg.startsWith('--force-with-lease=') && !/^--force-with-lease=[^:]+:$/.test(arg))) return true;
      continue;
    }
    if (options && /^-[A-Za-z]+$/.test(arg)) {
      if (arg.includes('f')) return true;
      continue;
    }
    if (arg.startsWith('+')) return true;
  }
  return false;
}

/** Every outward write in `calls`, for an assertion that names what was written. */
export const outwardWrites = (calls: readonly ToolCall[]): ToolCall[] => calls.filter(isOutwardWrite);
/** Every force push in `calls`. */
export const forcePushes = (calls: readonly ToolCall[]): ToolCall[] => calls.filter(isForcePush);
