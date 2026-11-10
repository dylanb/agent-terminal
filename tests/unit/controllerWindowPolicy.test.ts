import { expect, it } from 'vitest';
import { controllerCloseAction } from '../../src/main/controllerWindowPolicy';

it('hides the closed controller window on macOS and minimizes it on Linux', () => {
  expect({ darwin: controllerCloseAction('darwin'), linux: controllerCloseAction('linux') }).toEqual({ darwin: 'hide', linux: 'minimize' });
});
