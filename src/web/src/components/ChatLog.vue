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

// Quote-into-input: invoked by MessageItem's 引用 button. Appends the quoted
// markdown block to the chat input box (state.inputText). If there's already
// text, a separator newline keeps the quote distinct from existing content.
// The watch in ChatInput.vue syncs state.inputText → its local textarea ref,
// so the inserted text appears immediately in the input box without needing
// to touch the textarea element directly.
function onQuote(quotedText: string): void {
  const existing = props.state.inputText;
  props.state.inputText = existing
    ? `${existing}\n${quotedText}`
    : quotedText;
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
      <MessageItem v-else :message="msg" :on-quote="onQuote" />
    </template>
    <!-- ESC / interrupt button — at the bottom of the chat history
         (document-relative, scrolls with content). Two variants share the
         same interrupt handler but differ in look:
           • RUNNING (not auto): the classic red button + spinning circle,
             signalling an in-progress task the user can stop.
           • AUTO mode (idle in WAIT): a sky-blue button with a line-art
             rocket whose exhaust streams fall like a streamline, signalling
             the lead is autonomously waiting and can be taken back over.
         Both stop a running task / exit auto mode (the interrupt triggers
         neglection, which the WAIT/STOP handlers catch to clear auto and
         resume the prompt). Distinct from the viewport-sticky
         scroll-to-bottom button below. -->
    <div v-if="state.isRunning && !state.isAutoMode" class="interrupt-row">
      <button
        class="interrupt-btn interrupt-btn--running"
        :disabled="state.connectionStatus !== 'connected'"
        title="停止当前任务 (相当于按 ESC)"
        @click="chatApi.sendInterrupt"
      >
        <span class="interrupt-spinner" aria-hidden="true"></span>
        停止
      </button>
    </div>
    <div v-else-if="state.isAutoMode" class="interrupt-row">
      <button
        class="interrupt-btn interrupt-btn--auto"
        :disabled="state.connectionStatus !== 'connected'"
        :title="state.isRunning ? '停止当前任务 (相当于按 ESC)' : '退出自动模式 (相当于按 ESC)'"
        @click="chatApi.sendInterrupt"
      >
        <svg class="interrupt-rocket" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <!-- Whole scene rotated 45° for delivery. Drawn upright first:
               1) U-shaped body, 2) window, 3) two fins, 4) three vertical
               line-shaped exhaust streams, 5) streams animate falling,
               6) rotate the entire group 45°. -->
          <g class="rocket-frame" transform="rotate(45 12 12)">
            <!-- 1. U-shaped rocket body with a rounded top (open at the bottom) -->
            <path d="M8 14 V7 A4 4 0 0 1 16 7 V14 Z"/>
            <!-- 2. Round window in the center, sized to the larger body -->
            <circle cx="12" cy="9" r="1.8"/>
            <!-- 3. Two fins on the sides, attached at the wider body corners -->
            <path d="M8 14 L5 17 L8 17"/>
            <path d="M16 14 L19 17 L16 17"/>
            <!-- 4. Three vertical line-shaped exhaust streams (animated),
                 spread across the wider bottom opening -->
            <line class="rocket-flame flame-a" x1="10" y1="14" x2="10" y2="18"/>
            <line class="rocket-flame flame-b" x1="12" y1="14" x2="12" y2="19"/>
            <line class="rocket-flame flame-c" x1="14" y1="14" x2="14" y2="18"/>
          </g>
        </svg>
        停止
      </button>
    </div>
    <button
      v-if="showScrollButton"
      class="scroll-bottom-btn"
      @click="scrollToBottom"
      title="滚动到底部"
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="6 9 12 15 18 9"/>
      </svg>
    </button>
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
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: var(--bg-scroll-btn);
  border: 1px solid var(--border-scroll);
  color: var(--text-secondary);
  cursor: pointer;
  box-shadow: var(--scroll-shadow);
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto;
  transition: background 0.15s, transform 0.15s;
  backdrop-filter: blur(4px);
}
.scroll-bottom-btn:hover {
  background: var(--bg-scroll-btn-hover);
  transform: translateX(-50%) scale(1.08);
}
.interrupt-row {
  display: flex;
  justify-content: center;
  padding: 12px 16px 8px;
}
.interrupt-btn {
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
.interrupt-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* RUNNING variant — classic red button + spinning circle, signalling an
   in-progress task the user can stop. */
.interrupt-btn--running {
  background: #ff7875;
}
.interrupt-btn--running:hover:not(:disabled) {
  background: #ff4d4f;
}
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
/* AUTO variant — sky-blue button with a line-art rocket whose exhaust
   streams fall like a streamline, signalling the lead is autonomously
   waiting and can be taken back over. */
.interrupt-btn--auto {
  background: #38bde8;
}
.interrupt-btn--auto:hover:not(:disabled) {
  background: #0ea5e9;
}
/* Line-art rocket (SVG) inside the auto-mode 停止 button. The whole scene
   is rotated 45°: a U-shaped body, a round window, two fins, and three
   vertical line-shaped exhaust streams that fall straight down like a
   streamline, one after another, looping continuously while the button is
   visible. */
.interrupt-rocket {
  flex-shrink: 0;
  display: inline-block;
}
.rocket-flame {
  transform-origin: top center;
  opacity: 0;
}
.flame-a {
  animation: rocket-burst 0.9s ease-in infinite;
  animation-delay: 0s;
}
.flame-b {
  animation: rocket-burst 0.9s ease-in infinite;
  animation-delay: 0.3s;
}
.flame-c {
  animation: rocket-burst 0.9s ease-in infinite;
  animation-delay: 0.6s;
}
@keyframes rocket-burst {
  0% {
    transform: translateY(0);
    opacity: 0;
  }
  20% {
    opacity: 1;
  }
  80% {
    opacity: 0.9;
  }
  100% {
    transform: translateY(4px);
    opacity: 0;
  }
}
</style>