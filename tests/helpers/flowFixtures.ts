// Real-fs fixtures for the flow validator: a flow folder in a chosen tier, minimal §27 v2 loop definitions with
// the files they reference, and a repository loop registry. Every destination comes from the resolver the app
// reads it through, and every value comes from the test, never from a shipped flow or loop.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { flowCatalogDir, flowHomeDir } from '../../src/main/flow';
import { FLOW_DEF_FILE } from '../../src/main/flowHome';
import { isTodoTemplateFile, todoTemplateFile, todoTemplatesDir } from '../../src/main/todoTemplate';
import { LOOP_OVERRIDE_FILE, LOOP_OVERRIDE_MAP_KEY, loopDefRelPath } from '../../src/main/appLoopPaths';
import { flowLoopsDir, resolveLoopDefV2, type LoopDefV2Lookup } from '../../src/main/loopDefV2';
import { resolveExampleFlowsDir, resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';
import type { GateAuthority } from '../../src/shared/gateAuthority';
import { userConfigLoopsV2Dir } from '../../src/main/userConfig';
import { APP_LOOP_NAMESPACE } from '../../src/shared/loopNamespace';
import { LOOP_DEF_V2_VERSION } from '../../src/shared/engineCapabilities/loop';

/** Throws unless the app resolves `loop` in `ctx` as `expected` says, so a fixture means what its test says. */
export function fixtureResolves(loop: string, ctx: LoopDefV2Lookup, expected: boolean): void {
  if (resolveLoopDefV2(loop, ctx).ok === expected) return;
  throw new Error(`fixture: the app ${expected ? 'does not resolve' : 'resolves'} ${loop} for ${ctx.repoDir ?? 'no repository'}`);
}

/** Where each tier keeps a flow folder or a loop tree. `repo` is the directory holding `.agent-terminal/`,
 *  `appHome` is the app-state home A, `tree` is the X of an `<X>/example/` bundle layout. */
export const flowLocations = {
  repoCatalogEntry: (repo: string, id: string): string => join(flowCatalogDir(repo), id),
  repoLocal: (repo: string): string => flowHomeDir(repo),
  globalCatalogEntry: (appHome: string, id: string): string => join(flowCatalogDir(appHome), id),
  globalFallback: (appHome: string): string => flowHomeDir(appHome),
  bundledEntry: (tree: string, id: string): string => join(resolveExampleFlowsDir({ packaged: false, appPath: tree }), id),
  bundledLoops: (tree: string): string => resolveExampleLoopsV2Dir({ packaged: false, appPath: tree }),
  operatorLoops(configDir: string): string {
    const root = userConfigLoopsV2Dir(configDir);
    if (root === null) throw new Error(`operatorLoops(): ${configDir} is not an absolute config dir`);
    return root;
  },
};

export type RepeatSpec =
  | { backTo: string; countInput: string }
  | { backTo: string; countFrom: { artifact: string; format: string; list?: string } }
  | { raw: Readonly<Record<string, unknown>> };

export type FlowStepSpec =
  | { id: string; kind: 'manual'; todoTemplate?: string }
  | {
      id: string;
      kind: 'loop';
      loop: string;
      /** Written as `loop_namespace`; `app` when omitted. */
      namespace?: string;
      todoTemplate?: string;
      repeat?: RepeatSpec;
      gateAuthority?: GateAuthority;
    };

export interface FlowSpec {
  name: string;
  steps: readonly FlowStepSpec[];
  /** Template files to create in the folder's own `todo-templates/`, each named as a run looks it up. */
  templates?: readonly string[];
}

function repeatDoc(repeat: RepeatSpec): Readonly<Record<string, unknown>> {
  if ('raw' in repeat) return repeat.raw;
  if ('countInput' in repeat) return { back_to: repeat.backTo, count_input: repeat.countInput };
  const { artifact, format, list } = repeat.countFrom;
  return { back_to: repeat.backTo, count_from: { artifact, format, ...(list === undefined ? {} : { list }) } };
}

function stepDoc(step: FlowStepSpec): Record<string, unknown> {
  const template = step.todoTemplate === undefined ? {} : { todo_template: step.todoTemplate };
  if (step.kind === 'manual') return { id: step.id, kind: 'manual', ...template };
  return {
    id: step.id,
    kind: 'loop',
    loop: step.loop,
    loop_namespace: step.namespace ?? APP_LOOP_NAMESPACE,
    ...template,
    ...(step.repeat === undefined ? {} : { repeat: repeatDoc(step.repeat) }),
    ...(step.gateAuthority === undefined ? {} : { gate_authority: step.gateAuthority }),
  };
}

/** Writes `<dir>/flow.yaml` and the spec's templates. Returns the flow.yaml path. */
export function writeFlow(dir: string, spec: FlowSpec): string {
  const file = writeFlowYamlText(dir, yaml.dump({ name: spec.name, steps: spec.steps.map(stepDoc) }));
  for (const ref of spec.templates ?? []) writeTodoTemplate(dir, ref);
  return file;
}

/** Writes `<dir>/flow.yaml` verbatim, for a definition no spec can express (invalid YAML). */
export function writeFlowYamlText(dir: string, text: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, FLOW_DEF_FILE);
  writeFileSync(file, text);
  return file;
}

