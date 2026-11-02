import path from 'node:path';
import type { Definition, EngineCapabilities, KeyCapability, KeyValues, PositionCapability } from '../shared/engineCapabilities';
import { FLOW_DEF_FILE, FLOW_HOME_SUBDIR, FLOWS_CATALOG_SUBDIR } from './flowHome';
import { APP_HOME_DIR_ENV } from './launchRoot';
import { LOOP_OVERRIDE_FILE, LOOP_OVERRIDE_MAP_KEY, loopDefRelPath } from './appLoopPaths';
import { CLAUDE_CONFIG_DEFAULT_SUBDIR, CLAUDE_CONFIG_DIR_ENV, LOOPS_V2_SUBDIR } from './userConfig';
import { ENGINE_GUIDE_FILE, EXAMPLE_SUBDIR } from './exampleAssets';

interface Section {
  level: number;
  heading: string;
  /** The table-of-contents text; a heading's code span may hold `]`, which a link text cannot. */
  tocText: string;
  body: string[];
}

const DEFINITIONS: readonly Definition[] = ['flow', 'loop'];
const code = (s: string): string => `\`${s}\``;
const join = path.posix.join;

/** GitHub-flavoured Markdown's heading anchor, before de-duplication. */
function slug(heading: string): string {
  return heading
    .replace(/`([^`]*)`/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function positionId(p: PositionCapability): string {
  return p.yamlPath === '' ? p.definition : `${p.definition}.${p.yamlPath}`;
}

function valueLines(caps: EngineCapabilities, values: KeyValues): string[] {
  switch (values.kind) {
    case 'any':
      return [];
    case 'closed':
      return [
        'Values:',
        '',
        ...values.values.map((v) => {
          const engine = v.selectsEngine === undefined ? '' : ` ${caps.markers.selectsEngine[v.selectsEngine ? 'yes' : 'no']}`;
          return `- ${code(String(v.value))} — ${v.does}${engine} When: ${v.when}`;
        }),
      ];
    case 'open':
      return ['Names the engine acts on:', '', ...values.acted.map((a) => `- ${code(a.name)} — ${a.does} When: ${a.when}`), '', values.otherNames];
    case 'not-checked-at-load':
      return [caps.markers.notCheckedAtLoad, '', ...values.outcomes.map((o) => `- ${o.text}`)];
    default:
      return values satisfies never;
  }
}

function keySection(caps: EngineCapabilities, key: KeyCapability): Section {
  const required = caps.markers.required[key.required.kind];
  const body = [
    key.does,
    '',
    `When: ${key.when}`,
    '',
    key.required.kind === 'conditional' ? `${required} ${key.required.condition}` : required,
    ...(key.rules.length > 0 ? ['', 'Rules the loader enforces:', '', ...key.rules.map((r) => `- ${r.text}`)] : []),
  ];
  const values = valueLines(caps, key.values);
  return { level: 4, heading: code(key.key), tocText: code(key.key), body: values.length > 0 ? [...body, '', ...values] : body };
}

function positionSections(caps: EngineCapabilities, p: PositionCapability): Section[] {
  const id = positionId(p);
  return [
    { level: 3, heading: code(id), tocText: id.replaceAll('[]', ''), body: [caps.markers.unreadKeys[p.unreadKeys]] },
    ...p.keys.map((k) => keySection(caps, k)),
  ];
}

function whereThingsLive(caps: EngineCapabilities): Section {
  const appHome = join('~', FLOW_HOME_SUBDIR);
  const config = join('~', CLAUDE_CONFIG_DEFAULT_SUBDIR);
  const flowEntry = join('<catalog-id>', FLOW_DEF_FILE);
  const loopDef = loopDefRelPath('<loop>');
  const flowLoopDef = join('<flow-name>', loopDef);
  return {
    level: 2,
    heading: caps.sectionTitles['where-things-live'],
    tocText: caps.sectionTitles['where-things-live'],
    body: [
      `Paths write your home directory as ${code('~')}, the repository the terminal runs in as ${code('<repo>')}, and the installed app's bundle as ${code('<app>')}. ${code('<catalog-id>')} is a catalog entry's folder name; ${code('<flow-name>')} is the flow definition's ${code('name')} value, which names the flow's own loop folder whatever its catalog folder is called. ${code(APP_HOME_DIR_ENV)}, set to an absolute path, replaces ${code('~')} in every ${code(appHome)} path. ${code(CLAUDE_CONFIG_DIR_ENV)}, set to an absolute path, replaces ${code(config)}.`,
      '',
      `- Repository flow: ${code(join('<repo>', FLOW_HOME_SUBDIR, FLOW_DEF_FILE))}, the flow the repository runs when no catalog flow is picked.`,
      `- Global flow: ${code(join(appHome, FLOW_DEF_FILE))}, the fallback for a repository with no flow of its own.`,
      `- Flow catalog: ${code(join(appHome, FLOWS_CATALOG_SUBDIR, flowEntry))} and ${code(join('<repo>', FLOW_HOME_SUBDIR, FLOWS_CATALOG_SUBDIR, flowEntry))}, the flows the picker offers; a repository entry wins over a global one of the same name.`,
      `- App-bundled flows: ${code(join('<app>', EXAMPLE_SUBDIR, FLOWS_CATALOG_SUBDIR, flowEntry))}, which Install examples copies into the flow catalog.`,
      `- Operator loop tier: ${code(join(config, LOOPS_V2_SUBDIR, loopDef))}, and a flow's own loops at ${code(join(config, LOOPS_V2_SUBDIR, flowLoopDef))}.`,
      `- App-bundled loop tier: ${code(join('<app>', EXAMPLE_SUBDIR, LOOPS_V2_SUBDIR, loopDef))}, and a flow's own loops at ${code(join('<app>', EXAMPLE_SUBDIR, LOOPS_V2_SUBDIR, flowLoopDef))}.`,
      `- Repository loop override: ${code(join('<repo>', LOOP_OVERRIDE_FILE))}, whose ${code(LOOP_OVERRIDE_MAP_KEY)} map gives a loop name the repository-relative path of its definition.`,
      `- This guide: ${code(join(appHome, ENGINE_GUIDE_FILE))}, replaced whole by every Install examples.`,
    ],
  };
}

