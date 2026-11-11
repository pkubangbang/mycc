<script setup lang="ts">
/**
 * MagicQueryDialog.vue — the popup behind the magic-wand button (魔法查询).
 *
 * The wand replaces the old one-click 压缩上下文 icon: instead of firing a
 * compaction immediately, it opens a LIST of magic queries. The first (and, for
 * now, only) entry is `/compact` — the same slash command the old button sent —
 * with a one-line description of what it does to the conversation.
 *
 * Selecting a row emits `run` with the slash text; the shell owns the actual
 * submission (`chatApi.sendInput(...)`) and closes the dialog, so this
 * component stays a pure capability-props view: no ChatState, no backend calls.
 *
 * Built on ModalShell (our own modal, not <dialog>) so background scroll,
 * focus containment and focus restore behave the same on every engine.
 */
import ModalShell from '../common/ModalShell.vue';

/** One row in the magic-query dialog. */
export interface MagicQuery {
  /** The slash command text sent through the normal input path. */
  query: string;
  /** One-line human explanation shown next to the query. */
  description: string;
}

const props = defineProps<{
  open: boolean;
  /** Queries to list, in display order (the first is the primary one). */
  queries: MagicQuery[];
  /** Whether a row may be executed right now. The wand button is disabled
   *  under the same condition, but the dialog can outlive a state change
   *  (e.g. auto mode engages while it is open), so the gate is repeated here. */
  runnable: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'run', query: string): void;
}>();

function run(query: string): void {
  if (!props.runnable) return;
  emit('run', query);
}
</script>

<template>
  <ModalShell :open="props.open" title="魔法查询" :max-width="520" @close="emit('close')">
    <ul class="mq-list">
      <li v-for="q in props.queries" :key="q.query">
        <button class="mq-row" :disabled="!props.runnable" @click="run(q.query)">
          <span class="mq-query">{{ q.query }}</span>
          <span class="mq-desc">{{ q.description }}</span>
        </button>
      </li>
    </ul>
    <template #footer>
      <button class="mq-cancel" @click="emit('close')">取消</button>
    </template>
  </ModalShell>
</template>

<style scoped>
.mq-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mq-row {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 8px 10px;
  text-align: left;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-input-field);
  color: var(--text-primary);
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.mq-row:not(:disabled):hover {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, var(--bg-input-field));
}
.mq-row:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.mq-query {
  font-size: 13px;
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  color: var(--accent);
}
.mq-desc {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted);
}
.mq-cancel {
  background: none;
  border: 1px solid var(--border-color);
  color: var(--text-muted);
  border-radius: 6px;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
}
.mq-cancel:hover {
  color: var(--text-primary);
}
</style>
