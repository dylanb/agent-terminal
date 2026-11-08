const SEPARATORS = new Set([';', '&', '|', '\n']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The words of each simple command on a shell command line, with quotes removed. A quoted `;` or `&&` stays
 *  inside its word, so `echo "x; claude"` is one command. */
function simpleCommands(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word: string | null = null;
  let quote: "'" | '"' | null = null;
  const endWord = (): void => {
    if (word !== null) words.push(word);
    word = null;
  };
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) word = (word ?? '') + line[(i += 1)];
      else word = (word ?? '') + ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      word ??= '';
    } else if (ch === '\\' && i + 1 < line.length) {
      word = (word ?? '') + line[(i += 1)];
    } else if (SEPARATORS.has(ch)) {
      endWord();
      if (words.length > 0) commands.push(words);
      words = [];
    } else if (ch === ' ' || ch === '\t') {
      endWord();
    } else {
      word = (word ?? '') + ch;
    }
  }
  endWord();
  if (words.length > 0) commands.push(words);
  return commands;
}

/** Whether any simple command on `line` runs a program named in `agents`, by its name or a path ending in it,
 *  after any leading `NAME=value` settings. */
export function runsAgentCommand(line: string, agents: readonly string[]): boolean {
  return simpleCommands(line).some((words) => {
    const program = words.find((w) => !ASSIGNMENT.test(w));
    return program !== undefined && agents.includes(program.slice(program.lastIndexOf('/') + 1));
  });
}
