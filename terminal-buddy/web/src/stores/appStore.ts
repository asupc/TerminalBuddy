import { create } from 'zustand';

interface WebAppState {
  token: string | null;
  setToken: (token: string | null) => void;
}

export const useWebAppStore = create<WebAppState>((set) => ({
  token: null,
  setToken: (token) => set({ token }),
}));
