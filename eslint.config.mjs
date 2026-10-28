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

const CARD_HELPER_MESSAGE = 'Find controller cards through tests/helpers/controllerCards.ts.';
const CARD_DOM = [
  "CallExpression[callee.property.name=/^(querySelector|querySelectorAll|closest|matches|locator)$/][arguments.0.value=/(^|[\\s,>+~(])article\\b/]",
  "CallExpression[callee.property.name='getByRole'][arguments.0.value='article']",
  "CallExpression[callee.property.name='getByTestId'][arguments.0.value=/^card-/]",
].map((selector) => ({ selector, message: CARD_HELPER_MESSAGE }));
const SWITCH_HELPER_MESSAGE = 'Find the controller header switch through tests/helpers/controllerCards.ts.';
const SWITCH_DOM = [
  "CallExpression[callee.property.name=/^(querySelector|querySelectorAll|closest|matches|locator)$/][arguments.0.value=/role=[\"']?switch\\b/]",
  "CallExpression[callee.property.name='getByRole'][arguments.0.value='switch']",
].map((selector) => ({ selector, message: SWITCH_HELPER_MESSAGE }));
const NO_SLEEP_MESSAGE = 'Wait for an observed state (expect.poll, tests/e2e/controllerWindow.ts), never a fixed time.';
const NO_SLEEP = { selector: "CallExpression[callee.property.name='waitForTimeout']", message: NO_SLEEP_MESSAGE };
const NO_PROMISE_SLEEP = { selector: "NewExpression[callee.name='Promise'] CallExpression[callee.name='setTimeout']", message: NO_SLEEP_MESSAGE };
const PLATFORM_MESSAGE = 'Take the platform as a parameter; only the composition root src/main/controller.ts reads it (CODE-STANDARDS.md § Platform branches).';
const CONTROLLER_PLATFORM_READS = [
  { object: 'process', property: 'platform', message: PLATFORM_MESSAGE },
  { object: 'os', property: 'platform', message: PLATFORM_MESSAGE },
];
const CONTROLLER_PLATFORM_IMPORTS = ['os', 'node:os', 'process', 'node:process'].map((name) => ({ name, importNames: ['platform'], message: PLATFORM_MESSAGE }));
const CONTROLLER_TESTS = ['tests/**/controller*.ts', 'tests/**/clampedReason.test.ts', 'tests/**/themeToggle.test.ts'];
const CARD_HELPER = [
  'tests/helpers/controllerCards.ts',
  'tests/helpers/controllerCardsDom.ts',
  'tests/unit/controllerCards.test.ts',
  'tests/browser/controllerCards.test.ts',
];

export default [
  { ignores: ['node_modules/**', 'out/**', 'dist/**', 'build/**', 'coverage/**', '**/*.d.ts'] },
  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { local: localPlugin },
    rules: { 'local/no-todo-comments': 'error' },
  },
  {
    files: CONTROLLER_TESTS,
    ignores: CARD_HELPER,
    rules: { 'no-restricted-syntax': ['error', ...CARD_DOM, ...SWITCH_DOM, NO_SLEEP] },
  },
  {
    files: ['tests/e2e/controllerWindow*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...CARD_DOM, ...SWITCH_DOM, NO_SLEEP, NO_PROMISE_SLEEP],
      'no-restricted-imports': ['error', {
        paths: ['timers/promises', 'node:timers/promises'].map((name) => ({ name, importNames: ['setTimeout'], message: NO_SLEEP_MESSAGE })),
      }],
    },
  },
  {
    files: ['src/main/controller*.ts'],
    ignores: ['src/main/controller.ts'],
    rules: {
      'no-restricted-properties': ['error', ...CONTROLLER_PLATFORM_READS],
      'no-restricted-imports': ['error', { paths: CONTROLLER_PLATFORM_IMPORTS }],
    },
  },
];
