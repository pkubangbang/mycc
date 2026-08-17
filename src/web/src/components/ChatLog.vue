<script setup lang="ts">
import { ref, watch, nextTick, onMounted, computed } from 'vue';
import type { ChatMessage, ChatState } from '../types';
import { chatApi, isMessageVisible } from '../main';
import MessageItem from './MessageItem.vue';
import CardItem from './CardItem.vue';
import SteeringReviewCard from './SteeringReviewCard.vue';
import RocketIcon from './RocketIcon.vue';
import MeteorField from './MeteorField.vue';

const props = defineProps<{ messages: ChatMessage[]; state: ChatState }>();

const scrollContainer = ref<HTMLElement | null>(null);
const showScrollButton = ref(false);
let userScrolledUp = false;

// The auto-mode stop button's "hyperspace jump" visuals (rocket + meteor
// starfield) now live in two dedicated components — RocketIcon and
// MeteorField — imported above. ChatLog only passes the `warping` prop
// (= state.isRunning) down; the animation-iteration listener, meteor
// randomization, and animation-play-state gating are encapsulated there
// (and paused when not warping), so ChatLog no longer holds warp-field
// refs or lifecycle hooks for them.

// Visible messages: filtered by the 详细日志 toggle. When off, only
// user-facing lines (user/result/assistant/brief/question/prompt) show;
// when on, all logs are visible.
const visibleMessages = computed(() =>
  props.messages.filter(m => isMessageVisible(m, props.state.verboseLogs)),
);

// v-for key for each visible message: "<raw-timestamp> <label>"
// (e.g. "1723391724123 assistant"). The raw millisecond timestamp encodes
// the time and the label is the tool name — together they form a readable,
// time+tool key as requested.
//
// UNIQUENESS: the raw ms timestamp is far more unique than second-granularity
// HH:MM:SS — two same-label messages would need to share the exact same
// millisecond to collide, which is extremely rare. No index suffix is needed
// in the common case.
//
// FALLBACK: timestamp and label are both optional. When either is absent
// (raw verbose logs, history-loaded messages predating the timestamp/label
// scheme), the key falls back to the index to guarantee uniqueness.
function messageKey(msg: ChatMessage, index: number): string {
  const ts = msg.timestamp;
  const label = msg.label ?? '';
  if (ts && label) {
    return `${ts} ${label}`;
  }
  if (ts) {
    return String(ts);
  }
  if (label) {
    return `${label}-${index}`;
  }
  return String(index);
}

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

// ── Steering review "继续…" card handlers ──
//
// When the agent reaches PROMPT (isWaiting) with steering notes still pending
// in state.pendingSteeringReview (populated by main.ts at the 'prompt' message
// from notes the agent never consumed — NOT from drained notes), SteeringReviewCard
// renders at the tail of the chat flow and emits the user's choice here. The
// "send as query" path captures the notes into a local, clears the array,
// THEN calls sendInput — in that order — so the array is empty before the
// PROMPT ends (no separate watcher is needed; pendingSteeringReview persists
// across PROMPT cycles until the user explicitly acts, and is only cleared
// elsewhere at explicit abandon events: disconnect and auto-mode entry, both
// in main.ts).
function onSendSteeringAsQuery(): void {
  if (props.state.pendingSteeringReview.length === 0) return;
  // Combine remaining notes with a blank-line separator, then clear before
  // the send so the array is empty by the time the PROMPT ends.
  const combined = props.state.pendingSteeringReview.join('\n\n');
  props.state.pendingSteeringReview.splice(0);
  chatApi.sendInput(combined);
}

function onDiscardSteeringNote(index: number): void {
  props.state.pendingSteeringReview.splice(index, 1);
  // If the last note is discarded, the array is empty → the card's v-if
  // becomes false and the card auto-hides; the normal input box re-enables.
}

