<script setup>
defineProps({ size: { type: [Number, String], default: 22 } });
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 48 48"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
  >
    <path
      d="M13.5 35.5h21.2a8.6 8.6 0 0 0 1.4-17.1 11.6 11.6 0 0 0-22.4 1.5A8.1 8.1 0 0 0 13.5 35.5Z"
      fill="currentColor"
    />
    <path
      d="M20 27.5h11M20 31h7"
      stroke="#fff"
      stroke-width="1.6"
      stroke-linecap="round"
      opacity="0.85"
    />
  </svg>
</template>
