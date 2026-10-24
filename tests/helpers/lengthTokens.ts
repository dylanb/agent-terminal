/// <reference lib="dom" />
// The non-colour tokens moved with the #245 token block, restated by hand like the colour table (plan R3).

export const LENGTH_TOKENS: Readonly<Record<string, string>> = {
  '--focus-ring-w': '2px',
  '--focus-ring-offset': '2px',
  '--focus-ring-extent': '4px',
  '--r': '7px',
};

export const UNRESOLVED_LENGTH = '1234px';

/** Each token's computed length, read through `padding-left`; an undefined token computes UNRESOLVED_LENGTH. */
export function paintLengths(names: readonly string[]): Record<string, string> {
  const probe = document.createElement('span');
  document.body.appendChild(probe);
  try {
    return Object.fromEntries(
      names.map((name) => {
        probe.style.paddingLeft = `var(${name}, ${UNRESOLVED_LENGTH})`;
        return [name, getComputedStyle(probe).paddingLeft];
      }),
    );
  } finally {
    probe.remove();
  }
}
