'use client';

import type { ApiErrorBody } from '@caseforge/shared';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const TOKEN_KEY = 'access_token';

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

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

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
