<script setup lang="ts">
/**
 * InputNoticeBar.vue — the two transient/standing notices below the composer.
 *
 *   • warning — the textarea stays enabled but the typed text will NOT be
 *               submitted (pending ask() card / steering-review card /
 *               disconnection). Amber.
 *   • error   — an upload rejection (size cap / folder dropped). Red.
 *
 * Both are pre-rendered strings supplied by the shell, so this component is
 * purely presentational and never sees `ChatState`.
 */
defineProps<{
  /** Amber warning text, or null when there is nothing to warn about. */
  warning: string | null;
  /** Red upload-error text, or null. */
  error: string | null;
}>();
</script>

<template>
  <div v-if="warning" class="input-warning">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
    <span>{{ warning }}</span>
  </div>
  <div v-if="error" class="upload-error">{{ error }}</div>
</template>

<style scoped>
/* Amber accent signals a warning (distinct from the accent-blue info tone). */
.input-warning {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px var(--composer-gutter, 8px) 0;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  background: color-mix(in srgb, #f59e0b 12%, var(--bg-input));
  color: #b45309;
  border: 1px solid color-mix(in srgb, #f59e0b 30%, transparent);
}
.upload-error {
  margin: 8px var(--composer-gutter, 8px) 0;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  background: color-mix(in srgb, #ef4444 12%, var(--bg-input));
  color: #ef4444;
  border: 1px solid color-mix(in srgb, #ef4444 30%, transparent);
}
</style>
