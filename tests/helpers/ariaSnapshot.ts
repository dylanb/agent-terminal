// https://playwright.dev/docs/aria-snapshots

export type AriaNode = { readonly role: string; readonly text: readonly string[]; readonly children: readonly AriaNode[] };

const NODE = /^( *)- ([a-z]+)(?: ("(?:[^"\\]|\\.)*"))?(?: \[[^\]]*\])*(?::(?: (.*))?)?$/;

const scalar = (value: string): string => (value.startsWith('"') ? (JSON.parse(value) as string) : value);

export function parseAriaSnapshot(snapshot: string): AriaNode[] {
  const roots: AriaNode[] = [];
  const open: { indent: number; children: AriaNode[] }[] = [{ indent: -1, children: roots }];
  for (const line of snapshot.split('\n').filter((l) => l.trim() !== '')) {
    const m = NODE.exec(line);
    if (!m) throw new Error(`unrecognised aria snapshot line: ${JSON.stringify(line)}`);
    const [, spaces, role, name, value] = m;
    const node: AriaNode = { role, text: [name, value].filter((t) => t !== undefined).map(scalar), children: [] };
    while (open[open.length - 1].indent >= spaces.length) open.pop();
    open[open.length - 1].children.push(node);
    open.push({ indent: spaces.length, children: node.children as AriaNode[] });
  }
  return roots;
}

export function exposedText(nodes: readonly AriaNode[]): string[] {
  return nodes.flatMap((node) => [...node.text, ...exposedText(node.children)]);
}

export function nodesWithRole(nodes: readonly AriaNode[], role: string): AriaNode[] {
  return nodes.flatMap((node) => [...(node.role === role ? [node] : []), ...nodesWithRole(node.children, role)]);
}

export const wholeText = (node: AriaNode): string => exposedText([node]).join(' ').replace(/\s+/g, ' ').trim();
