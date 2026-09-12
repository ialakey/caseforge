'use client';

import { create } from 'zustand';
import type { PublicUser } from '@caseforge/shared';
import { api, setToken } from './api';

interface AuthState {
  user: PublicUser | null;
  loading: boolean;
  loadUser: () => Promise<void>;
  setBalance: (balance: number) => void;
  logout: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  loading: true,

  async loadUser() {
    try {
      const user = await api<PublicUser>('/api/me');
      set({ user, loading: false });
    } catch {
      // A 401 here is normal: the page was opened anonymously.
      set({ user: null, loading: false });
    }
  },

  setBalance(balance) {
    set((state) => (state.user ? { user: { ...state.user, balance } } : state));
  },

  logout() {
    setToken(null);
    set({ user: null });
    void api('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
  },
}));
