<script setup lang="ts">
import { ref, watch } from 'vue';
import type { ChatState } from '../types';
import { chatApi } from '../main';

const props = defineProps<{ state: ChatState }>();

// Local textarea model — synced with state.inputText for HMR persistence.
// Use a ref bound to the textarea; on send we read its value.
const text = ref(props.state.inputText);

// Keep local ref in sync if state.inputText changes externally (e.g. cleared)
watch(
  () => props.state.inputText,
  (val) => {
    if (val !== text.value) text.value = val;
  },
);

// Sync user keystrokes back to the module-level ChatState so typed text
// survives Vue component HMR (ChatInput.vue reload).
watch(text, (val) => {
  props.state.inputText = val;
});

function send(): void {
  const value = text.value;
  if (!value.trim()) return;
  // showRetry no longer blocks typing: promptRetry now uses an interactive
  // card (Yes/No), so a stale showRetry flag should not strand the user. If a
  // retry card is pending, plain input still resolves via the WS 'input'
  // path; if no prompt is pending, route to steering.
  if (props.state.isWaiting || props.state.showRetry) {
    chatApi.sendInput(value);
  } else if (props.state.isRunning) {
    chatApi.sendSteer(value);
  }
  text.value = '';
}

// Enter sends; Shift+Enter inserts a newline (default textarea behavior).
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
}
</script>

<template>
  <div class="chat-input">
    <div class="input-row">
      <textarea
        v-model="text"
        class="input-area"
        :placeholder="state.isWaiting ? '输入消息…' : '等待回复中…'"
        :disabled="(!state.isWaiting && !state.isRunning) || state.connectionStatus !== 'connected'"
        rows="2"
        @keydown="onKeydown"
      ></textarea>
      <button
        class="send-btn"
        :disabled="!text.trim() || (!state.isWaiting && !state.showRetry && !state.isRunning) || state.connectionStatus !== 'connected'"
        @click="send"
      >发送</button>
    </div>
  </div>
</template>

<style scoped>
.chat-input {
  display: flex;
  padding: 8px 16px 16px;
  background: var(--bg-input);
  border-top: 1px solid var(--border-color);
  flex-shrink: 0;
}
.input-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
}
.input-area {
  flex: 1;
  resize: none;
  border: 1px solid var(--border-input);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 14px;
  font-family: inherit;
  line-height: 1.5;
  max-height: 120px;
  outline: none;
  background: var(--bg-input-field);
  color: var(--text-primary);
}
.input-area:focus {
  border-color: var(--accent);
}
.input-area:disabled {
  background: var(--bg-input-field-disabled);
  color: var(--text-input-disabled);
}
.send-btn {
  background: var(--accent);
  color: var(--accent-text);
  border: none;
  padding: 8px 20px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  height: 40px;
  font-weight: 500;
  transition: opacity 0.15s;
}
.send-btn:not(:disabled):hover {
  opacity: 0.85;
}
.send-btn:disabled {
  background: var(--accent-disabled);
  cursor: not-allowed;
}
</style>