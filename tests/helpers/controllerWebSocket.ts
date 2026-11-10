import { createServer } from 'node:http';
import { connect } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';

export function connectWebSocket(endpoint: string): WebSocket {
  return new WebSocket('ws://localhost', { createConnection: () => connect(endpoint), perMessageDeflate: false });
}

export function createWebSocketTestServer(onConnection: (socket: WebSocket) => void) {
  const server = createServer();
  const webSockets = new WebSocketServer({ server, perMessageDeflate: false });
  webSockets.on('connection', onConnection);
  return server;
}
