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
  /** True when this teammate's last message is the exit notice (toolTag
   *  'exit') — i.e. it has "retired". See TeammateDrawer's `done` field. */
  done: boolean;
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
  const messagesMap = new Map<string, ChatMessage[]>();
  const lastTool = new Map<string, string>();
  for (const m of props.teammateMessages) {
    const name = teammateName(m.label);
    if (!name) continue;
    if (!messagesMap.has(name)) {
      order.push(name);
      messagesMap.set(name, []);
    }
    messagesMap.get(name)!.push(m);
    const tool = toolTag(m.label);
    lastTool.set(name, tool ?? '—');
  }
  return order.map(name => {
    const msgs = messagesMap.get(name) ?? [];
    const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    return {
      name,
      count: msgs.length,
      currentTool: lastTool.get(name) ?? '—',
      done: last !== null && toolTag(last.label) === 'exit',
    };
  });
});

/**
 * Whether every teammate has "retired" — each one's last message is the exit
 * notice. When true, the card collapses into a thin, semi-transparent trigger
 * at the top-right (just a narrow handle that still opens the drawer on
 * click). The moment any teammate re-activates (a newer non-exit message
 * arrives) or a brand-new teammate appears, `allDone` flips false and the
 * full card restores. With zero teammates, allDone is false (nothing to do).
 */
const allDone = computed(() =>
  teammates.value.length > 0 && teammates.value.every(t => t.done),
);

function onClick(name: string): void {
  emit('open-teammate', name);
}

// When collapsed (allDone), the thin trigger opens the drawer on the first
// teammate — the drawer itself shows every teammate, so the choice is just
// which accordion starts expanded.
function onCollapsedClick(): void {
  const first = teammates.value[0]?.name;
  if (first) emit('open-teammate', first);
}
</script>

<template>
  <!-- Collapsed: every teammate has retired. Render only a thin, dimmed
       trigger at the top-right edge — a narrow pill that still opens the
       drawer on click. Restores the full card the moment any teammate
       re-activates or a new one appears (allDone flips false). -->
  <button
    v-if="allDone"
    class="teammate-card collapsed"
    type="button"
    title="所有 teammate 已完成 — 点击展开"
    @click="onCollapsedClick"
  >
    <span class="collapsed-label">Team · 已完成</span>
  </button>
  <!-- Full card: at least one teammate is NOT retired. -->
  <div class="teammate-card" v-else-if="teammates.length > 0">
    <div class="card-title">Team</div>
    <button
      v-for="t in teammates"
      :key="t.name"
      class="teammate-row"
      :class="{ retired: t.done }"
      type="button"
      :title="t.done ? `${t.name} 已完成 — Open ${t.name}'s message timeline` : `Open ${t.name}'s message timeline`"
      @click="onClick(t.name)"
    >
      <span class="row-name">@{{ t.name }}</span>
      <span class="row-count">({{ t.count }})</span>
      <span class="row-sep">:</span>
      <span class="row-tool">{{ t.currentTool }}</span>
      <span v-if="t.done" class="row-done">✓</span>
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
/* Per-row retired marker: a small check after a teammate whose last message
   is the exit notice. Subtle so the row still reads as a clickable summary. */
.row-done {
  margin-left: auto;
  color: #5cdbd3;
  font-weight: 700;
}
.teammate-row.retired {
  opacity: 0.6;
}
/* Collapsed card: every teammate has retired. The card becomes a thin,
   semi-transparent pill hugging the top-right edge — just enough of a
   trigger to reopen the drawer. It stays clickable (button element) and
   restores to the full card once a teammate re-activates or a new one
   appears (allDone flips false). */
.teammate-card.collapsed {
  width: auto;
  padding: 4px 10px;
  opacity: 0.45;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 11px;
  border: none;
  cursor: pointer;
  transition: opacity 0.18s;
}
.teammate-card.collapsed:hover {
  opacity: 0.8;
}
.collapsed-label {
  color: var(--text-status-btn);
  white-space: nowrap;
}
</style>