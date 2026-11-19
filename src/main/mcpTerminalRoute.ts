interface TerminalProcess {
  pid: number;
  parent: number;
  state: string;
  group: number;
  foreground: number;
  terminal: string;
}

export interface TerminalRecipient {
  identity: string;
  pane?: string;
}

export function terminalRecipient(snapshot: string, caller: number, shell: number, clients = ''): TerminalRecipient | null {
  const processes = new Map<number, TerminalProcess>();
  for (const line of snapshot.trim().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) return null;
    const [, pid, parent, state, group, foreground, terminal] = match;
    processes.set(Number(pid), { pid: Number(pid), parent: Number(parent), state, group: Number(group), foreground: Number(foreground), terminal });
  }
  const paneClients = new Map<number, { client: number; pane: string }[]>();
  for (const line of clients.trim().split('\n')) {
    const match = /^(\d+) (\d+) 0 0 root 0 (%\d+)$/.exec(line);
    if (!match) continue;
    const [, client, pane, target] = match;
    paneClients.set(Number(pane), [...(paneClients.get(Number(pane)) ?? []), { client: Number(client), pane: target }]);
  }
  const walk = (pid: number, visited: ReadonlySet<number>, foreground: boolean): { route: number[]; pane?: string } | null => {
    if (visited.has(pid) || visited.size >= 256) return null;
    const process = processes.get(pid);
    if (!process || !/^[RSIDU]/.test(process.state) || process.foreground <= 0) return null;
    if (foreground && process.group !== process.foreground) return null;
    if (pid === shell) return { route: [pid] };
    const seen = new Set(visited).add(pid);
    for (const client of paneClients.get(pid) ?? []) {
      const route = walk(client.client, seen, true);
      if (route) return { route: [pid, ...route.route], pane: client.pane };
    }
    const parent = processes.get(process.parent);
    if (!parent) return null;
    const route = walk(parent.pid, seen, parent.terminal !== process.terminal);
    return route ? { ...route, route: [pid, ...route.route] } : null;
  };
  const route = walk(caller, new Set(), true);
  return route === null ? null : { pane: route.pane, identity: JSON.stringify([route.pane, route.route.map(pid => {
    const process = processes.get(pid)!;
    return [pid, process.parent, process.group, process.foreground, process.terminal];
  })]) };
}
