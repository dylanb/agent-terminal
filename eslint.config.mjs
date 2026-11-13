import tseslint from 'typescript-eslint';

// Case-sensitive on purpose: the uppercase deferral marker the regex below matches is the convention this repo
// forbids, while the lowercase "todo"/"Todo" domain word (the Todo pane) and underscore-joined identifiers are
// legitimate code — the word boundary excludes the identifier forms, the case excludes the prose. Scans comment
// tokens only, so the same words inside string literals are ignored. CLAUDE.md: deferred work goes to a tracked
// GitHub issue, never a code comment. Documenting a legitimate external invariant/contract is never blocked:
// such a comment carries no deferral marker, and the rare comment whose subject IS the token opts out with an
// explicit `eslint-disable-next-line local/no-todo-comments`.
const MARKER = /\b(TODO|FIXME)\b/;

// CWE-78, and Linux caps one argument at 131,072 bytes. An array is a gh argv when its first element is a gh
// command, so wrapper calls (`gh([...])`, `api([...])`) are caught as well as direct ones, and git's `-b` is not.
const GH_COMMANDS = new Set(['pr', 'issue', 'api', 'release', 'gist', 'repo']);
const BODY_FLAGS = new Set(['--body', '-b']);
const BODY_PREFIXES = ['--body=', 'body='];
/** The fixed leading text of a string literal or template literal element, or null for anything else. */
function leadingText(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral') return node.quasis[0]?.value.cooked ?? '';
  return null;
}

// The functions whose result leads a git argv with gitHardening.ts's overrides; bootstrapProtectedArgs adds the
// network hardening on top of them.
const GIT_HARDENING = new Set(['coreExecHardeningArgs', 'bootstrapProtectedArgs']);
/** The initializer of the const that `node` names, or null when it names anything else (a parameter, say). */
function constInit(context, node) {
  const variable = context.sourceCode.getScope(node).set.get(node.name)
    ?? findVariable(context.sourceCode.getScope(node), node.name);
  const def = variable?.defs[0];
  return def?.type === 'Variable' && def.parent.kind === 'const' ? def.node.init : null;
}
function findVariable(scope, name) {
  for (let s = scope; s !== null; s = s.upper) {
    const found = s.set.get(name);
    if (found !== undefined) return found;
  }
  return undefined;
}
function isHardening(context, node) {
  const value = node?.type === 'Identifier' ? constInit(context, node) : node;
  return value?.type === 'CallExpression' && value.callee.type === 'Identifier' && GIT_HARDENING.has(value.callee.name);
}
function leadsWithHardening(context, argv) {
  const array = argv?.type === 'Identifier' ? constInit(context, argv) : argv;
  const first = array?.type === 'ArrayExpression' ? array.elements[0] : null;
  return first?.type === 'SpreadElement' && isHardening(context, first.argument);
}

/** A rule that reports each `{ selector, message }` it is built with. Each concern is its own rule, so blocks that
 *  name the same file add their checks together; one `no-restricted-syntax` per file would keep only the last. */
function selectorRule(description, entries) {
  return {
    meta: { type: 'problem', docs: { description }, messages: { found: '{{message}}' }, schema: [] },
    create(context) {
      const handlers = {};
      for (const { selector, message } of entries) {
        const before = handlers[selector];
        handlers[selector] = (node) => {
          before?.(node);
          context.report({ node, messageId: 'found', data: { message } });
        };
      }
      return handlers;
    },
  };
}

