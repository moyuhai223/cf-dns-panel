import { ref } from 'vue';

// Light/dark theme: first visit follows the OS preference, then the user's choice
// is remembered in localStorage. Applied via the `dark` class on <html>.
const KEY = 'cfp-theme';

function systemPrefersDark() {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : false;
}

const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
export const isDark = ref(saved ? saved === 'dark' : systemPrefersDark());

function apply() {
  document.documentElement.classList.toggle('dark', isDark.value);
}
apply();

export function toggleTheme() {
  isDark.value = !isDark.value;
  localStorage.setItem(KEY, isDark.value ? 'dark' : 'light');
  apply();
}
