<script setup lang="ts">
/**
 * TeammateDrawer.vue — right-half drawer with per-teammate accordions.
 *
 * A panel occupying the right 50% of the middle section. Contains vertically
 * stacked accordions, one per teammate:
 *   - Header:  `@name(count): current_tool` — click to toggle expand/collapse.
 *   - Body:    flat chronological timeline of that teammate's messages, each
 *              rendered with a `[tool]` prefix tag (extracted from the label)
 *              and a simplified message rendering (monospace for raw log/
 *              error, markdown for labeled structured content).
 *   - Each body scrolls independently (overflow-y: auto).
 *   - The first accordion (initiallyExpanded, or the first teammate) is
 *     expanded by default; multiple may be expanded simultaneously.
 *   - A close button (✕) in the top-right dismisses the drawer.
 *
 * Grouping is a frontend computed property — no backend per-teammate state.
 * See the "@-prefix teammate label convention" section in MYCC.md.
 */
import { ref, computed, watch, nextTick } from 'vue';
import MarkdownIt from 'markdown-it';
import type { ChatMessage } from '../types';

const props = defineProps<{
  teammateMessages: ChatMessage[];
  /** Teammate name to expand on open. If empty, the first teammate expands. */
  initiallyExpanded: string;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

interface TeammateGroup {
  name: string;
  count: number;
  currentTool: string;
  messages: ChatMessage[];
  /** True when this teammate's last message is the exit notice (toolTag
   *  'exit'), i.e. the teammate has "retired". A newer non-exit message
   *  (re-activation) flips this back to false. Drives the "已完成" badge in
   *  the accordion header and the TeammateCard collapse logic. */
  done: boolean;
}

function teammateName(label: string | undefined): string | null {
  if (!label || !label.startsWith('@')) return null;
  const rest = label.slice(1);
  const slashIdx = rest.indexOf('/');
  return slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
}

function toolTag(label: string | undefined): string | null {
  if (!label || !label.startsWith('@')) return null;
  const rest = label.slice(1);
  const slashIdx = rest.indexOf('/');
  return slashIdx >= 0 ? rest.slice(slashIdx + 1) : null;
}

/** Group teammate messages by teammate name, preserving first-seen order. */
const groups = computed<TeammateGroup[]>(() => {
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
      messages: msgs,
      done: last !== null && toolTag(last.label) === 'exit',
    };
  });
});

// Expanded accordions — a Set of teammate names. Initialized from
// initiallyExpanded (or the first teammate) on open.
const expanded = ref<Set<string>>(new Set());

// Initialize the expanded set when the drawer opens or when the initially
// expanded teammate changes. The first accordion expands by default.
watch(
  () => props.initiallyExpanded,
  (name) => {
    const next = new Set<string>();
    if (name && groups.value.some(g => g.name === name)) {
      next.add(name);
    } else if (groups.value.length > 0) {
      next.add(groups.value[0].name);
    }
    expanded.value = next;
  },
  { immediate: true },
);

// Re-run default expansion if initiallyExpanded was empty and the first
// group arrives later (history load race).
watch(
  () => groups.value.length,
  (len, prevLen) => {
    if (prevLen === 0 && len > 0 && expanded.value.size === 0) {
      const first = groups.value[0].name;
      if (first) {
        const next = new Set(expanded.value);
        next.add(first);
        expanded.value = next;
      }
    }
  },
);

function toggle(name: string): void {
  const next = new Set(expanded.value);
  if (next.has(name)) {
    next.delete(name);
  } else {
    next.add(name);
  }
  expanded.value = next;
}

// ── Message rendering helpers ──

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

/**
 * Whether a message's content should render as markdown vs plain text.
 * Mirrors MessageItem.vue's rule: conversational content (result) and
 * labeled `log` messages render as markdown; raw unlabeled logs/errors stay
 * monospace plain text. The bash command card (label ends with /bash) is
 * rendered as a terminal block.
 */
function renderMarkdown(m: ChatMessage): boolean {
  if (isBashCommand(m)) return false;
  return m.type === 'result' || (m.type === 'log' && !!m.label);
}

/** Bash tool's pre-exec info log: @name/bash with type 'log'. Render the
 *  command (content) as a monospace terminal block with a $ prompt. */
function isBashCommand(m: ChatMessage): boolean {
  return m.type === 'log' && m.label?.endsWith('/bash');
}

