'use client';

import {
  type AnalyticsEventInput,
  ANALYTICS_BATCH_MAX,
  AnalyticsEventType,
  REFERRAL_QUERY_PARAM,
  SESSION_IDLE_MS,
} from '@caseforge/shared';
import { getToken } from './api';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

const ANON_KEY = 'analytics_anon';
const SESSION_KEY = 'analytics_session';
const SESSION_SEEN_KEY = 'analytics_session_seen';
const CAMPAIGN_KEY = 'analytics_campaign';

/**
 * How long events wait before they are sent.
 *
 * A page view fires on navigation and a click fires right after it; batching
 * them turns a burst of requests into one. Short enough that a visitor who
 * leaves immediately is still counted — and the flush on `pagehide` catches
 * the rest.
 */
const FLUSH_DELAY_MS = 1_500;

let queue: AnalyticsEventInput[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let listenersAttached = false;

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Private browsing. Analytics is the one thing that must never be the
    // reason a page fails, so every storage access here is best-effort.
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Nothing to do: the visitor is simply counted as new next time.
  }
}

function randomId(): string {
  // crypto.randomUUID is not available on http:// origins in every browser,
  // and this identifier has no security role — it only has to be unlikely to
  // collide.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Stable per browser. Not an identity — it is what makes visitors countable. */
function anonId(): string {
  const existing = readStored(ANON_KEY);
  if (existing) return existing;
  const fresh = randomId();
  writeStored(ANON_KEY, fresh);
  return fresh;
}

/** Restarts after a gap, which is what makes a session a session. */
function sessionId(): string {
  const now = Date.now();
  const lastSeen = Number(readStored(SESSION_SEEN_KEY) ?? 0);
  let id = readStored(SESSION_KEY);

  if (!id || !Number.isFinite(lastSeen) || now - lastSeen > SESSION_IDLE_MS) {
    id = randomId();
    writeStored(SESSION_KEY, id);
  }
  writeStored(SESSION_SEEN_KEY, String(now));
  return id;
}

/**
 * The campaign this visitor arrived on, remembered for the session.
 *
 * Captured once, from the first URL that carried it: the parameters are gone
 * from every later navigation, and a report that only attributed the landing
 * page would credit the campaign with nothing a visitor went on to do.
 */
function campaign(): Pick<AnalyticsEventInput, 'utmSource' | 'utmMedium' | 'utmCampaign'> {
  try {
    const params = new URLSearchParams(window.location.search);
    const source = params.get('utm_source');
    if (source) {
      const captured = {
        utmSource: source.slice(0, 120),
        utmMedium: params.get('utm_medium')?.slice(0, 120) ?? undefined,
        utmCampaign: params.get('utm_campaign')?.slice(0, 120) ?? undefined,
      };
      writeStored(CAMPAIGN_KEY, JSON.stringify(captured));
      return captured;
    }
    // An invite link is a campaign of its own, and the one this site can act on.
    if (params.get(REFERRAL_QUERY_PARAM)) {
      const captured = { utmSource: 'referral', utmMedium: 'invite', utmCampaign: undefined };
      writeStored(CAMPAIGN_KEY, JSON.stringify(captured));
      return captured;
    }

    const stored = readStored(CAMPAIGN_KEY);
    return stored ? (JSON.parse(stored) as ReturnType<typeof campaign>) : {};
  } catch {
    return {};
  }
}

async function flush(): Promise<void> {
  if (queue.length === 0) return;
  const events = queue.slice(0, ANALYTICS_BATCH_MAX);
  queue = queue.slice(events.length);

  const body = JSON.stringify({ anonId: anonId(), sessionId: sessionId(), events });
  const token = getToken();

  try {
    await fetch(`${API_URL}/api/analytics/collect`, {
      method: 'POST',
      // keepalive lets the request outlive the page it was sent from, which is
      // exactly the case that matters: the last event before somebody leaves.
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body,
    });
  } catch {
    // Dropped rather than retried. A retry queue for traffic statistics is a
    // memory leak with a progress bar, and one lost page view changes nothing.
  }
}

function scheduleFlush(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    void flush();
  }, FLUSH_DELAY_MS);
}

function attachListeners(): void {
  if (listenersAttached || typeof document === 'undefined') return;
  listenersAttached = true;
  // pagehide rather than unload: it is the one that fires on mobile Safari and
  // when a tab is frozen, which is where most of the lost events come from.
  document.addEventListener('pagehide', () => void flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush();
  });
}

/**
 * Reports something the browser did.
 *
 * Fire and forget by design: nothing on the page waits for it, and nothing on
 * the page breaks when it fails.
 */
export function track(
  type: AnalyticsEventType,
  meta?: AnalyticsEventInput['meta'],
  path?: string,
): void {
  if (typeof window === 'undefined') return;
  attachListeners();

  queue.push({
    type,
    path: path ?? window.location.pathname,
    referrer: document.referrer ? document.referrer.slice(0, 512) : undefined,
    ...campaign(),
    meta,
  });

  // A queue that grows without being sent is a leak; past the batch size the
  // oldest events go, because the newest are the ones still being looked at.
  if (queue.length > ANALYTICS_BATCH_MAX * 2) queue = queue.slice(-ANALYTICS_BATCH_MAX);
  scheduleFlush();
}

export function trackPageView(path: string): void {
  track(AnalyticsEventType.PAGE_VIEW, undefined, path);
}

export { AnalyticsEventType };
