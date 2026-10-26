<script setup lang="ts">
/**
 * TodoCard.vue — floating, collapsible TODO LIST panel.
 *
 * Renders the AUTHORITATIVE todo list: one row per todo id, exactly as the
 * backend holds it (`ctx.todo.getItems()` → `type: 'todos'` frame + the
 * `todos` field of /history).
 *
 * ## Why not the todo briefs
 *
 * This card used to reconstruct the list by parsing the `todo_create` /
 * `todo_update` / `todo_pinning` briefs that flow to the chat log. Those briefs
 * are EVENTS, not state: creating, updating and pinning one item in a single
 * turn produced three briefs, so the same todo rendered as three rows (the
 * `📌 pinned #7` + `☐ updated #7` + `☐ created #7` duplication). There is no
 * way to dedupe that honestly — two identical `updated #7` events are
 * genuinely two events.
 *
 * The backend now pushes a full snapshot on every mutation, and the panel
 * treats each frame as a REPLACEMENT. One id, one row, always current. The
 * briefs are untouched and still render as ordinary chat lines (MessageItem).
 *
 * ## Behaviour
 *   - collapsed by default — the header summarises progress (`n/m done`),
 *   - expands to list every todo, open items first, then completed ones
 *     (pinned is shown by the 📌 glyph and bold weight, not by the order),
 *   - hides entirely while the list is empty,
 *   - re-collapses when a todo is added (a new item starts a fresh view)
 *     without fighting the user's manual toggle otherwise.
 */
import { computed, ref, watch } from 'vue';
import type { TodoListEntry } from '../types';
import { todoHeader } from '../todo-header';

const props = defineProps<{ todos: TodoListEntry[] }>();

/** Open items first (the work in flight), then completed ones; id ascending
 *  within each group so a row never jumps when its neighbours change. */
const rows = computed(() => {
  const byId = [...props.todos].sort((a, b) => a.id - b.id);
  return [...byId.filter((t) => !t.done), ...byId.filter((t) => t.done)];
});

const hasRows = computed(() => rows.value.length > 0);

/**
 * Progress summary for the collapsed header: `TODO 2/6 done (pinned x1)`.
 *
 * The FORMAT lives in `todo-header.ts`, not here — this file has no test
 * harness, and a user-visible string that only a template can reach is a
 * string nobody locks. Keep the glyph OUT of the summary: the template renders
 * `span.todo-icon` (📋) beside it.
 */
const summary = computed(() => todoHeader(props.todos));

/** Collapse state: collapsed shows only the summary. Defaults to collapsed. */
const collapsed = ref(true);

function toggle(): void {
  collapsed.value = !collapsed.value;
}

// A GROWTH in the item count re-collapses the panel: a freshly added item is the
// agent starting new work, so the previous expansion no longer describes the
// list. A SHRINK must not — the auto-clear after everything is done would
// otherwise re-collapse a panel the user just opened.
const count = computed(() => props.todos.length);
watch(count, (next, prev) => {
  if (next > prev) collapsed.value = true;
});

/** Row glyph: 📌 pinned reminder, ☑ done, ☐ open. */
function icon(t: TodoListEntry): string {
  if (t.pinned) return '📌';
  return t.done ? '☑' : '☐';
}
</script>

<template>
  <div v-if="hasRows" class="todo-card" :class="{ collapsed }">
    <button class="todo-card-header" type="button" @click="toggle" :title="collapsed ? '点击展开 todo 列表' : '点击折叠'">
      <span class="todo-icon">📋</span>
      <span class="todo-summary">{{ summary }}</span>
      <span class="todo-chevron" :class="{ open: !collapsed }" aria-hidden="true">▾</span>
    </button>
    <div v-if="!collapsed" class="todo-card-body">
      <div
        v-for="t in rows"
        :key="t.id"
        class="todo-line"
        :class="{ done: t.done, pinned: t.pinned }"
        :title="t.note ?? undefined"
      >
        <span class="todo-icon" :class="{ done: t.done }">{{ icon(t) }}</span>
        <span class="todo-text">
          <span class="todo-id">#{{ t.id }}</span> {{ t.name }}
          <span v-if="t.preventStop" class="todo-guard">[guard: {{ t.preventStop }}]</span>
        </span>
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
.todo-line.done .todo-text {
  text-decoration: line-through;
}
.todo-line.pinned {
  font-weight: 600;
}
.todo-line .todo-text {
  min-width: 0;
  word-break: break-word;
}
.todo-id {
  opacity: 0.6;
}
.todo-guard {
  opacity: 0.75;
  font-style: italic;
}
</style>
