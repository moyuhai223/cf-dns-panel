<script setup>
// Branded two-pane shell for the login / setup screens. The form goes in the slot.
</script>

<template>
  <div class="auth-shell">
    <div class="auth-card2">
      <aside class="auth-brand">
        <svg class="cloud" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path
            d="M21 48h31a12 12 0 0 0 1.8-23.9A16.5 16.5 0 0 0 20 27.5 11 11 0 0 0 21 48Z"
            fill="currentColor"
          />
          <circle cx="27" cy="58" r="2.3" fill="currentColor" opacity="0.75" />
          <circle cx="36" cy="61" r="2.3" fill="currentColor" opacity="0.5" />
          <circle cx="45" cy="58" r="2.3" fill="currentColor" opacity="0.75" />
        </svg>
        <div class="auth-brand-title">Cloudflare DNS 面板</div>
        <div class="auth-brand-sub">
          自托管 · 多账号<br />
          解析 / 导入导出 / DDNS / 缓存 / 规则,一处管好
        </div>
      </aside>
      <main class="auth-pane">
        <slot />
      </main>
    </div>
  </div>
</template>
