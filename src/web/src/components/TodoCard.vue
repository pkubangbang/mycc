<script setup lang="ts">
/**
 * TodoCard.vue — floating, collapsible todo summary card.
 *
 * Replaces the inline `todo_create` / `todo_update` / `todo_pinning` log
 * bubbles in the chat stream. Instead of dumping the full `printTodoList()`
 * output every time a todo changes, this card:
 *   - tracks the LATEST todo-labeled message (the most recent state),
 *   - floats at the top-left of the chat area (top-right is reserved for
 *     TeammateCard, so the two never collide),
 *   - is COLLAPSED by default — showing only the last todo line,
 *   - expands downward on click to reveal the full list, while staying
 *     floating (position:absolute, never reflows the chat log),
 *   - hides entirely when there are no todos ("No todos." or no todo msg).
 *
 * The card is purely a frontend view over existing ChatMessages — no
 * backend state. See the "todo management" / brief() label convention in
 * MYCC.md: brief('info', 'todo_create'|'todo_update'|'todo_pinning', ...)
 * emits a labeled `log` message whose `content` is the printTodoList()
 * string.
 */
import { computed, ref } from 'vue';
import type { ChatMessage } from '../types';

const props = defineProps<{ messages: ChatMessage[] }>();

/** Labels that carry a todo-list snapshot in their `content`. */
const TODO_LABELS = new Set(['todo_create', 'todo_update', 'todo_pinning']);

/** The most recent todo-labeled message — the authoritative current state. */
const latestTodoMsg = computed(() => {
  for (let i = props.messages.length - 1; i >= 0; i--) {
    const m = props.messages[i];
    if (m.label && TODO_LABELS.has(m.label)) return m;
  }
  return null;
});

/** Raw printTodoList() content of the latest todo message. */
const rawContent = computed(() => latestTodoMsg.value?.content ?? '');

interface ParsedTodo {
  /** Original line (with leading whitespace trimmed). */
  raw: string;
  done: boolean;
  pinned: boolean;
  /** The "N. Name" body, stripped of markers/tags/hash. */
  text: string;
}

/**
 * Parse a printTodoList() string into individual todo lines.
 * Format:
 *   Todo list:
 *     [x] 📌 1. Name (note) [reactivate: cond] [hash: xxx]
 *     [ ] 2. Other [hash: yyy]
 * The first non-empty line is the "Todo list:" header — skipped.
 * Each subsequent non-empty line is one todo item.
 */
function parseTodos(content: string): ParsedTodo[] {
  const lines = content.split('\n');
  const items: ParsedTodo[] = [];
  let sawHeader = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!sawHeader) {
      // First non-empty line is the "Todo list:" header.
      sawHeader = true;
      continue;
    }
    // Marker: [x] or [ ]
    const done = /^\[x\]/i.test(trimmed);
    const pinned = trimmed.includes('📌');
    // Strip "[x]"/"[ ]", the 📌 pin tag, and the trailing [hash: ...] so the
    // summary reads cleanly. Keep the "N. Name (note) [reactivate: ...]" body.
    const text = trimmed
      .replace(/^\[[ xX]\]\s*/, '')
      .replace(/📌\s*/, '')
      .replace(/\s*\[hash:\s*[0-9a-f]+\]\s*$/i, '');
    items.push({ raw: trimmed, done, pinned, text });
  }
  return items;
}

const todos = computed<ParsedTodo[]>(() => parseTodos(rawContent.value));

/** The last todo line — the one shown in the collapsed chip. */
const lastTodo = computed(() => {
  const list = todos.value;
  return list.length > 0 ? list[list.length - 1] : null;
});

/** Whether there is anything to show (a real todo list, not "No todos."). */
const hasTodos = computed(
  () => latestTodoMsg.value !== null && todos.value.length > 0,
);

/** Collapse state: collapsed (true) shows only the last item; expanded
 *  (false) shows the full list. Defaults to collapsed. */
const collapsed = ref(true);

function toggle(): void {
  collapsed.value = !collapsed.value;
}
</script>

<template>
  <div v-if="hasTodos" class="todo-card" :class="{ collapsed }">
    <button class="todo-card-header" type="button" @click="toggle" :title="collapsed ? '点击展开全部 todo' : '点击折叠'">
      <span class="todo-icon" :class="{ done: lastTodo?.done }">{{ lastTodo?.done ? '☑' : '☐' }}</span>
      <span v-if="lastTodo?.pinned" class="todo-pin" aria-hidden="true">📌</span>
      <span class="todo-summary">{{ lastTodo?.text ?? 'Todo' }}</span>
      <span class="todo-chevron" :class="{ open: !collapsed }" aria-hidden="true">▾</span>
    </button>
    <div v-if="!collapsed" class="todo-card-body">
      <div v-for="(t, idx) in todos" :key="idx" class="todo-line" :class="{ done: t.done }">
        <span class="todo-icon" :class="{ done: t.done }">{{ t.done ? '☑' : '☐' }}</span>
        <span v-if="t.pinned" class="todo-pin" aria-hidden="true">📌</span>
        <span class="todo-text">{{ t.text }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.todo-card {
  /* Top-left of the chat area; top-right is occupied by TeammateCard so the
     two never overlap. position:absolute keeps the card floating over the
     chat log without reflowing it. */
  position: absolute;
  top: 8px;
  left: 16px;
  z-index: 10;
  /* Span the left half of the chat area. min-width guarantees room for at
     least ~20 monospace characters of todo text even on narrow viewports;
     width:50% grows it with the chat area on wider windows. A max-width
     caps it on very wide screens so it doesn't sprawl. */
  width: 50%;
  min-width: 240px;
  max-width: 560px;
  /* Theme-tinted panel: light yellow in light mode, deep green in dark
     mode — distinct from the near-white / near-black chat background. */
  background: var(--todo-card-bg);
  color: var(--todo-card-text);
  border: 1px solid var(--todo-card-border);
  border-radius: 8px;
  /* Stronger shadow than the default --scroll-shadow so the floating card
     lifts visibly off the chat log, especially in dark mode. */
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
  font-size: 13px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.todo-card-header {
  display: flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  color: var(--todo-card-text);
  border: none;
  padding: 6px 10px;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  transition: background 0.12s;
}
.todo-card-header:hover {
  /* --md-code-bg is a translucent overlay that works on both themes without
     overriding the card's own background. */
  background: var(--md-code-bg);
}
.todo-icon {
  color: var(--todo-card-text);
  flex-shrink: 0;
  opacity: 0.85;
}
.todo-icon.done {
  color: var(--accent);
  opacity: 1;
}
.todo-pin {
  flex-shrink: 0;
}
.todo-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.todo-chevron {
  flex-shrink: 0;
  color: var(--todo-card-text);
  opacity: 0.85;
  transition: transform 0.15s;
}
.todo-chevron.open {
  transform: rotate(180deg);
}
.todo-card-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px 6px 6px;
  /* Visible divider between the always-on header and the expanded list. */
  border-top: 1px solid var(--todo-card-border);
  max-height: 240px;
  overflow-y: auto;
}
.todo-line {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  padding: 4px 6px;
  border-radius: 5px;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  line-height: 1.4;
  color: var(--todo-card-text);
}
.todo-line:hover {
  background: var(--md-code-bg);
}
.todo-line.done {
  opacity: 0.6;
}
.todo-line .todo-text {
  min-width: 0;
  word-break: break-word;
}
</style>