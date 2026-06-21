import { defineStore } from 'pinia';
import { api } from '../api';

export const useAppStore = defineStore('app', {
  state: () => ({
    ready: false, // initial /status fetched
    setupComplete: false,
    authenticated: false,
    username: null,
    twoFactor: false,
    accounts: [],
  }),
  actions: {
    async fetchStatus() {
      const s = await api.get('api/auth/status');
      this.setupComplete = s.setupComplete;
      this.authenticated = s.authenticated;
      this.username = s.username;
      this.twoFactor = !!s.twoFactor;
      this.ready = true;
      return s;
    },
    async setup(username, password) {
      const r = await api.post('api/auth/setup', { username, password });
      this.setupComplete = true;
      this.authenticated = true;
      this.username = r.username;
    },
    async login(username, password, code) {
      const r = await api.post('api/auth/login', { username, password, code });
      this.authenticated = true;
      this.username = r.username;
    },
    async logout() {
      await api.post('api/auth/logout');
      this.authenticated = false;
      this.username = null;
      this.accounts = [];
    },
    async loadAccounts() {
      const r = await api.get('api/accounts');
      this.accounts = r.accounts;
      return r.accounts;
    },
  },
});
