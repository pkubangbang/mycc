<script setup lang="ts">
import { computed } from 'vue';
import MarkdownIt from 'markdown-it';
import type { ChatMessage } from '../types';

const props = defineProps<{ message: ChatMessage }>();

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
        <template v-else-if="renderMarkdown">
          <!-- eslint-disable-next-line vue/no-v-html -- markdown-it escapes raw HTML (html:false) -->
          <div class="markdown-body" v-html="rendered"></div>
        </template>
        <template v-else>
          {{ message.content }}
        </template>
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
</style>