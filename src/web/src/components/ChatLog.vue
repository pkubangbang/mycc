<script setup lang="ts">
import { ref, watch, nextTick, onMounted, computed } from 'vue';
import type { ChatMessage, ChatState } from '../types';
import { chatApi, isMessageVisible } from '../main';
import MessageItem from './MessageItem.vue';
import CardItem from './CardItem.vue';

const props = defineProps<{ messages: ChatMessage[]; state: ChatState }>();

const scrollContainer = ref<HTMLElement | null>(null);
const showScrollButton = ref(false);
let userScrolledUp = false;

// Visible messages: filtered by the 详细日志 toggle. When off, only
// user-facing lines (user/result/assistant/brief/question/prompt) show;
// when on, all logs are visible.
const visibleMessages = computed(() =>
  props.messages.filter(m => isMessageVisible(m, props.state.verboseLogs)),
);

function isAtBottom(): boolean {
  const el = scrollContainer.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 50;
}

function scrollToBottom(): void {
  const el = scrollContainer.value;
  if (el) {
    el.scrollTop = el.scrollHeight;
    userScrolledUp = false;
    showScrollButton.value = false;
  }
}

function onScroll(): void {
  if (isAtBottom()) {
    showScrollButton.value = false;
    userScrolledUp = false;
  } else {
    userScrolledUp = true;
    showScrollButton.value = true;
  }
}

// Watch for new messages — auto-scroll only if user is already at bottom
watch(
  () => visibleMessages.value.length,
  () => {
    if (!userScrolledUp) {
      nextTick(() => scrollToBottom());
    }
  },
);

onMounted(() => {
  scrollToBottom();
});
</script>

<template>
  <div class="chat-log" ref="scrollContainer" @scroll="onScroll">
    <template
      v-for="(msg, index) in visibleMessages"
      :key="msg.id ?? index"
    >
      <CardItem v-if="msg.type === 'card' && msg.card" :card="msg.card" />
      <MessageItem v-else :message="msg" />
    </template>
    <!-- ESC / interrupt button — at the bottom of the chat history
         (document-relative, scrolls with content), shown only while the
         agent is actively working. Distinct from the viewport-sticky
         scroll-to-bottom button below. -->
    <div v-if="state.isRunning" class="interrupt-row">
      <button
        class="interrupt-btn"
        :disabled="state.connectionStatus !== 'connected'"
        title="停止当前任务 (相当于按 ESC)"
        @click="chatApi.sendInterrupt"
      >
        <span class="interrupt-spinner" aria-hidden="true"></span>
        停止
      </button>
    </div>
    <button
      v-if="showScrollButton"
      class="scroll-bottom-btn"
      @click="scrollToBottom"
      title="滚动到底部"
    >↓</button>
  </div>
</template>

<style scoped>
.chat-log {
  flex: 1;
  overflow-y: auto;
  padding: 12px 0;
  position: relative;
}
.scroll-bottom-btn {
  position: sticky;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: #fff;
  border: 1px solid #d9d9d9;
  color: #595959;
  font-size: 18px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto;
}
.scroll-bottom-btn:hover {
  background: #f5f5f5;
}
.interrupt-row {
  display: flex;
  justify-content: center;
  padding: 12px 16px 8px;
}
.interrupt-btn {
  background: #ff7875;
  color: #fff;
  border: none;
  padding: 6px 20px;
  border-radius: 16px;
  cursor: pointer;
  font-size: 13px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.interrupt-btn:hover {
  background: #ff4d4f;
}
.interrupt-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* Spinning indicator inside the 停止 button — animates continuously
   while the button is visible (i.e., while the agent is running),
   signalling that work is in progress and can be interrupted. */
.interrupt-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.45);
  border-top-color: #fff;
  border-radius: 50%;
  animation: interrupt-spin 0.8s linear infinite;
  flex-shrink: 0;
}
@keyframes interrupt-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>