export function stepLabel(id: string): string {
  const spaced = id.replaceAll('-', ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
