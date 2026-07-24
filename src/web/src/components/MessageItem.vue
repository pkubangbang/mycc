<script setup lang="ts">
import { computed, ref } from 'vue';
import MarkdownIt from 'markdown-it';
import type { ChatMessage } from '../types';

const props = defineProps<{
  message: ChatMessage;
  /** Quote-into-input callback. When the user clicks the 引用 (quote) button
   *  on a result bubble, the content is converted to a markdown blockquote
   *  and passed to this callback so the parent can append it to the chat
   *  input box. Optional — only the toolbar's quote button uses it. */
  onQuote?: (quotedText: string) => void;
}>();

// User messages align right (WeChat self-bubble style); everything else left.
const isUser = computed(() => props.message.type === 'user');

// Bash tool's pre-execution info log: brief('info', 'bash', command, intent)
// produces a LogEntry with type:'log', label:'bash', content:<command>,
// detail:<intent-lang>. The command is a raw shell string, NOT markdown —
// rendering it through markdown-it would mangle flags (e.g. -rf becoming a
// list item, --porcelain becoming an em-dash). Detect this case so the
// bubble renders the command as a monospace terminal block with a dollar
// prompt prefix, and keeps the intent in the dashed outline box. Warn/error
// bash logs (rejections) carry label:'bash' too but have type:'warn'/'error'
// — they keep their existing styling and are NOT treated as command cards.
const isBashCommand = computed(() =>
  props.message.type === 'log' && props.message.label === 'bash'
);

// Todo tool logs (todo_create / todo_update / todo_pinning) carry the full
// printTodoList() snapshot as `content`. The list is "extracted" from these
// bubbles and shown in the floating TodoCard (App.vue) instead, so the
// inline bubble hides the list body entirely. Only the header
// ([HH:MM:SS] [label]) and the `detail` summary (e.g. "Created #1: Name")
// above render — all three todo tools always pass a detail string.
const TODO_LABELS = new Set(['todo_create', 'todo_update', 'todo_pinning']);
const isTodoCard = computed(() =>
  props.message.type === 'log' && !!props.message.label && TODO_LABELS.has(props.message.label)
);

// Render markdown for conversational content (user + assistant result) and
// for labeled `log` messages (brief() structured status — e.g. the crossroad
// alternatives list). Unlabeled `log`/error/warn stay plain-text monospace —
// they are raw tool results where markdown interpretation would be noise.
// The labeled/unlabeled split mirrors the visibility rule in main.ts
// (isMessageVisible): a label marks a message as intentional structured
// status rather than raw stdout.
// EXCEPTION: a bash command log (label:'bash', type:'log') renders the
// command as a monospace terminal block — never markdown.
const renderMarkdown = computed(() =>
  !isBashCommand.value
  && (
    props.message.type === 'user'
    || props.message.type === 'result'
    || (props.message.type === 'log' && !!props.message.label)
  )
);

// markdown-it with html disabled (default) — raw HTML in LLM output is
// escaped, preventing XSS. linkify auto-links bare URLs; breaks converts
// single \n to <br> for chat-style line wrapping.
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

const rendered = computed(() =>
  renderMarkdown.value ? md.render(props.message.content) : '',
);

// Pre-wrap preserves tool output formatting (newlines, indentation).
// Monospace for log/result/error so code/output reads cleanly.
// EXCEPTION: a labeled `log` (brief structured status, e.g. crossroad) is
// rendered as markdown (see renderMarkdown) — it needs normal font + no
// pre-wrap, otherwise markdown's <p>/<ul>/<h3> would be forced monospace and
// distorted by white-space:pre-wrap. Unlabeled `log` is raw tool stdout →
// keep monospace + pre-wrap.
const isMonospace = computed(() => {
  if (props.message.type === 'log' && props.message.label) return false;
  return (
    props.message.type === 'log' ||
    props.message.type === 'error' ||
    props.message.type === 'warn'
  );
});

// Terminal-style [HH:MM:SS] [label] header — shown for non-user messages
// that carry a label (assistant/brief/question/bash/...). Mirrors the
// terminal brief() header so the Web UI reads like the terminal log.
const header = computed(() => {
  if (isUser.value) return '';
  const label = props.message.label;
  if (!label) return '';
  const ts = props.message.timestamp
    ? new Date(props.message.timestamp).toLocaleTimeString('en-GB', { hour12: false })
    : '';
  return ts ? `[${ts}] [${label}]` : `[${label}]`;
});

// ── Action toolbar (download / copy / quote) ──
//
// Only agent markdown replies (type:'result') get the toolbar. User messages
// and every other message type (log/warn/error/system/prompt) never show it.
// The toolbar lives INSIDE the result bubble, below the markdown body,
// separated by a hairline divider, right-aligned. It is always visible (no
// auto-hide) so the actions are discoverable without hovering.
const showToolbar = computed(() => props.message.type === 'result');

