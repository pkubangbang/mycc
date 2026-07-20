<script setup lang="ts">
import { computed } from 'vue';
import MarkdownIt from 'markdown-it';
import type { ChatMessage } from '../types';

const props = defineProps<{ message: ChatMessage }>();

// User messages align right (WeChat self-bubble style); everything else left.
const isUser = computed(() => props.message.type === 'user');

// Render markdown for conversational content (user + assistant result).
// Tool output / system / prompt / warn / error stay plain-text monospace —
// they are raw tool results where markdown interpretation would be noise.
const renderMarkdown = computed(() =>
  props.message.type === 'user' || props.message.type === 'result',
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
const isMonospace = computed(() =>
  props.message.type === 'log' ||
  props.message.type === 'error' ||
  props.message.type === 'warn',
);

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
      <div class="bubble" :class="[message.type, { mono: isMonospace }]">
        <template v-if="renderMarkdown">
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
/* Terminal-style [HH:MM:SS] [label] header — small grey monospace line
   above the bubble, mirroring the terminal brief() header. */
.message-header {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 11px;
  color: #999;
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
/* Plain-text bubbles keep pre-wrap for tool output formatting */
.bubble.mono {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 13px;
  white-space: pre-wrap;
}
/* User — WeChat green self-bubble */
.bubble.user {
  background: #95ec69;
  color: #000;
}
/* Assistant result (letter-box) — white bubble, dark text, with a soft
   light-green glow border to distinguish the LLM's final reply. */
.bubble.result {
  background: #fff;
  color: #333;
  border: 1px solid #b7eb8f;
  box-shadow: 0 0 6px 1px rgba(122, 200, 100, 0.45);
}
/* General logs — light gray */
.bubble.log,
.bubble.system {
  background: #fff;
  color: #666;
  border: 1px solid #e5e5e5;
}
/* Warnings — yellow tint */
.bubble.warn {
  background: #fffbe6;
  color: #ad6800;
  border: 1px solid #ffe58f;
}
/* Errors — red tint */
.bubble.error {
  background: #fff1f0;
  color: #cf1322;
  border: 1px solid #ffa39e;
}
/* Prompt — highlighted to draw the user's eye to the input request */
.bubble.prompt {
  background: #e6f7ff;
  color: #003a8c;
  border: 1px solid #91d5ff;
  font-style: italic;
}

/* ── Markdown body styling (result + user) ── */
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
  background: rgba(0, 0, 0, 0.06);
  padding: 1px 5px;
  border-radius: 4px;
}
.markdown-body :deep(pre) {
  margin: 8px 0;
  padding: 10px 12px;
  background: #f6f8fa;
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
  border-left: 3px solid #d0d7de;
  color: #666;
}
.markdown-body :deep(a) {
  color: #0969da;
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
  border: 1px solid #d0d7de;
  padding: 6px 10px;
}
.markdown-body :deep(hr) {
  border: none;
  border-top: 1px solid #e5e5e5;
  margin: 10px 0;
}
</style>