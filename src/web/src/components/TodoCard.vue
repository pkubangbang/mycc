<script setup lang="ts">
/**
 * TodoCard.vue — floating, collapsible todo activity summary card.
 *
 * The card is a compact VIEW over the `todo_create` / `todo_update` /
 * `todo_pinning` briefs that already flow to the chat log. It floats at the
 * top-left of the chat area (top-right is reserved for TeammateCard, so the
 * two never collide) and:
 *   - tracks the todo-labelled messages of the CURRENT turn (the turn the last
 *     todo event belongs to) — the per-turn projection of the todo state,
 *   - is COLLAPSED by default — the header shows the latest event
 *     (e.g. "completed #2: add tests"),
 *   - expands downward on click to reveal this turn's todo events, newest
 *     first, while staying floating (position:absolute, never reflows chat),
 *   - hides entirely while the turn has no todo events.
 *
 * ## Why the brief's message, not a snapshot
 *
 * The todo tools no longer echo `printTodoList()` into the brief (commit
 * 3b6c8bf moved the open list onto the project-context populator). Each brief
 * carries exactly one line — `brief('info', 'todo_<op>', 'Created #1: <name>')`
 * — and that line IS the event:
 *
 *   [HH:MM:SS] [todo_create]              ← header, built frontend-side
 *   Created #1: backfill authorId         ← the todo event (brief content)
 *
 * The old implementation parsed `content` as a printTodoList() snapshot and
 * rendered nothing once the tools stopped echoing it — every todo brief became
 * an empty pill on screen. Both consumers now share `describeTodoEvent`.
 *
 * ## What the card does NOT know
 *
 * The backend sends no structured todo list to the WebUI — there is no
 * "list current todos" channel (the full list only reaches the LLM through the
 * populator, and the user through the terminal `/todos` slash command). The
 * card therefore shows the turn's todo ACTIVITY — which is what the chat log
 * is about — rather than a synthesised, potentially stale checklist. The card
 * auto-collapses when the agent starts a new turn with todo events.
 */
import { computed, ref, watch } from 'vue';
import type { ChatMessage } from '../types';
import { describeTodoEvent } from './todo-activity';
import type { TodoEvent } from './todo-activity';

const props = defineProps<{ messages: ChatMessage[] }>();

/** The latest todo-labelled message — the authoritative current state. */
const latestTodoMsg = computed(() => {
  for (let i = props.messages.length - 1; i >= 0; i--) {
    const m = props.messages[i];
    if (describeTodoEvent(m) !== null) return m;
  }
  return null;
});

/**
 * Messages of the CURRENT turn carrying a todo event, NEWEST first, capped at
 * MAX_EVENTS. A "turn" starts at the latest user bubble at or before the
 * latest todo event (a user bubble is the only reliable turn boundary visible
 * to the frontend — an assistant 'result' can also appear mid-turn for the ESC
 * wrap-up letterbox). A turn with no user bubble (session start) keeps every
 * prior todo event.
 */
const MAX_EVENTS = 8;
const turnEvents = computed(() => {
  const latest = latestTodoMsg.value;
  if (!latest) return [];
  const latestIdx = props.messages.indexOf(latest);
  let start = 0;
  for (let i = latestIdx; i >= 0; i--) {
    if (props.messages[i].type === 'user') {
      start = i;
      break;
    }
  }
  const events: TodoEvent[] = [];
  for (let i = latestIdx; i >= start && events.length < MAX_EVENTS; i--) {
    const parsed = describeTodoEvent(props.messages[i]);
    if (parsed) events.push(parsed);
  }
  return events;
});

/** Whether there is anything to show. */
const hasEvents = computed(() => turnEvents.value.length > 0);

/** The newest event — the one shown in the collapsed header. */
const latestEvent = computed(() => turnEvents.value[0] ?? null);

/** Collapse state: collapsed (true) shows only the latest event; expanded
 *  (false) shows this turn's events. Defaults to collapsed. */
const collapsed = ref(true);

function toggle(): void {
  collapsed.value = !collapsed.value;
}

// A NEW turn's first todo event restores the default (collapsed) state, so the
// card never stays expanded from the previous turn. Keyed on the session-wide
// event count, not the turn-window length, so the shrink-then-grow of a
// windowed turn cannot re-collapse it.
const totalTodoEvents = computed(
  () => props.messages.filter((m) => describeTodoEvent(m) !== null).length,
);
watch(totalTodoEvents, (next, prev) => {
  if (next <= prev || !latestEvent.value) return;
  const events = turnEvents.value;
  // The window starts with a single fresh event → a new turn began.
  if (events.length === 1) collapsed.value = true;
});
</script>

<template>
  <div v-if="hasEvents" class="todo-card" :class="{ collapsed }">
    <button class="todo-card-header" type="button" @click="toggle" :title="collapsed ? '点击展开本轮 todo 记录' : '点击折叠'">
      <span class="todo-icon" :class="{ done: latestEvent?.done }">{{ latestEvent?.icon }}</span>
      <span class="todo-summary">{{ latestEvent?.text ?? 'Todo' }}</span>
      <span v-if="turnEvents.length > 1" class="todo-count">×{{ turnEvents.length }}</span>
      <span class="todo-chevron" :class="{ open: !collapsed }" aria-hidden="true">▾</span>
    </button>
    <div v-if="!collapsed" class="todo-card-body">
      <div v-for="t in turnEvents" :key="t.id" class="todo-line" :class="{ done: t.done }">
        <span class="todo-icon" :class="{ done: t.done }">{{ t.icon }}</span>
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
.todo-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.todo-count {
  flex-shrink: 0;
  opacity: 0.7;
  font-size: 12px;
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
