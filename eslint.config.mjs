import tseslint from 'typescript-eslint';

// Case-sensitive on purpose: the uppercase deferral marker the regex below matches is the convention this repo
// forbids, while the lowercase "todo"/"Todo" domain word (the Todo pane) and underscore-joined identifiers are
// legitimate code — the word boundary excludes the identifier forms, the case excludes the prose. Scans comment
// tokens only, so the same words inside string literals are ignored. CLAUDE.md: deferred work goes to a tracked
// GitHub issue, never a code comment. Documenting a legitimate external invariant/contract is never blocked:
// such a comment carries no deferral marker, and the rare comment whose subject IS the token opts out with an
// explicit `eslint-disable-next-line local/no-todo-comments`.
const MARKER = /\b(TODO|FIXME)\b/;

const localPlugin = {
  rules: {
    'no-todo-comments': {
      meta: {
        type: 'problem',
        docs: { description: 'Disallow TODO/FIXME deferral comments; track deferred work in a GitHub issue.' },
        messages: {
          found: 'Remove this {{term}} comment — deferred work goes to a tracked GitHub issue, not a code comment (CLAUDE.md).',
        },
        schema: [],
      },
      create(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              const match = MARKER.exec(comment.value);
              if (match) {
                context.report({ loc: comment.loc, messageId: 'found', data: { term: match[1] } });
              }
            }
          },
        };
      },
    },
  },
};

const AMBIENT = 'A bench module takes this as an argument; benchMainEntry.ts reads it from the process.';
const SHELL = 'Spawn with argv only, never shell text (CWE-78).';
const SHELL_IMPORTS = ['child_process', 'node:child_process'].map((name) => ({ name, importNames: ['default', 'exec', 'execSync'], message: SHELL }));
const SHELL_KEY = "Property:matches([key.name='shell'], [key.value='shell']):not([value.value=false])";
const SHELL_OPTION = { selector: `CallExpression[callee.name=/^(spawn|spawnSync|execFile|execFileSync)$/] > ObjectExpression > ${SHELL_KEY}`, message: SHELL };
const SHELL_SYNTAX = { selector: SHELL_KEY, message: SHELL };

export default [
  { ignores: ['node_modules/**', 'out/**', 'dist/**', 'build/**', 'coverage/**', '**/*.d.ts'] },
  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { local: localPlugin },
    rules: { 'local/no-todo-comments': 'error' },
  },
  {
    // A later block's options for the same rule replace these, so each block below repeats them.
    files: ['src/main/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', ...SHELL_IMPORTS],
      'no-restricted-syntax': ['error', SHELL_OPTION],
    },
  },
  {
    files: ['src/main/bench*.ts'],
    rules: {
      'no-restricted-imports': ['error', ...SHELL_IMPORTS],
      'no-restricted-syntax': ['error', SHELL_SYNTAX],
    },
  },
  {
    files: ['src/main/bench*.ts'],
    ignores: ['src/main/benchMainEntry.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...[['process', 'env'], ['process', 'cwd'], ['process', 'hrtime'], ['Date', 'now'], ['performance', 'now'], ['Math', 'random']].map(([object, property]) => ({
          object,
          property,
          message: AMBIENT,
        })),
        { property: 'homedir', message: AMBIENT },
      ],
      'no-restricted-imports': [
        'error',
        ...['os', 'node:os'].map((name) => ({ name, importNames: ['homedir'], message: AMBIENT })),
        ...['process', 'node:process'].map((name) => ({ name, importNames: ['env', 'cwd'], message: AMBIENT })),
        ...SHELL_IMPORTS,
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: AMBIENT },
        { selector: "CallExpression[callee.name='Date']", message: AMBIENT },
        { selector: 'CallExpression[callee.name=/^userConfig(Root|LoopsDir|LoopsV2Dir|CommandsDir|AgentsDir)$/][arguments.length=0]', message: AMBIENT },
        SHELL_SYNTAX,
      ],
    },
  },
];