function rendered(m: ChatMessage): string {
  return renderMarkdown(m) ? md.render(m.content) : '';
}

function isMonospace(m: ChatMessage): boolean {
  if (m.type === 'log' && m.label) return false;
  return m.type === 'log' || m.type === 'error' || m.type === 'warn';
}

/** The [tool] prefix tag for a timeline entry, extracted from the label. */
function toolPrefix(m: ChatMessage): string {
  const tool = toolTag(m.label);
  return tool ? `[${tool}]` : '';
}

function timeStr(m: ChatMessage): string {
  return m.timestamp
    ? new Date(m.timestamp).toLocaleTimeString('en-GB', { hour12: false })
    : '';
}

// Auto-scroll the body of an expanded accordion to the bottom when new
// messages arrive, mirroring ChatLog.vue's stick-to-bottom behavior. We use
// a per-teammate ref map.
const bodyRefs = new Map<string, HTMLElement | null>();

function setBodyRef(name: string, el: Element | null): void {
  bodyRefs.set(name, el as HTMLElement | null);
}

function scrollToBottom(name: string): void {
  const el = bodyRefs.get(name);
  if (el) {
    el.scrollTop = el.scrollHeight;
  }
}

// Watch each group's message count; when it grows, scroll the body to bottom.
watch(
  () => groups.value.map(g => `${g.name}:${g.messages.length}`).join('|'),
  () => {
    for (const g of groups.value) {
      if (expanded.value.has(g.name)) {
        nextTick(() => scrollToBottom(g.name));
      }
    }
  },
);

function onClose(): void {
  emit('close');
}

// ── Draggable drawer width ──
//
// The drawer width is user-adjustable by dragging a vertical handle on its
// left edge. We track width in px (clamped to [MIN_WIDTH, parent - MIN_LEFT])
// so neither side gets over-compressed. The handle uses pointer events for
// smooth cross-platform dragging. MIN_LEFT ensures the chat log keeps at
// least MIN_LEFT px; MIN_WIDTH ensures the drawer keeps at least MIN_WIDTH px.
const MIN_WIDTH = 280;   // px — drawer never narrower than this
const MIN_LEFT = 320;     // px — chat log never narrower than this
const drawerWidth = ref(0);  // 0 = unset → CSS default (50%)

const drawerRef = ref<HTMLElement | null>(null);
let dragging = false;

function onHandleDown(e: PointerEvent): void {
  dragging = true;
  // Capture so we keep receiving pointermove even if the cursor leaves the
  // handle (e.g. over the chat log while dragging wider).
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
  e.preventDefault();
}

function onHandleMove(e: PointerEvent): void {
  if (!dragging) return;
  const parent = drawerRef.value?.parentElement;
  if (!parent) return;
  const rect = parent.getBoundingClientRect();
  // Drawer is on the RIGHT: width = parent right edge - pointer x.
  const w = rect.right - e.clientX;
  const maxW = rect.width - MIN_LEFT;
  drawerWidth.value = Math.max(MIN_WIDTH, Math.min(w, maxW));
}

function onHandleUp(e: PointerEvent): void {
  dragging = false;
  try {
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  } catch {
    /* already released */
  }
}

const drawerStyle = computed(() =>
  drawerWidth.value > 0 ? { width: `${drawerWidth.value}px` } : {},
);
</script>

