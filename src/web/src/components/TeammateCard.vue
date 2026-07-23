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
  /** Last message time formatted as HH:mm:ss (en-GB, 24h), or '' when the
   *  last message carries no timestamp. */
  lastTime: string;
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

/**
 * Format a message timestamp as HH:mm:ss (en-GB, 24h). Returns '' when the
 * message carries no timestamp. Mirrors the format used by TeammateDrawer's
 * timeStr() helper so the card and drawer render times consistently.
 */
function timeStr(m: ChatMessage): string {
  return m.timestamp
    ? new Date(m.timestamp).toLocaleTimeString('en-GB', { hour12: false })
    : '';
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
      lastTime: last ? timeStr(last) : '',
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
      <span class="row-count-pill" :class="{ 'is-done': t.done }">
        <template v-if="t.done">✓ {{ t.count }}</template>
        <template v-else>{{ t.count }}</template>
      </span>
      <span class="row-tool">{{ t.done ? 'done' : t.currentTool }}</span>
      <span class="row-time" v-if="t.lastTime">{{ t.lastTime }}</span>
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
  /* Fixed outer width — the card does not grow/shrink with content. The
     four-corner row layout keeps each field on its own cell so long tool
     names truncate within their cell rather than overflowing. Narrowed
     from 200px to 180px since content now splits across two lines. */
  width: 180px;
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
  /* Four-corner layout via a 2×2 grid:
       top-left: name     | top-right: count pill
       bottom-left: tool  | bottom-right: time */
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  column-gap: 8px;
  row-gap: 2px;
  align-items: center;
  /* Fixed height so every teammate row occupies the same vertical space
     regardless of whether the time cell is present — keeps the card a
     stable anchor and avoids jitter as messages arrive. */
  height: 44px;
  box-sizing: border-box;
  background: transparent;
  color: var(--text-status);
  border: none;
  border-radius: 5px;
  padding: 4px 8px;
  cursor: pointer;
  font-size: 13px;
  text-align: left;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  transition: background 0.12s;
  overflow: hidden;
}
.teammate-row:hover {
  background: var(--bg-status-btn-hover);
}
/* Top-left: teammate name. Occupies grid cell (1,1) naturally by source order. */
.row-name {
  font-weight: 600;
  color: #5cdbd3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Top-right: message-count pill. A compact rounded badge so the count reads
   as a secondary metric rather than inline prose. Turns teal when the
   teammate has retired (prefixes the count with ✓). */
.row-count-pill {
  justify-self: end;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-status-btn);
  background: var(--bg-status-btn-hover);
  border-radius: 999px;
  padding: 0 7px;
  line-height: 1.6;
  white-space: nowrap;
}
.row-count-pill.is-done {
  color: #5cdbd3;
}
/* Bottom-left: tool tag from the most recent message. Dims to 11px as a
   sub-detail under the name line. */
.row-tool {
  color: #ffd666;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Bottom-right: last-message time (HH:mm:ss). Dims to 11px to match the
   tool line. */
.row-time {
  justify-self: end;
  color: var(--text-status-btn);
  font-size: 11px;
  white-space: nowrap;
  opacity: 0.75;
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