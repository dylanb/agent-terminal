import { expect, it } from 'vitest';
import '../../src/renderer/src/styles.css';
import { createControllerPanes } from '../../src/renderer/src/controllerPanes';
import { statusService } from '../helpers/controllerStatusFixture';

it.each(['light', 'dark'])('shows active work in the signal color in %s theme', theme => {
  document.documentElement.dataset.theme = theme;
  const host = document.createElement('main');
  document.body.append(host);
  const panes = createControllerPanes(host, { controller: statusService().api });
  const token = document.createElement('span');
  token.style.color = 'var(--signal-text)';
  host.append(token);
  try {
    const label = [...host.querySelectorAll('span')].find(element => element.textContent === 'Active')!;
    expect(getComputedStyle(label).color).toBe(getComputedStyle(token).color);
  } finally { panes.dispose(); host.remove(); document.documentElement.removeAttribute('data-theme'); }
});