<template>
  <div class="teammate-drawer" ref="drawerRef" :style="drawerStyle">
    <!-- Draggable resize handle on the left edge. Pointer events drive the
         width change; the handle is a thin vertical bar with a wider
         hit area (transparent gutter) for easier grabbing. -->
    <div
      class="drawer-resize-handle"
      @pointerdown="onHandleDown"
      @pointermove="onHandleMove"
      @pointerup="onHandleUp"
      @pointercancel="onHandleUp"
      title="拖拽调整宽度"
    ></div>
    <div class="drawer-header">
      <span class="drawer-title">Teammates</span>
      <button class="drawer-close" type="button" title="关闭" @click="onClose">✕</button>
    </div>
    <div class="accordion-list">
      <div
        v-for="g in groups"
        :key="g.name"
        class="accordion"
        :class="{ expanded: expanded.has(g.name) }"
      >
        <button
          class="accordion-header"
          type="button"
          :class="{ expanded: expanded.has(g.name), done: g.done }"
          @click="toggle(g.name)"
        >
          <!-- Static caret (no rotation animation per user request); just
               swaps glyph between collapsed ▸ and expanded ▾. -->
          <span class="acc-caret">{{ expanded.has(g.name) ? '▾' : '▸' }}</span>
          <span class="acc-name">@{{ g.name }}</span>
          <span class="acc-count">({{ g.count }})</span>
          <span class="acc-sep">:</span>
          <span class="acc-tool">{{ g.currentTool }}</span>
          <span v-if="g.done" class="acc-done" title="该 teammate 已退出">已完成</span>
        </button>
        <!-- Expanded body: the accordion grows via flex to share the
             drawer's remaining height equally with other expanded
             accordions. The body scrolls within its flex allotment.
             Collapsed accordions render ONLY the header (no body), so they
             show just the count + current tool, not a message list. -->
        <div
          v-if="expanded.has(g.name)"
          class="accordion-body"
          :ref="(el) => setBodyRef(g.name, el)"
        >
          <div
            v-for="(m, idx) in g.messages"
            :key="m.id ?? idx"
            class="tm-row"
          >
            <div class="tm-meta">
              <span v-if="timeStr(m)" class="tm-time">{{ timeStr(m) }}</span>
              <span v-if="toolPrefix(m)" class="tm-tool">{{ toolPrefix(m) }}</span>
            </div>
            <div
              class="tm-bubble"
              :class="[m.type, { mono: isMonospace(m), 'bash-card': isBashCommand(m) }]"
            >
              <div v-if="m.detail" class="tm-detail">{{ m.detail }}</div>
              <template v-if="isBashCommand(m)">
                <pre class="tm-bash"><span class="tm-prompt">$</span>{{ m.content }}</pre>
              </template>
              <template v-else-if="renderMarkdown(m)">
                <!-- eslint-disable-next-line vue/no-v-html -- markdown-it escapes raw HTML -->
                <div class="tm-md" v-html="rendered(m)"></div>
              </template>
              <template v-else>
                {{ m.content }}
              </template>
            </div>
          </div>
          <div v-if="g.messages.length === 0" class="tm-empty">No messages yet.</div>
        </div>
      </div>
      <div v-if="groups.length === 0" class="tm-empty drawer-empty">No teammate messages.</div>
    </div>
  </div>
</template>

<style scoped>
.teammate-drawer {
  height: 100%;
  background: var(--bg-chat-log);
  border-left: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  /* Default width when the user hasn't dragged the handle. The drag logic
     overrides this with an inline px width once dragging starts. */
  width: 50%;
  min-width: 280px;
  flex-shrink: 0;
}
/* Draggable resize handle — a thin vertical bar on the left edge. The
   visible bar is 3px; a wider transparent gutter (padding) makes it easy
   to grab. A hover/active highlight tells the user it's draggable. */
.drawer-resize-handle {
  position: absolute;
  top: 0;
  left: -4px;
  width: 3px;
  height: 100%;
  padding: 0 4px;
  cursor: col-resize;
  background: var(--border-color);
  z-index: 5;
  transition: background 0.15s;
}
.drawer-resize-handle:hover,
.drawer-resize-handle:active {
  background: var(--accent);
}
.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  /* Distinct from the StatusBar: use the app background (not --bg-status)
     so the drawer header reads as its own panel, not a continuation of the
     top status bar. A bottom border separates it from the accordion list. */
  background: var(--bg-app);
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}
.drawer-title {
  font-weight: 700;
  font-size: 14px;
  /* Accent color so the title stands out from the surrounding app-bg header
     and is clearly a section label, not a status bar echo. */
  color: var(--accent);
}
.drawer-close {
  background: transparent;
  color: var(--text-secondary);
  border: none;
  font-size: 16px;
  cursor: pointer;
  padding: 2px 8px;
  border-radius: 4px;
  line-height: 1;
}
.drawer-close:hover {
  background: var(--md-code-bg);
  color: var(--text-primary);
}
/* The list is a vertical flex column that fills the drawer's remaining
   height (after the header). It does NOT scroll itself — the expanded
   accordion bodies scroll individually within their flex allotment, and
   the whole stack is capped at the drawer height so expanded accordions
   together never exceed it. */
.accordion-list {
  flex: 1;
  min-height: 0;            /* allow children to shrink within the flex column */
  display: flex;
  flex-direction: column;
  padding: 4px 0;
  overflow: hidden;
}
.accordion {
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--border-color);
  /* Collapsed: only the header shows, sized to content (no grow/shrink). */
  flex: 0 0 auto;
  min-height: 0;
}
/* Expanded: grow to share the remaining drawer height equally with other
   expanded accordions. Multiple expanded accordions split the space evenly
   (flex:1 each); the bodies scroll inside their allotment. */