// Transient "已复制" feedback flag. Set true after a successful clipboard
// write, auto-reset after 1.5s so the button label swaps back. Using a ref
// (not part of the message object) keeps this UI-only state ephemeral and
// per-card — it never leaks into the persisted messageLog / transcript.
const copied = ref(false);
let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

// Download the raw markdown source of the reply as a .md file. Uses a Blob
// + a transient <a download> element (the standard programmatic-download
// pattern). The filename embeds the message timestamp when available so
// repeated downloads from different bubbles don't collide.
function downloadMarkdown(): void {
  const content = props.message.content ?? '';
  const ts = props.message.timestamp
    ? new Date(props.message.timestamp).toISOString().replace(/[:.]/g, '-').slice(0, 19)
    : Date.now().toString();
  const filename = `reply-${ts}.md`;
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on the next tick so the download has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Copy the raw markdown source to the system clipboard. Uses the async
// Clipboard API (navigator.clipboard.writeText), available in all modern
// browsers over http(s) + localhost. A 1.5s "已复制" label confirms success.
async function copyContent(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.message.content ?? '');
    copied.value = true;
    if (copyResetTimer) clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => { copied.value = false; }, 1500);
  } catch {
    // Clipboard API can reject in non-secure contexts (plain http on a
    // remote host) or when permissions are denied. Fall back to a hidden
    // textarea + execCommand('copy') so the feature still works there.
    try {
      const ta = document.createElement('textarea');
      ta.value = props.message.content ?? '';
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      copied.value = true;
      if (copyResetTimer) clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => { copied.value = false; }, 1500);
    } catch {
      /* clipboard unavailable — silently ignore; the button just no-ops */
    }
  }
}

// Quote the reply into the chat input box as a markdown blockquote.
// Each line of the source is prefixed with "> " so the whole reply becomes
// a single quote block when the user later sends it. A leading blank quote
// line + a trailing blank line leave a clean separation from any text the
// user types before/after. Invokes the onQuote prop callback; if no
// callback is wired, the button no-ops (graceful degradation).
function quoteContent(): void {
  if (!props.onQuote) return;
  const content = props.message.content ?? '';
  const quoted = content
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');
  // Blank quote line above + blank line below for readability.
  props.onQuote(`> \n${quoted}\n\n`);
}
</script>

<template>
  <div class="message-row" :class="{ 'is-user': isUser }">
    <div class="message-col">
      <div v-if="header" class="message-header">{{ header }}</div>
      <div class="bubble" :class="[message.type, { mono: isMonospace, 'bash-card': isBashCommand }]">
        <div v-if="message.detail" class="bubble-detail">{{ message.detail }}</div>
        <template v-if="isBashCommand">
          <!-- Bash command card: the shell command renders as a monospace
               terminal block with a dollar prompt prefix. The intent-lang
               string is already shown above in the .bubble-detail outline box. -->
          <pre class="bash-command"><span class="bash-prompt">$</span>{{ message.content }}</pre>
        </template>
        <template v-else-if="isTodoCard">
          <!-- Todo tool log: the full todoList snapshot is "extracted" into
               the floating TodoCard, so the inline bubble hides the list
               body entirely. Only the header + detail summary above render. -->
        </template>
        <template v-else-if="renderMarkdown">
          <!-- eslint-disable-next-line vue/no-v-html -- markdown-it escapes raw HTML (html:false) -->
          <div class="markdown-body" v-html="rendered"></div>
        </template>
        <template v-else>
          {{ message.content }}
        </template>
        <!-- Action toolbar — only on agent markdown replies (type:'result').
             Lives inside the bubble, below the markdown body, right-aligned,
             separated by a hairline divider. Download the raw markdown,
             copy it to the clipboard (with "已复制" feedback), or quote it
             into the chat input as a markdown blockquote. -->
        <div v-if="showToolbar" class="bubble-toolbar">
          <button
            class="toolbar-btn"
            title="下载 Markdown 文件"
            @click="downloadMarkdown"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span>下载</span>
          </button>
          <button
            class="toolbar-btn"
            :title="copied ? '已复制' : '复制内容'"
            @click="copyContent"
          >
            <svg v-if="!copied" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            <svg v-else viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
            <span>{{ copied ? '已复制' : '复制' }}</span>
          </button>
          <button
            class="toolbar-btn"
            title="引用内容到输入框"
            @click="quoteContent"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/>
              <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-1.25 5v1c0 1 0 1 1 1z"/>
            </svg>
            <span>引用</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.message-row {
  display: flex;
  padding: 4px 16px;
  margin: 2px 0;
}
.message-row.is-user {
  justify-content: flex-end;
}
.message-col {
  max-width: 80%;
  display: flex;
  flex-direction: column;
}
.message-row.is-user .message-col {
  align-items: flex-end;
}
.message-header {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 11px;
  color: var(--md-header-text);
  padding: 0 4px 2px;
  user-select: none;
}
.bubble {
  max-width: 100%;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 14px;
  line-height: 1.5;
  word-break: break-word;
}
.bubble.mono {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 13px;
  white-space: pre-wrap;
}
.bubble.user {
  background: var(--bubble-user-bg);
  color: var(--bubble-user-text);
}
.bubble.result {
  background: var(--bubble-result-bg);
  color: var(--bubble-result-text);
  border: 1px solid var(--bubble-result-border);
  box-shadow: var(--bubble-result-shadow);
}
.bubble.log,
.bubble.system {
  background: var(--bubble-log-bg);
  color: var(--bubble-log-text);
  border: 1px solid var(--bubble-log-border);
}
.bubble.warn {
  background: var(--bubble-warn-bg);
  color: var(--bubble-warn-text);
  border: 1px solid var(--bubble-warn-border);
}
.bubble.error {
  background: var(--bubble-error-bg);
  color: var(--bubble-error-text);
  border: 1px solid var(--bubble-error-border);
}
.bubble.prompt {
  background: var(--bubble-prompt-bg);
  color: var(--bubble-prompt-text);
  border: 1px solid var(--bubble-prompt-border);
  font-style: italic;
}

