import { createRouter, createWebHistory } from 'vue-router';
import { useAppStore } from './store/auth';

const routes = [
  { path: '/setup', name: 'setup', component: () => import('./views/Setup.vue') },
  { path: '/login', name: 'login', component: () => import('./views/Login.vue') },
  { path: '/', name: 'records', component: () => import('./views/Records.vue') },
  { path: '/accounts', name: 'accounts', component: () => import('./views/Accounts.vue') },
  { path: '/ddns', name: 'ddns', component: () => import('./views/Ddns.vue') },
  { path: '/audit', name: 'audit', component: () => import('./views/Audit.vue') },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});

router.beforeEach(async (to) => {
  const store = useAppStore();
  if (!store.ready) {
    try {
      await store.fetchStatus();
    } catch {
      /* network error -> fall through to guards below */
    }
  }

  if (!store.setupComplete) {
    return to.name === 'setup' ? true : { name: 'setup' };
  }
  if (to.name === 'setup') {
    return { name: store.authenticated ? 'records' : 'login' };
  }
  if (!store.authenticated) {
    return to.name === 'login' ? true : { name: 'login' };
  }
  if (to.name === 'login') {
    return { name: 'records' };
  }
  return true;
});

export default router;