/** Writes a one-todo template that a run resolves for `ref` in the flow folder's own `todo-templates/`. */
export function writeTodoTemplate(flowDir: string, ref: string): string {
  const file = join(todoTemplatesDir(flowDir), isTodoTemplateFile(ref) ? ref : todoTemplateFile(ref));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# ${ref}\n\n- a todo seeded by ${ref}\n`);
  return file;
}

export interface LoopDefSpec {
  brief?: string;
  /** The work recipe reference; `recipe.md` when omitted. */
  recipe?: string;
  /** A consolidator recipe reference, which turns review rounds on. */
  consolidator?: string;
  /** One reviewer per charter reference. */
  charters?: readonly string[];
  /** The `gate` list, written as given. */
  gate?: readonly Record<string, unknown>[];
  outputs?: Readonly<Record<string, string>>;
  artifact?: string;
  /** References written into the definition but never created on disk. */
  absent?: readonly string[];
  /** References created as directories instead of files. */
  directories?: readonly string[];
}

/** Writes `<loopsRoot>[/<flow>]/<name>/<name>.yaml`, a minimal v2 definition the loop loader accepts unless the
 *  spec makes it otherwise, and creates every reference it names that the spec does not hold back. Returns the
 *  definition file path. */
export function writeLoopDef(loopsRoot: string, name: string, spec: LoopDefSpec = {}, scope?: { flow: string }): string {
  const scoped = scope === undefined ? loopsRoot : flowLoopsDir(loopsRoot, scope.flow);
  if (scoped === null) throw new Error(`writeLoopDef(): no loop folder for flow ${scope?.flow ?? ''}`);
  const file = join(scoped, loopDefRelPath(name));
  const defDir = dirname(file);
  const recipe = spec.recipe ?? 'recipe.md';
  const charters = spec.charters ?? [];
  const doc = {
    version: LOOP_DEF_V2_VERSION,
    ...(spec.brief === undefined ? {} : { brief: spec.brief }),
    work: { recipe, artifact: spec.artifact ?? 'result' },
    reviewers: charters.map((charter, i) => ({ persona: `reviewer-${i + 1}`, charter })),
    ...(spec.consolidator === undefined ? {} : { consolidator: { recipe: spec.consolidator } }),
    boundaries: [],
    report: { sections: [] },
    gate: spec.gate ?? [],
    ...(spec.outputs === undefined ? {} : { outputs: Object.entries(spec.outputs).map(([id, path]) => ({ id, path })) }),
  };
  mkdirSync(defDir, { recursive: true });
  writeFileSync(file, yaml.dump(doc));
  const refs = [spec.brief, recipe, spec.consolidator, ...charters].filter((r): r is string => r !== undefined);
  for (const ref of refs) {
    if (spec.absent?.includes(ref)) continue;
    const target = resolve(defDir, ref);
    if (spec.directories?.includes(ref)) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${ref} for ${name}\n`);
  }
  return file;
}

/** Writes `<repo>/.agent-loop.yaml` mapping each loop name to a repository-relative definition path. */
export function writeLoopRegistry(repo: string, loops: Readonly<Record<string, string>>): string {
  mkdirSync(repo, { recursive: true });
  const file = join(repo, LOOP_OVERRIDE_FILE);
  writeFileSync(file, yaml.dump({ [LOOP_OVERRIDE_MAP_KEY]: loops }));
  return file;
}

/** A named pipe at `file`, which blocks whoever opens it for reading until a writer appears. */
export function writeFifo(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  execFileSync('mkfifo', [file]);
}