/* Tool intent box — outlined summary of what the tool was asked to do.
   Shown above the raw command/output, bordered and slightly inset so it
   stands out from the surrounding monospace content. */
.bubble-detail {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
  color: var(--text-primary);
  background: var(--md-code-bg);
  border: 1px dashed var(--border-input);
  border-radius: 5px;
  padding: 6px 10px;
  margin-bottom: 8px;
  white-space: normal;
  word-break: break-word;
  line-height: 1.4;
}

/* Bash command card — the bash tool's pre-execution info log
   (label:'bash', type:'log') is recognized and rendered as a reinforced
   card: the shell command sits in a monospace terminal block with a dollar
   prompt prefix, distinct from a plain log bubble. The intent-lang string
   renders above it in the .bubble-detail outline box (unchanged). The bubble
   itself stays sans-serif so the dashed intent box keeps its normal font;
   only the command block is monospace. */
.bubble.bash-card {
  background: var(--md-pre-bg);
  border: 1px solid var(--bubble-result-border);
}
.bash-command {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary);
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.bash-prompt {
  color: var(--accent);
  margin-right: 8px;
  user-select: none;
  font-weight: 600;
}

.markdown-body :deep(p) {
  margin: 0 0 8px;
}
.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  margin: 12px 0 6px;
  font-weight: 600;
  line-height: 1.3;
}
.markdown-body :deep(h1) { font-size: 1.3em; }
.markdown-body :deep(h2) { font-size: 1.2em; }
.markdown-body :deep(h3) { font-size: 1.1em; }
.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 4px 0 8px;
  padding-left: 22px;
}
.markdown-body :deep(li) {
  margin: 2px 0;
}
.markdown-body :deep(code) {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 13px;
  background: var(--md-code-bg);
  padding: 1px 5px;
  border-radius: 4px;
}
.markdown-body :deep(pre) {
  margin: 8px 0;
  padding: 10px 12px;
  background: var(--md-pre-bg);
  border-radius: 6px;
  overflow-x: auto;
}
.markdown-body :deep(pre code) {
  background: none;
  padding: 0;
  font-size: 13px;
  line-height: 1.5;
}
.markdown-body :deep(blockquote) {
  margin: 8px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--md-blockquote-border);
  color: var(--md-blockquote-text);
}
.markdown-body :deep(a) {
  color: var(--md-link);
  text-decoration: none;
}
.markdown-body :deep(a:hover) {
  text-decoration: underline;
}
.markdown-body :deep(table) {
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 13px;
}
.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid var(--md-table-border);
  padding: 6px 10px;
}
.markdown-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--md-hr);
  margin: 10px 0;
}

/* ── Action toolbar (download / copy / quote) ──
   Lives INSIDE the result bubble, below the markdown body. A hairline
   divider sits above it; the button row is right-aligned. Buttons are
   subtle text+icon chips — no strong background, just a hover tint — so
   they read as a quiet utility row rather than competing with the reply.
   Both light and dark themes are covered by using CSS variable tokens. */
.bubble-toolbar {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--md-hr);
}
.toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 12px;
  font-family: inherit;
  line-height: 1;
  color: var(--text-muted);
  cursor: pointer;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
  user-select: none;
}
.toolbar-btn svg {
  flex-shrink: 0;
}
.toolbar-btn:hover {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border-color: color-mix(in srgb, var(--accent) 30%, transparent);
}
.toolbar-btn:active {
  background: color-mix(in srgb, var(--accent) 20%, transparent);
}
</style>