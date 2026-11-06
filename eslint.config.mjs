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
const INSTALLED_RUNTIME_MESSAGE =
  'Run the installed runtime through tests/e2e/installedRuntime.ts (--validate-flow: tests/e2e/validateFlowHarness.ts; installed launcher: tests/e2e/installedLauncher.ts), which gives every run a fully specified environment and owns every process it starts; wait for an observed state, never a fixed time.';
const INSTALLED_RUNTIME_SPEC_RULES = {
  'no-restricted-imports': ['error', {
    paths: [
      ...['child_process', 'node:child_process'].map((name) => ({ name, message: INSTALLED_RUNTIME_MESSAGE })),
      ...['timers/promises', 'node:timers/promises'].map((name) => ({ name, importNames: ['setTimeout'], message: INSTALLED_RUNTIME_MESSAGE })),
      ...['process', 'node:process'].map((name) => ({ name, importNames: ['env'], message: INSTALLED_RUNTIME_MESSAGE })),
      { name: './registeredElectron', message: INSTALLED_RUNTIME_MESSAGE },
      { name: '@playwright/test', importNames: ['_electron'], message: INSTALLED_RUNTIME_MESSAGE },
    ],
  }],
  'no-restricted-properties': ['error', { object: 'process', property: 'env', message: INSTALLED_RUNTIME_MESSAGE }],
  'no-restricted-syntax': ['error', ...[NO_SLEEP, NO_PROMISE_SLEEP].map(({ selector }) => ({ selector, message: INSTALLED_RUNTIME_MESSAGE }))],
};
const EXPECTED_RESULTS_FIXTURES = ['tests/helpers/controllerStatusFixture.ts', 'tests/helpers/controllerCards.ts', 'tests/helpers/engineCapabilityOracle.ts'];

const ONE_OF_MESSAGE =
  'Check a value against a closed list with isOneOf from src/shared/oneOf.ts, never a hand-written includes (CODE-STANDARDS.md § Closed lists).';
const ONE_OF = [
  "CallExpression[callee.property.name='includes'][callee.object.type='TSAsExpression']",
  "CallExpression[callee.property.name='includes'][callee.object.name=/^[A-Z][A-Z0-9_]*$/]",
].map((selector) => ({ selector, message: ONE_OF_MESSAGE }));

const ENGINE_GUIDE_PURE_MESSAGE =
  'The engine guide is generated pure and deterministic: it renders only its descriptor and the constants it is handed, so every build writes the same bytes. No file system, environment, clock, randomness or engine module.';
const ENGINE_GUIDE_PURE_RULES = {
  'no-restricted-globals': ['error', ...['process', '__dirname', '__filename'].map((name) => ({ name, message: ENGINE_GUIDE_PURE_MESSAGE }))],
  'no-restricted-properties': ['error',
    { object: 'Date', property: 'now', message: ENGINE_GUIDE_PURE_MESSAGE },
    { object: 'Math', property: 'random', message: ENGINE_GUIDE_PURE_MESSAGE },
  ],
  'no-restricted-syntax': ['error',
    { selector: ":matches(NewExpression, CallExpression)[callee.name='Date']", message: ENGINE_GUIDE_PURE_MESSAGE },
    { selector: "MemberExpression[property.name=/^(resolve|relative)$/]", message: ENGINE_GUIDE_PURE_MESSAGE },
    { selector: "MetaProperty[meta.name='import']", message: ENGINE_GUIDE_PURE_MESSAGE },
    ...ONE_OF,
  ],
};
const ENGINE_GUIDE_LEAVES = {
  appLoopPaths: ['APP_DONE_REL_PATH', 'APP_LOOP_DIR_SEGMENTS', 'ARTIFACTS_SUBDIR', 'LOOP_OVERRIDE_FILE', 'LOOP_OVERRIDE_MAP_KEY', 'loopDefRelPath'],
  flowHome: ['FLOW_HOME_SUBDIR', 'FLOW_DEF_FILE', 'FLOWS_CATALOG_SUBDIR', 'TODO_TEMPLATES_SUBDIR'],
  launchRoot: ['APP_HOME_DIR_ENV'],
  userConfig: ['LOOPS_V2_SUBDIR', 'CLAUDE_CONFIG_DIR_ENV', 'CLAUDE_CONFIG_DEFAULT_SUBDIR'],
  exampleAssets: ['EXAMPLE_SUBDIR', 'ENGINE_GUIDE_FILE'],
};
const ENGINE_GUIDE_LEAF_IMPORTS = Object.entries(ENGINE_GUIDE_LEAVES)
  .map(([leaf, allowImportNames]) => ({ name: `./${leaf}`, allowImportNames, message: ENGINE_GUIDE_PURE_MESSAGE }));
