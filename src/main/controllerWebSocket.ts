import { CONTROLLER_MAX_STATUS_BYTES } from '../shared/controllerProtocol';

/** Both peers accept one bounded JSON message; ws owns framing and UTF-8 validation. */
export const controllerWebSocketOptions = {
  maxPayload: CONTROLLER_MAX_STATUS_BYTES,
  maxFragments: 1024,
  maxBufferedChunks: 1024,
  perMessageDeflate: false,
};
