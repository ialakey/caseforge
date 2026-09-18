'use client';

import { useEffect, useRef } from 'react';
import { REFERRAL_QUERY_PARAM, normaliseReferralCode } from '@caseforge/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/store';

const STORAGE_KEY = 'referral_code';

/**
 * Picks an invite up and applies it once there is somebody to apply it to.
 *
 * An invite arrives as `?ref=CODE` on any page, and the person following it is
 * not signed in yet — they are about to be sent to Steam and back, which
 * discards everything the page was holding. So the code is parked in storage
 * and only redeemed once a session exists. The server decides whether it may
 * still be applied; this component just carries it across the round trip.
 *
 * It renders nothing and is mounted once, in the layout, because the link may
 * point at any page on the site.
 */
export function ReferralCapture() {
  const user = useAuth((state) => state.user);
  const attempted = useRef(false);

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const code = params.get(REFERRAL_QUERY_PARAM);
      if (!code) return;

      window.localStorage.setItem(STORAGE_KEY, normaliseReferralCode(code));

      // Take the parameter back out of the address bar: the visitor is about
      // to share or bookmark whatever is in it, and an invite that travels on
      // in somebody else's link is not what either of them meant.
      params.delete(REFERRAL_QUERY_PARAM);
      const query = params.toString();
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`,
      );
    } catch {
      // Private browsing, or a URL the parser will not take. An invite that
      // cannot be remembered is not a reason to break the page.
    }
  }, []);

  useEffect(() => {
    if (!user || attempted.current) return;

    let code: string | null = null;
    try {
      code = window.localStorage.getItem(STORAGE_KEY);
    } catch {
      return;
    }
    if (!code) return;

    attempted.current = true;
    void api('/api/referral/bind', { method: 'POST', body: JSON.stringify({ code }) })
      .catch(() => undefined)
      .finally(() => {
        // Cleared either way. A refusal is final — the account is already
        // bound, or already has history — and retrying it on every page load
        // would be a request that can never succeed.
        try {
          window.localStorage.removeItem(STORAGE_KEY);
        } catch {
          // Nothing to do; the next attempt is harmless.
        }
      });
  }, [user]);

  return null;
}
