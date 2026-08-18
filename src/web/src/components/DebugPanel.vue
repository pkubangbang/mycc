<script setup lang="ts">
/**
 * DebugPanel.vue - flag-gated debug panel for reproducible tests
 *
 * Renders ONLY when `state.debugMode` is true (which can only be turned on via
 * `window.__myccDebug.enable()` in the browser console or an agent-browser
 * `eval`). The panel is NOT a persistent toggle and appears only in DEV (the
 * seam is not even registered in production). It offers the same injection
 * primitives as the window seam, surfaced as buttons for manual verification.
 */
import { computed } from 'vue';
import type { ChatState } from '../types';

const props = defineProps<{ state: ChatState }>();

function injectSteeringSequence(): void {
  const seam = window.__myccDebug;
  if (!seam) return;
  void seam.injectSequence([
    { type: 'steer-echo', content: 'note A', steerId: 9001 },
    { type: 'steer-echo', content: 'note B', steerId: 9002 },
    { type: 'prompt', content: '' },
  ]);
}

function snapshotToConsole(): void {
  const seam = window.__myccDebug;
  if (!seam) return;
  // eslint-disable-next-line no-console
  console.log('__myccDebug.snapshot():', JSON.stringify(seam.snapshot(), null, 2));
}

function resetState(): void {
  window.__myccDebug?.reset();
}

const reviewCount = computed(() => props.state.pendingSteeringReview.length);
</script>

<template>
  <div class="debug-panel" data-testid="debug-panel">
    <span class="db-label">🧪 调试</span>
    <button class="db-btn" @click="injectSteeringSequence">注入转向序列</button>
    <button class="db-btn" @click="snapshotToConsole">快照到控制台</button>
    <button class="db-btn" @click="resetState">重置</button>
    <span class="db-meta">review={{ reviewCount }}</span>
  </div>
</template>

<style scoped>
.debug-panel {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 16px;
  background: color-mix(in srgb, #3b82f6 12%, var(--bg-steering, #111827));
  border-bottom: 1px solid color-mix(in srgb, #3b82f6 30%, transparent);
  flex-shrink: 0;
  font-size: 12px;
}
.db-label {
  color: #93c5fd;
  font-weight: 600;
  white-space: nowrap;
}
.db-btn {
  background: color-mix(in srgb, #3b82f6 20%, transparent);
  color: #bfdbfe;
  border: 1px solid color-mix(in srgb, #3b82f6 40%, transparent);
  padding: 2px 10px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
}
.db-btn:hover {
  background: color-mix(in srgb, #3b82f6 32%, transparent);
}
.db-meta {
  color: #94a3b8;
}
</style>