function onDiscardAllSteering(): void {
  props.state.pendingSteeringReview.splice(0);
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

// Re-scroll to bottom when the interrupt/rocket row appears or disappears.
// The row is rendered at the TAIL of the scroll content (document-relative,
// not sticky), gated on isRunning/isAutoMode. Its presence changes
// scrollHeight but NOT visibleMessages.length, so the message-count watcher
// above does not fire when it toggles. The critical case is a page refresh
// in auto mode: fetchHistory() populates messages with isAutoMode still
// false (the /history payload carries isRunning, not the auto flag), so
// onMounted's scrollToBottom() runs BEFORE the rocket row exists; the auto
// flag only flips later via the WS 'auto' broadcast from onWsConnection,
// which grows scrollHeight with no re-scroll — leaving the rocket below the
// fold. Watching the flags and re-scrolling (only when the user hasn't
// pinned up) keeps the tail — and thus the rocket — in view.
//
// The same applies to the transient SteeringReviewCard at the tail: it
// appears/disappears when isWaiting toggles or pendingSteeringReview empties,
// changing scrollHeight without touching visibleMessages.length. Adding
// those to the watched tuple keeps the card in view when it surfaces at
// PROMPT.
watch(
  () => [props.state.isAutoMode, props.state.isRunning, props.state.isWaiting, props.state.pendingSteeringReview.length] as const,
  () => {
    if (!userScrolledUp) {
      nextTick(() => scrollToBottom());
    }
  },
);

onMounted(() => {
  scrollToBottom();
  // The meteor starfield's animationiteration listener + birth-position
  // seeding now live inside MeteorField.vue (self-managed, gated on its
  // `warping` prop), so there is nothing warp-related to wire up here.
});
</script>

<template>
  <div class="chat-log" ref="scrollContainer" @scroll="onScroll">
    <template
      v-for="(msg, index) in visibleMessages"
      :key="messageKey(msg, index)"
    >
      <CardItem v-if="msg.type === 'card' && msg.card" :card="msg.card" />
      <MessageItem v-else :message="msg" :on-quote="onQuote" />
    </template>
    <!-- Temporary "继续…" card: surfaces flushed steering notes for the user
         to send as a query or discard when the agent reaches PROMPT. Rendered
         at the tail of the chat flow (same visual spot as other cards) but
         NOT stored in messages — purely transient, auto-hides when
         pendingSteeringReview empties or isWaiting flips false. -->
    <SteeringReviewCard
      v-if="state.isWaiting && state.pendingSteeringReview.length > 0"
      :notes="state.pendingSteeringReview"
      @send-as-query="onSendSteeringAsQuery"
      @discard-note="onDiscardSteeringNote"
      @discard-all="onDiscardAllSteering"
    />
    <!-- ESC / interrupt button — at the bottom of the chat history
         (document-relative, scrolls with content). Two variants share the
         same interrupt handler but differ in look:
           • RUNNING (not auto): the classic red button + spinning circle,
             signalling an in-progress task the user can stop.
           • AUTO mode: a sky-blue button with a line-art rocket. When the
             agent is actively processing (isRunning), a "hyperspace jump"
             warp background appears behind the rocket and the exhaust
             flames animate; when idle (WAIT), the background fades out and
             the rocket sits still, signalling the lead is autonomously
             waiting and can be taken back over.
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
    <div v-else-if="state.isAutoMode" class="interrupt-row interrupt-row--auto" :class="{ 'is-warping': state.isRunning }">
      <button
        class="interrupt-btn interrupt-btn--auto"
        :class="{ 'is-warping': state.isRunning }"
        :disabled="state.connectionStatus !== 'connected'"
        :title="state.isRunning ? '停止当前任务 (相当于按 ESC)' : '退出自动模式 (相当于按 ESC)'"
        @click="chatApi.sendInterrupt"
      >
        <!-- The "warp jump" scene is now split into two dedicated
             components, both driven by the `warping` prop (= isRunning):
               • <MeteorField> — the clipped meteor starfield. It pauses its
                 CSS animations + detaches its animationiteration listener
                 when not warping, so WAIT (idle auto) costs nothing.
               • <RocketIcon> — the line-art rocket + exhaust. The
                 high-energy (faster) exhaust variant is gated on warping.
             The button itself stays the clip frame (overflow:hidden).

             GEOMETRY NOTE: <MeteorField> is a child component, so its root
             <span> is a flex item of this inline-flex button — unlike the
             original bare <span class="warp-field"> which was a direct,
             position:absolute child taken out of flex flow. To preserve
             the original full-button width we wrap <MeteorField> in a
             .warp-stage span that is positioned:absolute;inset:0 HERE (in
             ChatLog's own scoped tree, where the rule is guaranteed to
             apply), taking the component root out of flex flow. MeteorField
             itself then fills this stage (position:static; inset:auto) —
             see MeteorField.vue. -->
        <span class="warp-stage" aria-hidden="true">
          <MeteorField :warping="state.isRunning" />
        </span>
        <RocketIcon :warping="state.isRunning" />
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
/* AUTO variant — sky-blue button framing a small "warp jump" scene clipped
   inside it. The button itself is just the clip frame (overflow:hidden); the
   actual effect now lives in two child components:
     • <MeteorField> — the meteor starfield (moves top-right → bottom-left,
       opposite the rocket's flight direction); pauses + detaches its
       listener when not warping.
     • <RocketIcon> — the rocket SVG + exhaust; high-energy exhaust is gated
       on the `warping` prop.
   The button never uses a background-image texture for the effect. */
.interrupt-btn--auto {
  background-color: #38bde8;
  position: relative;
  /* overflow:hidden turns the button into the clip frame for the
     MeteorField and any rocket bob, so meteors/streaks never bleed outside
     the pill. */
  overflow: hidden;
  transition: background-color 0.4s ease;
}
.interrupt-btn--auto:hover:not(:disabled) {
  background-color: #0ea5e9;
}
.interrupt-btn--auto.is-warping {
  background-color: #1e8ab5;
}
/* The absolute-positioned stage that carries <MeteorField>. This lives in
   ChatLog's own scoped tree (not MeteorField's) so the position:absolute;
   inset:0 is guaranteed to apply to this direct child of the button —
   reproducing the original geometry where .warp-field was a bare,
   out-of-flow span filling the whole button. z-index:0 keeps it behind the
   rocket (z-index:1, set in RocketIcon.vue). */
.warp-stage {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
}
</style>