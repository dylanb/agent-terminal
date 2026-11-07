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
const PROTOCOL_MESSAGE = 'Build a controller message with CONTROLLER_PROTOCOL_MAJOR / CONTROLLER_PROTOCOL_MINOR from src/shared/controllerProtocol.ts, never a typed-in version (CODE-STANDARDS.md § Test stand-ins speak the protocol through its own module).';
const TYPED_IN_VERSION = [
  "CallExpression[callee.name='encodeControllerMessage'] ObjectExpression > Property[key.name=/^(version|minor)$/] > Literal",
  "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'] > ObjectExpression:has(> Property[key.name='type']) > Property[key.name=/^(version|minor)$/] > Literal",
].map((selector) => ({ selector, message: PROTOCOL_MESSAGE }));
const WIRE_FORMAT_TESTS = [
  'tests/unit/controllerProtocol.test.ts',
  'tests/unit/controllerNotificationProtocol.test.ts',
  'tests/unit/controllerStatusBounds.test.ts',
  'tests/unit/controllerStatusProtocol.test.ts',
  'tests/integration/controllerVersion.test.ts',
  'tests/integration/controllerWebSocket.test.ts',
  'tests/e2e/controllerWireVersion.spec.ts',
];
const EXPECTED_RESULTS_FIXTURES = ['tests/helpers/controllerStatusFixture.ts', 'tests/helpers/controllerCards.ts', 'tests/helpers/adoptionGh.ts', 'tests/helpers/outwardWrites.ts'];

const IO_BUILTINS = ['child_process', 'fs', 'fs/promises', 'os', 'process', 'http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns'].flatMap((name) => [name, `node:${name}`]);
/** A decision core in src/main: no I/O built-in, no `process`/`fetch`/`WebSocket` global, no `require` or dynamic
 *  `import()`, and no value import of a src/main sibling except `allowedSiblings`; type imports and src/shared stay allowed. */
function pureCoreRules(message, allowedSiblings) {
  return {
    'no-restricted-syntax': ['error', ...['ImportExpression', "CallExpression[callee.name='require']"].map((selector) => ({ selector, message }))],
    'no-restricted-imports': ['error', { paths: IO_BUILTINS.map((name) => ({ name, message })) }],
    '@typescript-eslint/no-restricted-imports': ['error', { patterns: [{ group: ['./*', ...allowedSiblings.map((sibling) => `!./${sibling}`)], allowTypeImports: true, message }] }],
    'no-restricted-globals': ['error', ...['process', 'fetch', 'WebSocket'].map((name) => ({ name, message }))],
  };
}
const TEST_PROOF_CORE_MESSAGE = 'The test-proof core decides from its seam values only: it reaches processes, the filesystem, the network, git and gh through its injected ports (CLAUDE.md § Test-driven development, injection seams).';
const SETUP_CHECK_CORE_MESSAGE = 'The setup-check core decides from its seam values only: git, the installer, the capabilities reader, the dismissal store and the environment reach it through createSetupCheck\'s deps, built at the composition root (CLAUDE.md § Test-driven development, injection seams).';

const SETUP_DIALOG_DEPS_MESSAGE = 'The setup dialog reaches the app only through its injected deps and its own host (host.ownerDocument), never window or document (UI-STANDARDS.md §2.2).';
const SETUP_DIALOG_SCREEN_MESSAGE = 'Read the setup dialog by role and name through tests/helpers/setupCheckScreen.ts (UI-STANDARDS.md §3.4 rule 1).';
const SETUP_DIALOG_DOM = [
  { selector: "CallExpression[callee.property.name=/^(querySelector|querySelectorAll|closest|matches|getElementById|getElementsByClassName|getElementsByTagName)$/]", message: SETUP_DIALOG_SCREEN_MESSAGE },
];

const PRESS_HELPER_MESSAGE =
  'Run a control\'s action through createPressGroup/onPress in src/renderer/src/pressable.ts, so a press cannot start it again while it is still running (UI-STANDARDS §1.4).';
const RAW_CLICK = [
  "CallExpression[callee.property.name='addEventListener'][arguments.0.value='click']",
  "CallExpression[callee.property.name='addEventListener'][arguments.0.type='TemplateLiteral'][arguments.0.quasis.0.value.cooked='click']",
  "AssignmentExpression[left.property.name='onclick']",
].map((selector) => ({ selector, message: PRESS_HELPER_MESSAGE }));

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
    ignores: [...CARD_HELPER, ...WIRE_FORMAT_TESTS],
    rules: { 'no-restricted-syntax': ['error', ...CARD_DOM, ...TYPED_IN_VERSION] },
  },
  {
    files: CARD_HELPER,
    ignores: WIRE_FORMAT_TESTS,
    rules: { 'no-restricted-syntax': ['error', ...TYPED_IN_VERSION] },
  },
  {
    files: WIRE_FORMAT_TESTS,
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
  {
    files: ['src/main/testProof*.ts'],
    ignores: ['src/main/testProofPorts.ts', 'src/main/testProofResults.ts', 'src/main/testProofMain.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: pureCoreRules(TEST_PROOF_CORE_MESSAGE, ['errno']),
  },
  {
    files: ['src/main/setupCheck.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: pureCoreRules(SETUP_CHECK_CORE_MESSAGE, ['errno']),
  },
  {
    files: ['src/renderer/src/setupCheckDialog.ts'],
    rules: { 'no-restricted-globals': ['error', ...['window', 'document'].map((name) => ({ name, message: SETUP_DIALOG_DEPS_MESSAGE }))] },
  },
  {
    files: ['tests/**/setupCheckDialog*.test.ts'],
    rules: { 'no-restricted-syntax': ['error', ...SETUP_DIALOG_DOM] },
  },
  {
    files: ['src/renderer/**/*.ts'],
    ignores: ['src/renderer/src/pressable.ts'],
    rules: { 'no-restricted-syntax': ['error', ...RAW_CLICK] },
  },
  {
    files: EXPECTED_RESULTS_FIXTURES,
    rules: {
      'no-restricted-imports': ['error', { patterns: [{
        regex: '(^|/)src/(?!shared/ipc(/|$))',
        message: 'An expected-results fixture is written independently of the code it checks; import only the IPC contract from src/ (CODE-STANDARDS.md § Expected results are written independently of the code they check).',
      }] }],
    },
  },
];
