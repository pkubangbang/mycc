<script setup lang="ts">
/**
 * AttachmentBar.vue — the pending-attachment strip, ALWAYS one line.
 *
 * One line is a structural guarantee, not a measurement:
 *   flex-wrap: nowrap  +  a fixed height  +  overflow: hidden
 * The first two chips render inline (ellipsised, like the old chips); if
 * more are queued, a `+N 个附件` pill opens the manager. Nothing here computes
 * widths or counts of visible rows.
 *
 * Capability props only — never `ChatState`.
 */
import { computed } from 'vue';
import type { FileInfo } from '../../types';

const props = defineProps<{
  /** The full pending queue (state.pendingFiles). */
  files: FileInfo[];
}>();

const emit = defineEmits<{
  (e: 'manage'): void;
  (e: 'remove', index: number): void;
}>();

/** How many chips fit inline before the overflow pill takes over. */
const INLINE_MAX = 2;

const visible = computed(() => props.files.slice(0, INLINE_MAX));
const overflowCount = computed(() => Math.max(0, props.files.length - INLINE_MAX));

/** Human label for the pill: the count alone reads better than the filenames. */
const pillLabel = computed(() =>
  overflowCount.value > 0 ? `+${overflowCount.value} 个附件` : '',
);
</script>

<template>
  <div v-if="props.files.length > 0" class="attachment-bar">
    <span
      v-for="(f, i) in visible"
      :key="f.filename + i"
      class="file-chip"
      :title="f.filename"
    >
      <span class="file-chip-name">{{ f.filename }}</span>
      <button
        class="file-chip-remove"
        :aria-label="`移除 ${f.filename}`"
        @click="emit('remove', i)"
      >&times;</button>
    </span>
    <!-- Overflow pill: a single button that always opens the manager, so the
         user has one place to see and prune the whole queue. -->
    <button
      class="attachment-pill"
      :title="`共 ${props.files.length} 个附件，点击管理`"
      @click="emit('manage')"
    >
      <template v-if="overflowCount > 0">{{ pillLabel }}</template>
      <template v-else>管理附件</template>
    </button>
  </div>
</template>

<style scoped>
.attachment-bar {
  display: flex;
  flex-wrap: nowrap;   /* ← one line, always */
  align-items: center;
  gap: 6px;
  height: 32px;        /* ← fixed: extra chips can never push the row taller */
  overflow: hidden;
  /* The bar owns its own inset (the shell has no horizontal padding), and it
     sits right under the textarea — no top gap beyond the composer row's own
     vertical padding. */
  /* No bottom margin: the shell's 5px padding-bottom is the single bottom
     inset, so the bar (or any other last child) cannot add space of its own. */
  margin: 0 var(--composer-gutter, 8px);
}
/* Capsule width follows its content: `flex: 0 0 auto` keeps the intrinsic
   width (no stretching to a fixed 200px, which is what made short names show a
   large empty run), `width: max-content` + `max-width` caps only the extreme
   case, and the name is the only item allowed to shrink (so the × never gets
   squeezed and no gap opens beside a short name). */
.file-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--accent);
  color: var(--accent-text);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  min-width: 0;
  flex: 0 0 auto;
  width: max-content;
  max-width: 160px;
}
.file-chip-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-chip-remove {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0;
  margin-left: 0;
  opacity: 0.8;
  flex: 0 0 auto;
}
.file-chip-remove:hover {
  opacity: 1;
}
.attachment-pill {
  flex: 0 0 auto;
  background: color-mix(in srgb, var(--accent) 14%, var(--bg-input));
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.attachment-pill:hover {
  background: color-mix(in srgb, var(--accent) 22%, var(--bg-input));
}
</style>
