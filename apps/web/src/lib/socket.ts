'use client';

import { io, type Socket } from 'socket.io-client';
import { getToken } from './api';

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'http://localhost:4000';

let socket: Socket | null = null;

/**
 * One connection per tab. The token travels in the handshake — the server
 * subscribes the socket to the personal room itself, the client never picks it.
 */
export function getSocket(): Socket {
  if (!socket) {
    socket = io(WS_URL, {
      transports: ['websocket'],
      auth: { token: getToken() },
    });
  }
  return socket;
}
