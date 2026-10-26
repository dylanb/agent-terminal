export function readable(host: HTMLElement, text: string, root: HTMLElement = host): boolean {
  const hostBox = host.getBoundingClientRect();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const start = node.textContent?.indexOf(text) ?? -1;
    if (start < 0) continue;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + text.length);
    const boxes = [...range.getClientRects()];
    if (boxes.length > 0 && boxes.every(box => box.width > 0 && box.height > 0
      && box.left >= hostBox.left && box.right <= hostBox.right
      && box.top >= hostBox.top && box.bottom <= hostBox.bottom
      && [...ancestors(node.parentElement!)].every(parent => {
        const style = getComputedStyle(parent);
        const clip = parent.getBoundingClientRect();
        return style.visibility === 'visible' && Number(style.opacity) > 0
          && (style.overflowX === 'visible' || (box.left >= clip.left && box.right <= clip.right))
          && (style.overflowY === 'visible' || (box.top >= clip.top && box.bottom <= clip.bottom));
      }))) return true;
  }
  return false;
}

function* ancestors(element: Element): Generator<Element> {
  for (let current: Element | null = element; current; current = current.parentElement) yield current;
}
