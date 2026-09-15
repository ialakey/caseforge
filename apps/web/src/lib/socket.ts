'use client';

import { io, type Socket } from 'socket.io-client';
import { getToken, onTokenChange } from './api';

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
      // A callback rather than a fixed value: the handshake runs again on every
      // reconnect, and by then the access token may have been renewed. Passing
      // the token once would pin the socket to whichever token happened to be
      // current at page load, and every reconnect after it expired would be
      // refused.
      auth: (cb: (data: Record<string, unknown>) => void) => cb({ token: getToken() }),
    });

    // A renewed token has to reach the server, which only reads it during the
    // handshake. Reconnecting is what re-runs that handshake, and it is cheap:
    // the personal room is re-joined from the new token.
    onTokenChange(() => {
      if (socket?.connected) {
        socket.disconnect().connect();
      }
    });
  }
  return socket;
}
