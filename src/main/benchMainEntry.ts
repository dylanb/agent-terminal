import { homedir } from 'node:os';
import { benchMain, realBenchDeps } from './benchMain';

const env = { ...process.env, HOME: process.env.HOME || homedir() };
const print = (text: string): void => void process.stdout.write(text);
void benchMain(process.argv.slice(2), env, process.cwd(), realBenchDeps(process.execPath, __dirname, env, () => Date.now()), print).then(({ exitCode, output }) => {
  process.stdout.write(output);
  process.exit(exitCode);
});
