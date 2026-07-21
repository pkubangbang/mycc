<script setup lang="ts">
/**
 * TeammateCard.vue — floating team summary card.
 *
 * A floating card positioned at the top-right of the chat area. Shows one
 * row per active teammate, format `@name(count): currentTool`:
 *   - `count`        — number of messages for that teammate
 *   - `currentTool`  — tool tag from the most recent message's @name/tool
 *                      label (or `—` if no tool tag)
 *
 * Clicking a row emits `open-teammate(name)` so the parent (App.vue) opens
 * the TeammateDrawer with that teammate's accordion expanded. The card is
 * hidden when the drawer is open (controlled by the parent via v-if) and
 * when there are no teammate messages.
 *
 * Grouping is a frontend computed property — no backend per-teammate state.
 * See the "@-prefix teammate label convention" section in MYCC.md.
 */
import { computed } from 'vue';
import type { ChatMessage } from '../types';

const props = defineProps<{ teammateMessages: ChatMessage[] }>();
const emit = defineEmits<{ (e: 'open-teammate', name: string): void }>();

interface TeammateSummary {
  name: string;
  count: number;
  currentTool: string;
}

/**
 * Parse the teammate name out of a `@name/tool` (or `@name`) label.
 * Returns null when the label doesn't start with `@`.
 */
function teammateName(label: string | undefined): string | null {
  if (!label || !label.startsWith('@')) return null;
  const rest = label.slice(1);
  const slashIdx = rest.indexOf('/');
  return slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
}

/**
 * Parse the tool tag out of a `@name/tool` label. Returns null when there
 * is no `/` (label was `@name` only).
 */
function toolTag(label: string | undefined): string | null {
  if (!label || !label.startsWith('@')) return null;
  const rest = label.slice(1);
  const slashIdx = rest.indexOf('/');
  return slashIdx >= 0 ? rest.slice(slashIdx + 1) : null;
}

/** Group teammate messages by teammate name, preserving first-seen order. */
const teammates = computed<TeammateSummary[]>(() => {
  const order: string[] = [];
  const counts = new Map<string, number>();
  const lastTool = new Map<string, string>();
  for (const m of props.teammateMessages) {
    const name = teammateName(m.label);
    if (!name) continue;
    if (!counts.has(name)) {
      order.push(name);
      counts.set(name, 0);
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
    // The most recent message (array order is chronological) wins.
    const tool = toolTag(m.label);
    lastTool.set(name, tool ?? '—');
  }
  return order.map(name => ({
    name,
    count: counts.get(name) ?? 0,
    currentTool: lastTool.get(name) ?? '—',
  }));
});

function onClick(name: string): void {
  emit('open-teammate', name);
}
</script>

<template>
  <div class="teammate-card" v-if="teammates.length > 0">
    <div class="card-title">Team</div>
    <button
      v-for="t in teammates"
      :key="t.name"
      class="teammate-row"
      type="button"
      :title="`Open ${t.name}'s message timeline`"
      @click="onClick(t.name)"
    >
      <span class="row-name">@{{ t.name }}</span>
      <span class="row-count">({{ t.count }})</span>
      <span class="row-sep">:</span>
      <span class="row-tool">{{ t.currentTool }}</span>
    </button>
  </div>
</template>

<style scoped>
.teammate-card {
  /* right offset clears the ChatLog's scrollbar (~16px gutter) so the card
     doesn't overlap it. top inset matches. */
  position: absolute;
  top: 8px;
  right: 16px;
  z-index: 10;
  background: var(--bg-status);
  color: var(--text-status);
  border-radius: 8px;
  padding: 6px 8px;
  /* Fixed outer width — the card does not grow/shrink with content. Long
     teammate names or tool tags truncate (ellipsis) inside their row so the
     card stays a stable anchor at the top-right corner. */
  width: 200px;
  box-shadow: var(--scroll-shadow);
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.card-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-status-btn);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 0 4px 4px;
  border-bottom: 1px solid var(--border-color);
}
.teammate-row {
  display: flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  color: var(--text-status);
  border: none;
  border-radius: 5px;
  padding: 5px 8px;
  cursor: pointer;
  font-size: 13px;
  text-align: left;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  transition: background 0.12s;
}
.teammate-row:hover {
  background: var(--bg-status-btn-hover);
}
.row-name {
  font-weight: 600;
  color: #5cdbd3;
}
.row-count {
  color: var(--text-status-btn);
}
.row-sep {
  color: var(--text-status-btn);
}
.row-tool {
  color: #ffd666;
  margin-left: 2px;
}
</style>