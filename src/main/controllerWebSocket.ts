import { CONTROLLER_MAX_STATUS_BYTES } from '../shared/controllerProtocol';

export const controllerWebSocketOptions = {
  maxPayload: CONTROLLER_MAX_STATUS_BYTES,
  maxFragments: 1024,
  maxBufferedChunks: 1024,
  perMessageDeflate: false,
};
