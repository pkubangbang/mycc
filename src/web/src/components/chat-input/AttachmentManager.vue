<script setup lang="ts">
/**
 * AttachmentManager.vue — the popup that manages the pending upload queue.
 *
 * Opened from the `+N 个附件` pill in AttachmentBar.vue. Lists every pending
 * file with its decoded byte size and lets the user remove one or clear all.
 *
 * Built on ModalShell (our own modal, not <dialog>) so background scroll,
 * focus containment and focus restore behave the same on every engine.
 *
 * Capability props only — never `ChatState`.
 */
import { computed } from 'vue';
import type { FileInfo } from '../../types';
import { formatBytes } from '../../format-bytes';
import ModalShell from '../common/ModalShell.vue';

const props = defineProps<{
  open: boolean;
  files: FileInfo[];
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'remove', index: number): void;
  (e: 'remove-all'): void;
}>();

/**
 * Byte size of a queued file. The queue stores base64 WITHOUT the data-URL
 * prefix, so the decoded length is `floor(chars * 3 / 4)` minus padding.
 * Display-only estimate — the authoritative size guard ran at enqueue time.
 */
const entries = computed(() =>
  props.files.map((f, index) => {
    const chars = f.data.length;
    const padding = f.data.endsWith('==') ? 2 : f.data.endsWith('=') ? 1 : 0;
    const bytes = Math.max(0, Math.floor((chars * 3) / 4) - padding);
    return { ...f, index, size: formatBytes(bytes) };
  }),
);
</script>

<template>
  <ModalShell :open="props.open" title="管理附件" :max-width="560" @close="emit('close')">
    <ul v-if="entries.length > 0" class="att-list">
      <li v-for="e in entries" :key="e.filename + e.index" class="att-row">
        <span class="att-name" :title="e.filename">{{ e.filename }}</span>
        <span class="att-meta">{{ e.mimeType }} · {{ e.size }}</span>
        <button
          class="att-remove"
          :aria-label="`移除 ${e.filename}`"
          @click="emit('remove', e.index)"
        >&times;</button>
      </li>
    </ul>
    <p v-else class="att-empty">没有待上传的附件</p>
    <template #footer>
      <button
        class="att-clear"
        :disabled="entries.length === 0"
        @click="emit('remove-all')"
      >全部移除</button>
      <button class="att-done" @click="emit('close')">完成</button>
    </template>
  </ModalShell>
</template>

<style scoped>
.att-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.att-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-input-field);
  font-size: 13px;
}
.att-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.att-meta {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
.att-remove {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 18px;
  line-height: 1;
  padding: 0 4px;
  cursor: pointer;
}
.att-remove:hover {
  color: #ef4444;
}
.att-empty {
  margin: 0;
  padding: 12px 0;
  text-align: center;
  font-size: 13px;
  color: var(--text-muted);
}
.att-clear {
  background: none;
  border: 1px solid color-mix(in srgb, #ef4444 40%, transparent);
  color: #ef4444;
  border-radius: 6px;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
}
.att-clear:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.att-clear:not(:disabled):hover {
  background: color-mix(in srgb, #ef4444 10%, transparent);
}
.att-done {
  background: var(--accent);
  color: var(--accent-text);
  border: none;
  border-radius: 6px;
  padding: 6px 16px;
  font-size: 13px;
  cursor: pointer;
}
.att-done:hover {
  opacity: 0.85;
}
</style>