const ENGINE_GUIDE_PATH_IMPORTS = ['path', 'node:path']
  .map((name) => ({ name, importNames: ['resolve', 'relative'], message: ENGINE_GUIDE_PURE_MESSAGE }));

const TEST_PROOF_CORE_MESSAGE = 'The test-proof core decides from its seam values only: it reaches processes, the filesystem, the network, git and gh through its injected ports (CLAUDE.md § Test-driven development, injection seams).';
const TEST_PROOF_CORE_IMPORTS = [
  ...['child_process', 'fs', 'fs/promises', 'os', 'process', 'http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns'].flatMap((name) => [name, `node:${name}`]),
].map((name) => ({ name, message: TEST_PROOF_CORE_MESSAGE }));
const TEST_PROOF_CORE_SIBLINGS = [{ group: ['./*', '!./errno'], allowTypeImports: true, message: TEST_PROOF_CORE_MESSAGE }];

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
    files: ['src/**/*.{ts,tsx,mts,cts}'],
    ignores: ['src/shared/oneOf.ts'],
    rules: { 'no-restricted-syntax': ['error', ...ONE_OF] },
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
    files: ['tests/e2e/validateFlow*.spec.ts', 'tests/e2e/finalizeInstalledAccess.spec.ts'],
    rules: INSTALLED_RUNTIME_SPEC_RULES,
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
    rules: {
      'no-restricted-syntax': ['error', ...['ImportExpression', "CallExpression[callee.name='require']"].map((selector) => ({ selector, message: TEST_PROOF_CORE_MESSAGE }))],
      'no-restricted-imports': ['error', { paths: TEST_PROOF_CORE_IMPORTS }],
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: TEST_PROOF_CORE_SIBLINGS }],
      'no-restricted-globals': ['error', ...['process', 'fetch', 'WebSocket'].map((name) => ({ name, message: TEST_PROOF_CORE_MESSAGE }))],
    },
  },
  {
    files: ['src/renderer/**/*.ts'],
    ignores: ['src/renderer/src/pressable.ts'],
    rules: { 'no-restricted-syntax': ['error', ...RAW_CLICK, ...ONE_OF] },
  },
  {
    files: ['src/main/engineGuide.ts'],
    rules: {
      ...ENGINE_GUIDE_PURE_RULES,
      'no-restricted-imports': ['error', {
        paths: [...ENGINE_GUIDE_LEAF_IMPORTS, ...ENGINE_GUIDE_PATH_IMPORTS],
        patterns: [{
          regex: `^(?!\\.\\./shared/|\\./(${Object.keys(ENGINE_GUIDE_LEAVES).join('|')})$|(node:)?path$)`,
          message: ENGINE_GUIDE_PURE_MESSAGE,
        }],
      }],
    },
  },
  {
    files: ['src/shared/engineCapabilities/**/*.ts'],
    rules: {
      ...ENGINE_GUIDE_PURE_RULES,
      'no-restricted-imports': ['error', { patterns: [{ regex: '^(?!\\./|\\.\\./(?!\\.\\./))', message: ENGINE_GUIDE_PURE_MESSAGE }] }],
    },
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
