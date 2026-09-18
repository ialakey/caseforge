'use client';

import type { ApiErrorBody } from '@caseforge/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const TOKEN_KEY = 'access_token';

/** Called whenever a refresh mints a new access token, so the socket can follow. */
type TokenListener = (token: string | null) => void;
const tokenListeners = new Set<TokenListener>();

export function onTokenChange(listener: TokenListener): () => void {
  tokenListeners.add(listener);
  return () => {
    tokenListeners.delete(listener);
  };
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private browsing — carry on without persisting the session.
  }
  for (const listener of tokenListeners) listener(token);
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Machine-readable code so the interface can translate the error. */
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * The refresh currently in flight, if any.
 *
 * A page load fires several requests at once — the profile alone asks for the
 * inventory, the seeds and the openings. When the access token has expired they
 * all come back 401 together, and without this every one of them would start
 * its own refresh. The extra calls would rotate the refresh cookie repeatedly
 * and the losers of the race would retry with a token that had already been
 * replaced, which looks exactly like the session dropping at random.
 */
let refreshing: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  refreshing ??= (async () => {
    try {
      const response = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        // The refresh token is an httpOnly cookie: the browser sends it, and
        // script on the page can neither read nor leak it.
        credentials: 'include',
      });
      if (!response.ok) return null;
      const { accessToken } = (await response.json()) as { accessToken: string };
      setToken(accessToken);
      return accessToken;
    } catch {
      return null;
    } finally {
      // Cleared in a microtask rather than immediately, so callers that are
      // already awaiting this promise all observe the same result before the
      // next refresh can begin.
      queueMicrotask(() => {
        refreshing = null;
      });
    }
  })();
  return refreshing;
}

function buildInit(init: RequestInit, token: string | null): RequestInit {
  return {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  };
}

/**
 * Calls the API, renewing the access token behind the caller's back.
 *
 * The access token is deliberately short-lived, so a session that outlives it
 * is the normal case rather than the exception: a player who opens a case, goes
 * away for lunch and comes back must not find themselves signed out. The
 * refresh cookie is good for a month, so a 401 is answered by spending it for a
 * fresh access token and replaying the request once. Only a refresh that itself
 * fails ends the session.
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const attempt = (token: string | null): Promise<Response> =>
    fetch(`${API_URL}${path}`, buildInit(init, token));

  let response = await attempt(getToken());

  // The auth endpoints are excluded: /refresh answering 401 means the refresh
  // token is gone, and retrying it would recurse.
  if (response.status === 401 && !path.startsWith('/api/auth/')) {
    const renewed = await refreshAccessToken();
    if (renewed) {
      response = await attempt(renewed);
    } else {
      // The session is genuinely over. Drop the dead token so the interface
      // shows a signed-out state instead of retrying with it on every call.
      if (getToken()) setToken(null);
    }
  }

  if (!response.ok) {
    // The server returns a human-readable message and a machine-readable code.
    // The code is what the interface translates; the message is the fallback
    // for codes a build does not know yet.
    const payload = (await response.json().catch(() => null)) as ApiErrorBody | null;
    const message = payload?.message ?? `Request failed with ${response.status}`;
    throw new ApiError(
      Array.isArray(message) ? message.join(', ') : message,
      response.status,
      payload?.code,
    );
  }

  return response.json() as Promise<T>;
}

export const loginUrl = `${API_URL}/api/auth/steam`;

/**
 * Fetches a file and saves it, with the session attached.
 *
 * A plain `<a download>` cannot carry the access token, and a financial export
 * is not something to put behind a URL that works without one. So the file is
 * fetched like any other call, turned into a blob and handed to a synthetic
 * link — which is the only way a browser offers to save bytes it already has.
 */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const response = await fetch(`${API_URL}${path}`, buildInit({}, getToken()));
  if (!response.ok) {
    throw new ApiError(`Download failed with ${response.status}`, response.status);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  // Revoked once the click has been dispatched; leaving it costs the page the
  // whole file in memory until a reload.
  URL.revokeObjectURL(url);
}