const localPlugin = {
  rules: {
    'git-hardening': {
      meta: {
        type: 'problem',
        docs: { description: "Require a git call to lead its argv with gitHardening.ts's overrides." },
        messages: {
          found: "Lead this git argv with coreExecHardeningArgs(freshDisabledHooksDir()) (or bootstrapProtectedArgs), never a second copy (CODE-STANDARDS.md § Git in a checked-out repository).",
        },
        schema: [],
      },
      create(context) {
        return {
          CallExpression(node) {
            const [command, argv] = node.arguments;
            if (command?.type !== 'Literal' || command.value !== 'git') return;
            if (!leadsWithHardening(context, argv)) context.report({ node, messageId: 'found' });
          },
        };
      },
    },
    'no-gh-body-argv': {
      meta: {
        type: 'problem',
        docs: { description: 'Disallow passing a gh PR, issue or comment body as a command-line argument.' },
        messages: {
          found: 'Send this gh body on stdin (`--body-file -`, or `--input -` for gh api), never as a command-line argument (CODE-STANDARDS.md, CWE-78).',
        },
        schema: [],
      },
      create(context) {
        return {
          ArrayExpression(node) {
            if (!GH_COMMANDS.has(leadingText(node.elements[0]) ?? '')) return;
            for (const element of node.elements) {
              const text = leadingText(element);
              if (text === null) continue;
              if (BODY_FLAGS.has(text) || BODY_PREFIXES.some((prefix) => text.startsWith(prefix))) {
                context.report({ node: element, messageId: 'found' });
              }
            }
          },
        };
      },
    },
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
const SORT_CONTROL_HELPER_MESSAGE = 'Find the controller sort control through tests/helpers/controllerCards.ts.';
const SORT_CONTROL_DOM = [
  "CallExpression[callee.property.name=/^(querySelector|querySelectorAll|closest|matches|locator)$/][arguments.0.value=/role=[\"']?radio(group)?\\b/]",
  "CallExpression[callee.property.name='getByRole'][arguments.0.value=/^radio(group)?$/]",
].map((selector) => ({ selector, message: SORT_CONTROL_HELPER_MESSAGE }));
const NO_SLEEP_MESSAGE = 'Wait for an observed state (expect.poll, tests/e2e/controllerWindow.ts), never a fixed time.';
const NO_SLEEP = { selector: "CallExpression[callee.property.name='waitForTimeout']", message: NO_SLEEP_MESSAGE };
const NO_PROMISE_SLEEP = { selector: "NewExpression[callee.name='Promise'] CallExpression[callee.name='setTimeout']", message: NO_SLEEP_MESSAGE };
const PLATFORM_MESSAGE = 'Take the platform as a parameter; only the composition root src/main/controller.ts reads it (CODE-STANDARDS.md § Platform branches).';
const CONTROLLER_PLATFORM_READS = [
  { object: 'process', property: 'platform', message: PLATFORM_MESSAGE },
  { object: 'os', property: 'platform', message: PLATFORM_MESSAGE },
];
const CONTROLLER_PLATFORM_IMPORTS = ['os', 'node:os', 'process', 'node:process'].map((name) => ({ name, importNames: ['platform'], message: PLATFORM_MESSAGE }));
const TEST_WALL_CLOCK_MESSAGE = 'Drive time through the fake clock (tests/helpers/controllerMount.ts), never the wall clock.';
const TEST_WALL_CLOCK_READS = [
  { object: 'Date', property: 'now', message: TEST_WALL_CLOCK_MESSAGE },
  { object: 'performance', property: 'now', message: TEST_WALL_CLOCK_MESSAGE },
];
const TEST_NEW_DATE = { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: TEST_WALL_CLOCK_MESSAGE };
const CLOCK_SEAM_MESSAGE = 'Read time through the clock dependency the panes are given, never the wall clock or a timer of its own, so a test drives every time the controller shows (CLAUDE.md § Test-driven development, injection seams).';
const WINDOW_FOCUS_SEAM_MESSAGE = 'Read whether the controller window has focus through the window focus dependency the panes are given, so a test drives it (CLAUDE.md § Test-driven development, injection seams).';
const CLOCK_SEAM_READS = [
  { object: 'Date', property: 'now', message: CLOCK_SEAM_MESSAGE },
  { object: 'performance', property: 'now', message: CLOCK_SEAM_MESSAGE },
  ...['setTimeout', 'setInterval'].map((property) => ({ object: 'window', property, message: CLOCK_SEAM_MESSAGE })),
  { object: 'document', property: 'hasFocus', message: WINDOW_FOCUS_SEAM_MESSAGE },
];
const CLOCK_SEAM_GLOBALS = ['setTimeout', 'setInterval'].map((name) => ({ name, message: CLOCK_SEAM_MESSAGE }));
const CLOCK_SEAM_SYNTAX = { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: CLOCK_SEAM_MESSAGE };
const CARD_ORDER_CODE = ['src/renderer/src/controllerCardOrder.ts', 'src/renderer/src/controllerPanes.ts', 'src/renderer/src/controllerCard.ts', 'src/renderer/src/sortModeControl.ts'];
const LIVE_REGION_MESSAGE = 'A card, the card order and the sort control add no live region: a re-sort, a hold or a time-label tick announces nothing, and the controller panes own the role="status" and role="alert" regions.';
const LIVE_REGION = [
  "Literal[value='aria-live']",
  "MemberExpression[property.name='ariaLive']",
  "CallExpression[callee.property.name='setAttribute'][arguments.0.value='role'][arguments.1.value=/^(status|alert|log|marquee|timer)$/]",
].map((selector) => ({ selector, message: LIVE_REGION_MESSAGE }));
const QUIET_CARD_CODE = ['src/renderer/src/controllerCard.ts', 'src/renderer/src/controllerCardOrder.ts', 'src/renderer/src/sortModeControl.ts'];
const CARD_ORDER_TESTS = [
  'tests/unit/controllerCardOrder.test.ts',
  'tests/unit/controllerSortOrder.test.ts',
  'tests/unit/controllerRecentOrder.test.ts',
  'tests/unit/sortModeControl.test.ts',
  'tests/browser/controllerHold.test.ts',
  'tests/browser/controllerAttentionReading.test.ts',
  'tests/e2e/controllerAttentionOrder.spec.ts',
  'tests/e2e/controllerRecentOrder.spec.ts',
  'tests/e2e/controllerRecency.spec.ts',
  'tests/e2e/controllerHold.spec.ts',
  'tests/browser/controllerRecency.test.ts',
  'tests/browser/controllerLiveUpdate.test.ts',
  'tests/browser/controllerCardUpdate.test.ts',
];
const ZERO_DELAY_FLUSH_CARD_TESTS = ['tests/unit/controllerCard.test.ts', 'tests/unit/controllerFrozenList.test.ts', 'tests/unit/controllerRecencyInPlace.test.ts'];
const CONTROLLER_TESTS = ['tests/**/controller*.ts', 'tests/**/clampedReason.test.ts', 'tests/**/themeToggle.test.ts', 'tests/**/sortModeControl.test.ts'];
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
const EXPECTED_RESULTS_FIXTURES = [
  'tests/helpers/controllerStatusFixture.ts',
  'tests/helpers/controllerCards.ts',
  'tests/helpers/adoptionGh.ts',
  'tests/helpers/outwardWrites.ts',
  'tests/helpers/processTable.ts',
  'tests/helpers/controllerCardOrderFixture.ts',
  'tests/helpers/tokenCountsUi.ts',
  'tests/helpers/tokenFormatFixture.ts',
];

const INJECTED_TIME_MESSAGE =
  'Token counting reads time only through its injected now() and refresh scheduler; src/main/index.ts supplies the real ones (CLAUDE.md § Test-driven development, injection seams).';
const TOKEN_COUNTING = ['src/main/stepTokens.ts', 'src/main/tokenMeter.ts', 'src/main/agentUsage/**/*.ts'];

const TOKEN_HELPER = 'tests/helpers/tokenCountsUi.ts';
const TOKEN_HELPER_MESSAGE = `Read token counts through ${TOKEN_HELPER} (UI-STANDARDS §3.4 rule 1).`;
const TOKEN_NAME = '/\\btoken-(count|run-total)\\b|^(Tokens by step|Flow steps)$/';
const TOKEN_DOM = [`Literal[value=${TOKEN_NAME}]`, `TemplateElement[value.raw=${TOKEN_NAME}]`].map((selector) => ({ selector, message: TOKEN_HELPER_MESSAGE }));

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

const WAITING_CORE_MESSAGE = 'The Waiting detection core decides from its seam values only: the process table, the helper names, the clock, its timers and the platform reach it as parameters or injected deps, built at the composition root; src/main/waitingLookup.ts and src/main/waitingHelperFile.ts are its I/O.';
const WAITING_IO = ['src/main/waitingLookup.ts', 'src/main/waitingHelperFile.ts'];
const WAITING_NEVER_BLOCKS_MESSAGE = 'Waiting detection never blocks the main process: run ps through the asynchronous child_process API, abandoned through an injected bound (an AbortSignal the detector\'s injected timer aborts, passed as execFile\'s signal), never execFile\'s real-time timeout option.';
const WAITING_NEVER_BLOCKS = ['child_process', 'node:child_process'].map((name) => ({ name, importNames: ['default', 'execFileSync', 'execSync', 'spawnSync'], message: WAITING_NEVER_BLOCKS_MESSAGE }));
const WAITING_PLATFORM_MESSAGE = 'Waiting detection takes the platform as a parameter; only the composition root src/main/index.ts reads it (CODE-STANDARDS.md § Platform branches).';
const WAITING_PLATFORM_READS = CONTROLLER_PLATFORM_READS.map((read) => ({ ...read, message: WAITING_PLATFORM_MESSAGE }));
const WAITING_PLATFORM_IMPORTS = ['os', 'node:os', 'process', 'node:process'].map((name) => ({ name, importNames: ['platform'], message: WAITING_PLATFORM_MESSAGE }));
const WAITING_TIMERS = ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'];
const WAITING_TIMER_MODULES = ['timers', 'timers/promises', 'perf_hooks'].flatMap((name) => [name, `node:${name}`]);
const WAITING_NO_REAL_TIME_BOUND = [
  ...['ImportExpression', "CallExpression[callee.name='require']"],
  "ObjectExpression > Property:matches([key.name='timeout'], [key.value='timeout'])",
].map((selector) => ({ selector, message: WAITING_NEVER_BLOCKS_MESSAGE }));
const WAITING_FAMILY_PROPERTIES = [
  ...WAITING_PLATFORM_READS,
  ...WAITING_TIMERS.map((property) => ({ object: 'globalThis', property, message: WAITING_NEVER_BLOCKS_MESSAGE })),
  { object: 'AbortSignal', property: 'timeout', message: WAITING_NEVER_BLOCKS_MESSAGE },
];
function waitingCoreRules() {
  const rules = pureCoreRules(WAITING_CORE_MESSAGE, ['errno', 'waiting*']);
  const [, imports] = rules['@typescript-eslint/no-restricted-imports'];
  imports.patterns[0].group.push(...WAITING_IO.map((file) => `./${file.slice('src/main/'.length, -'.ts'.length)}`));
  const clock = [...WAITING_TIMERS, 'Date', 'performance'];
  rules['no-restricted-globals'].push(...clock.map((name) => ({ name, message: WAITING_CORE_MESSAGE })));
  rules['no-restricted-properties'] = ['error', ...WAITING_FAMILY_PROPERTIES, ...clock.map((property) => ({ object: 'globalThis', property, message: WAITING_CORE_MESSAGE }))];
  const [, paths] = rules['no-restricted-imports'];
  paths.paths.push(...WAITING_TIMER_MODULES.map((name) => ({ name, message: WAITING_CORE_MESSAGE })));
  return rules;
}

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

const CONTROLLER_WAIT_TESTS = ['tests/e2e/controllerWindow*.ts', ...CARD_ORDER_TESTS];

Object.assign(localPlugin.rules, {
  'card-helper': selectorRule('Find controller cards through the card helper.', CARD_DOM),
  'switch-helper': selectorRule('Find the controller header switch through the card helper.', SWITCH_DOM),
  'sort-control-helper': selectorRule('Find the controller sort control through the card helper.', SORT_CONTROL_DOM),
  'protocol-constants': selectorRule('Build controller messages with the protocol version constants.', TYPED_IN_VERSION),
  'no-test-sleep': selectorRule('Wait for an observed state, never a fixed time.', [NO_SLEEP]),
  'no-promise-sleep': selectorRule('Never sleep on a timer inside a promise.', [NO_PROMISE_SLEEP]),
  'no-test-new-date': selectorRule('Drive time through the fake clock, never the wall clock.', [TEST_NEW_DATE]),
  pressable: selectorRule('Run a control\'s action through pressable.ts.', RAW_CLICK),
  'clock-seam': selectorRule('Read time through the clock dependency.', [CLOCK_SEAM_SYNTAX]),
  'no-live-region': selectorRule('A card, the card order and the sort control add no live region.', LIVE_REGION),
  'token-helper': selectorRule('Read token counts through the token-count helper.', TOKEN_DOM),
  'setup-dialog-screen': selectorRule('Read the setup dialog through its screen helper.', SETUP_DIALOG_DOM),
});

export default [
  { ignores: ['node_modules/**', 'out/**', 'dist/**', 'build/**', 'coverage/**', '**/*.d.ts'] },
  {
    files: ['**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { local: localPlugin },
    rules: { 'local/no-todo-comments': 'error' },
  },
  {
    files: ['tests/**/*.ts'],
    ignores: [TOKEN_HELPER, 'tests/unit/tokenCountsUiLint.test.ts'],
    rules: { 'local/token-helper': 'error' },
  },
  {
    files: ['src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}', 'scripts/**/*.{ts,mts,cts,js,mjs,cjs}'],
    rules: { 'local/no-gh-body-argv': 'error' },
  },
  {
    files: ['src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}'],
    rules: { 'local/git-hardening': 'error' },
  },
  {
    files: CONTROLLER_TESTS,
    ignores: CARD_HELPER,
    rules: { 'local/card-helper': 'error', 'local/sort-control-helper': 'error' },
  },
  {
    files: CONTROLLER_TESTS,
    ignores: WIRE_FORMAT_TESTS,
    rules: { 'local/protocol-constants': 'error' },
  },
  {
    files: [...WIRE_FORMAT_TESTS, ...CONTROLLER_WAIT_TESTS],
    rules: { 'local/switch-helper': 'error', 'local/no-test-sleep': 'error' },
  },
  {
    files: CONTROLLER_WAIT_TESTS,
    rules: {
      'local/no-promise-sleep': 'error',
      'no-restricted-imports': ['error', {
        paths: ['timers/promises', 'node:timers/promises'].map((name) => ({ name, importNames: ['setTimeout'], message: NO_SLEEP_MESSAGE })),
      }],
    },
  },
  {
    files: [...CARD_ORDER_TESTS, ...ZERO_DELAY_FLUSH_CARD_TESTS],
    rules: { 'local/no-test-new-date': 'error', 'no-restricted-properties': ['error', ...TEST_WALL_CLOCK_READS] },
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
    files: WAITING_IO,
    rules: {
      'no-restricted-imports': ['error', { paths: [...WAITING_NEVER_BLOCKS, ...WAITING_PLATFORM_IMPORTS, ...WAITING_TIMER_MODULES.map((name) => ({ name, message: WAITING_NEVER_BLOCKS_MESSAGE }))] }],
      'no-restricted-properties': ['error', ...WAITING_FAMILY_PROPERTIES],
      'no-restricted-globals': ['error', ...WAITING_TIMERS.map((name) => ({ name, message: WAITING_NEVER_BLOCKS_MESSAGE }))],
      'no-restricted-syntax': ['error', ...WAITING_NO_REAL_TIME_BOUND],
    },
  },
  {
    files: ['src/main/waiting*.ts'],
    ignores: WAITING_IO,
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: waitingCoreRules(),
  },
  {
    files: ['src/renderer/src/setupCheckDialog.ts'],
    rules: { 'no-restricted-globals': ['error', ...['window', 'document'].map((name) => ({ name, message: SETUP_DIALOG_DEPS_MESSAGE }))] },
  },
  {
    files: ['tests/**/setupCheckDialog*.test.ts'],
    rules: { 'local/setup-dialog-screen': 'error' },
  },
  {
    files: TOKEN_COUNTING,
    rules: {
      'no-restricted-properties': ['error', ...[['Date', 'now'], ['performance', 'now']].map(([object, property]) => ({ object, property, message: INJECTED_TIME_MESSAGE }))],
      'no-restricted-syntax': ['error', ...["NewExpression[callee.name='Date'][arguments.length=0]", "CallExpression[callee.name='Date']"].map((selector) => ({ selector, message: INJECTED_TIME_MESSAGE }))],
      'no-restricted-globals': ['error', ...['setTimeout', 'setInterval'].map((name) => ({ name, message: INJECTED_TIME_MESSAGE }))],
      'no-restricted-imports': ['error', {
        paths: ['timers', 'node:timers', 'timers/promises', 'node:timers/promises'].map((name) => ({
          name,
          importNames: ['setTimeout', 'setInterval', 'scheduler'],
          message: INJECTED_TIME_MESSAGE,
        })),
      }],
    },
  },
  {
    files: ['src/renderer/**/*.ts'],
    ignores: ['src/renderer/src/pressable.ts'],
    rules: { 'local/pressable': 'error' },
  },
  {
    files: CARD_ORDER_CODE,
    rules: {
      'local/clock-seam': 'error',
      'no-restricted-properties': ['error', ...CLOCK_SEAM_READS],
      'no-restricted-globals': ['error', ...CLOCK_SEAM_GLOBALS],
    },
  },
  {
    files: QUIET_CARD_CODE,
    rules: { 'local/no-live-region': 'error' },
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
