import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { Plus, ArrowDown, User } from '@element-plus/icons-vue';

import App from './App.vue';
import router from './router';
import './styles.css';

const app = createApp(App);
app.use(createPinia());
app.use(router);

// Element Plus components + styles are auto-imported on demand (see vite.config.js).
// Only the icons actually used are registered here.
app.component('Plus', Plus);
app.component('ArrowDown', ArrowDown);
app.component('User', User);

app.mount('#app');