.accordion.expanded {
  flex: 1 1 0;
}
.accordion-header {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  /* Dedicated mild header color — distinct from the chat-log background in
     both themes without being a prominent dark band. See --bg-acc-header in
     style.css. */
  background: var(--bg-acc-header);
  color: var(--text-acc-header);
  border: none;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  text-align: left;
  transition: background 0.12s;
}
.accordion-header:hover {
  background: var(--bg-acc-header-hover);
}
.accordion-header.expanded {
  background: var(--bg-acc-header-expanded);
}
.acc-caret {
  display: inline-block;
  /* Static glyph swap (no rotation animation) per user request. */
  color: var(--text-acc-meta);
  opacity: 0.8;
  width: 12px;
}
.acc-name {
  font-weight: 600;
  color: #5cdbd3;
}
.acc-count {
  color: var(--text-acc-meta);
}
.acc-sep {
  color: var(--text-acc-meta);
}
.acc-tool {
  color: #ffd666;
  margin-left: 2px;
}
/* "已完成" badge shown when a teammate's last message is the exit notice.
   Pushed to the right edge of the header via margin-left:auto so it reads as
   a status pill, not part of the tool line. */
.acc-done {
  margin-left: auto;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--accent-text);
  background: color-mix(in srgb, var(--accent) 70%, transparent);
}
/* Dim a retired teammate's header slightly so the done state is scannable
   at a glance without obscuring the tool line. */
.accordion-header.done {
  opacity: 0.78;
}
/* Expanded accordion body: fills the accordion's flex-grown height and
   scrolls internally. min-height:0 lets the flex item shrink so the body
   never overflows the drawer; the body's own overflow-y handles long
   timelines. Collapsed accordions render no body at all (v-if), so they show
   only the header count + current tool. */
.accordion-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 12px;
  background: var(--bg-chat-log);
}
.tm-row {
  padding: 4px 0;
}
.tm-meta {
  display: flex;
  gap: 6px;
  align-items: center;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 11px;
  color: var(--md-header-text);
  padding: 0 2px 2px;
}
.tm-time {
  color: var(--text-muted);
}
.tm-tool {
  color: #ffd666;
  font-weight: 600;
}
.tm-bubble {
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
  background: var(--bubble-log-bg);
  color: var(--bubble-log-text);
  border: 1px solid var(--bubble-log-border);
}
.tm-bubble.error {
  background: var(--bubble-error-bg);
  color: var(--bubble-error-text);
  border-color: var(--bubble-error-border);
}
.tm-bubble.warn {
  background: var(--bubble-warn-bg);
  color: var(--bubble-warn-text);
  border-color: var(--bubble-warn-border);
}
.tm-bubble.result {
  background: var(--bubble-result-bg);
  color: var(--bubble-result-text);
  border-color: var(--bubble-result-border);
}
.tm-bubble.mono {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  white-space: pre-wrap;
}
.tm-bubble.bash-card {
  background: var(--md-pre-bg);
}
.tm-detail {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 12px;
  color: var(--text-primary);
  background: var(--md-code-bg);
  border: 1px dashed var(--border-input);
  border-radius: 4px;
  padding: 5px 8px;
  margin-bottom: 6px;
  white-space: normal;
  word-break: break-word;
  line-height: 1.4;
}
.tm-bash {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-primary);
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.tm-prompt {
  color: var(--accent);
  margin-right: 6px;
  user-select: none;
  font-weight: 600;
}
.tm-md :deep(p) {
  margin: 0 0 6px;
}
.tm-md :deep(p:last-child) {
  margin-bottom: 0;
}
.tm-md :deep(code) {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  background: var(--md-code-bg);
  padding: 1px 4px;
  border-radius: 3px;
}
.tm-md :deep(pre) {
  margin: 6px 0;
  padding: 8px 10px;
  background: var(--md-pre-bg);
  border-radius: 5px;
  overflow-x: auto;
}
.tm-md :deep(a) {
  color: var(--md-link);
  text-decoration: none;
}
.tm-empty {
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
  padding: 16px 8px;
}
.drawer-empty {
  padding: 32px 8px;
}
</style>