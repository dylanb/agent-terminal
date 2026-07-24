import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const APP_COMMAND_TIMEOUT_MS = 60_000;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const GIT_REPOSITORY_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
] as const;

interface AppCommandOptions {
  stdin?: string;
  environment?: Record<string, string>;
}

function commandEnvironment(
  additions: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.GH_REPO;
  for (const key of GIT_REPOSITORY_ENV) delete environment[key];
  return { ...environment, ...additions };
}

function executeAppCommand(
  file: 'git' | 'gh',
  args: string[],
  cwd: string,
  options: AppCommandOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        cwd,
        timeout: APP_COMMAND_TIMEOUT_MS,
        env: commandEnvironment(options.environment),
      },
      (error, stdout) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const classification =
          typeof error.code === 'number' &&
          Number.isInteger(error.code) &&
          error.code >= 0 &&
          error.code <= 255
            ? `exit ${error.code}`
            : error.killed
              ? 'timed out'
              : 'could not start';
        reject(new Error(`${file} command failed (${classification})`));
      },
    );
    if (options.stdin === undefined) return;
    if (child.stdin === null) {
      child.kill();
      reject(new Error(`${file} command failed (could not write input)`));
      return;
    }
    child.stdin.on('error', () =>
      reject(new Error(`${file} command failed (could not write input)`)),
    );
    child.stdin.end(options.stdin);
  });
}

export function runAppCommand(
  file: 'git' | 'gh',
  args: string[],
  cwd: string,
  stdin?: string,
): Promise<string> {
  return executeAppCommand(file, args, cwd, { stdin });
}

export function parseAppGitObjectId(
  value: string,
  source: string,
): string {
  const oid = value.trim().toLowerCase();
  if (!OBJECT_ID.test(oid)) throw new Error(`invalid ${source} object id`);
  return oid;
}

export interface AppGitRemote {
  fetchRef(url: string, ref: string): Promise<string>;
  readRef(url: string, ref: string): Promise<string | null>;
  createRef(url: string, oid: string, ref: string): Promise<void>;
  deleteRef(url: string, ref: string, expectedOid: string): Promise<void>;
}

export function createAppGitRemote(repoDir: string): AppGitRemote {
  let layoutPromise:
    | Promise<{ objectDirectory: string; objectFormat: 'sha1' | 'sha256' }>
    | undefined;
  const layout = () =>
    (layoutPromise ??= Promise.all([
      runAppCommand(
        'git',
        [
          'rev-parse',
          '--path-format=absolute',
          '--git-path',
          'objects',
        ],
        repoDir,
      ),
      runAppCommand('git', ['rev-parse', '--show-object-format'], repoDir),
    ]).then(([objects, objectFormat]) => {
      const rawObjects = objects.trim();
      const format = objectFormat.trim();
      if (
        rawObjects.length === 0 ||
        (format !== 'sha1' && format !== 'sha256')
      ) {
        throw new Error('invalid local Git repository layout');
      }
      return {
        objectDirectory: isAbsolute(rawObjects)
          ? rawObjects
          : resolve(repoDir, rawObjects),
        objectFormat: format,
      };
    }));
  const isolated = async <T>(
    operation: (
      git: (args: string[]) => Promise<string>,
    ) => Promise<T>,
  ): Promise<T> => {
    const temporaryGitDir = await mkdtemp(
      join(tmpdir(), 'agent-terminal-git-remote-'),
    );
    try {
      const repository = await layout();
      await runAppCommand(
        'git',
        [
          'init',
          '--quiet',
          '--bare',
          `--object-format=${repository.objectFormat}`,
          temporaryGitDir,
        ],
        temporaryGitDir,
      );
      const git = (args: string[]): Promise<string> =>
        executeAppCommand(
          'git',
          ['--git-dir', temporaryGitDir, ...args],
          temporaryGitDir,
          {
            environment: {
              GIT_OBJECT_DIRECTORY: repository.objectDirectory,
            },
          },
        );
      return await operation(git);
    } finally {
      await rm(temporaryGitDir, { recursive: true, force: true });
    }
  };
  return {
    fetchRef: (url, ref) =>
      isolated(async (git) => {
        await git([
          'fetch',
          '--no-tags',
          '--no-recurse-submodules',
          '--',
          url,
          ref,
        ]);
        return parseAppGitObjectId(
          await git(['rev-parse', '--verify', 'FETCH_HEAD']),
          'fetched ref',
        );
      }),
    readRef: (url, ref) =>
      isolated(async (git) => {
        const output = (
          await git(['ls-remote', '--heads', '--', url, ref])
        ).trim();
        if (output.length === 0) return null;
        return parseAppGitObjectId(
          output.split(/\s+/, 1)[0] ?? '',
          'remote ref',
        );
      }),
    createRef: (url, oid, ref) =>
      isolated(async (git) => {
        const source = parseAppGitObjectId(oid, 'local ref');
        await git([
          'push',
          `--force-with-lease=${ref}:`,
          '--',
          url,
          `${source}:${ref}`,
        ]);
      }),
    deleteRef: (url, ref, expectedOid) =>
      isolated(async (git) => {
        const expected = parseAppGitObjectId(
          expectedOid,
          'expected remote ref',
        );
        await git([
          'push',
          `--force-with-lease=${ref}:${expected}`,
          '--',
          url,
          `:${ref}`,
        ]);
      }),
  };
}