function lookupOrder(caps: EngineCapabilities): Section {
  return {
    level: 2,
    heading: caps.sectionTitles['lookup-order'],
    tocText: caps.sectionTitles['lookup-order'],
    body: [
      `A ${code('loop')} step's definition is looked up in this order; the first one found wins.`,
      '',
      ...caps.lookupOrder.map((t, i) => `${i + 1}. ${t.text}`),
    ],
  };
}

function sections(caps: EngineCapabilities): Section[] {
  const byDefinition = DEFINITIONS.flatMap((d) => {
    const positions = caps.positions.filter((p) => p.definition === d);
    if (positions.length === 0) return [];
    const title = caps.definitionTitles[d];
    return [{ level: 2, heading: title, tocText: title, body: [] }, ...positions.flatMap((p) => positionSections(caps, p))];
  });
  return [...byDefinition, whereThingsLive(caps), lookupOrder(caps)];
}

export function renderEngineGuide(capabilities: EngineCapabilities): string {
  const all = sections(capabilities);
  const seen = new Map<string, number>();
  const anchorOf = (heading: string): string => {
    const s = slug(heading);
    const n = seen.get(s) ?? 0;
    seen.set(s, n + 1);
    return n === 0 ? s : `${s}-${n}`;
  };
  anchorOf(capabilities.title);
  const toc = all.map((s) => `${'  '.repeat(s.level - 2)}- [${s.tocText}](#${anchorOf(s.heading)})`);
  const body = all.flatMap((s) => [`${'#'.repeat(s.level)} ${s.heading}`, '', ...(s.body.length > 0 ? [...s.body, ''] : [])]);
  return [`# ${capabilities.title}`, '', capabilities.intro, '', ...toc, '', ...body].join('\n');
}
