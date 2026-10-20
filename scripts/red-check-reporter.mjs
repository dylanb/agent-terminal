import { writeFileSync } from 'node:fs';
import path from 'node:path';

// §28.5.2
export default class RedCheckReporter {
  onTestRunEnd(modules, unhandledErrors) {
    const tests = [];
    for (const module of modules) {
      const file = path.relative(process.cwd(), module.moduleId).split(path.sep).join('/');
      if (module.errors().length || unhandledErrors.length) {
        tests.push({ file, name: '', outcome: 'errored', failures: [] });
      }
      for (const test of module.children.allTests()) {
        const result = test.result();
        const name = test.fullName.replace(/[\u0000-\u001f\u007f]/g, ' ');
        if (result.state !== 'failed') {
          tests.push({ file, name, outcome: result.state === 'passed' ? 'passed' : 'skipped', failures: [] });
          continue;
        }
        const failures = (result.errors ?? []).map(error => {
          const frame = error.stacks?.find(frame => frame.file === module.moduleId);
          return {
            line: frame?.line ?? null,
            message: `${error.name}: ${error.message}`.split('\n')[0],
            assertion: error.name === 'AssertionError',
          };
        });
        const assertion = failures.length > 0 && failures.every(f => f.assertion && Number.isInteger(f.line) && f.line > 0);
        tests.push({
          file, name, outcome: assertion ? 'failed-assertion' : 'errored',
          failures: failures.filter(f => f.line !== null).map(({ line, message }) => ({ line, message })),
        });
      }
    }
    writeFileSync(process.env.RED_CHECK_VITEST_OUTPUT, `${JSON.stringify({ tests })}\n`);
  }
}
