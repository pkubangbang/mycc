<script setup lang="ts">
import { ref, watch, nextTick, onMounted, computed } from 'vue';
import type { ChatMessage, ChatState } from '../types';
import { chatApi, isMessageVisible } from '../main';
import { messageKey } from '../message-key';
import MessageItem from './MessageItem.vue';
import CardItem from './CardItem.vue';
import SteeringReviewCard from './SteeringReviewCard.vue';
import RocketIcon from './RocketIcon.vue';
import MeteorField from './MeteorField.vue';

const props = defineProps<{ messages: ChatMessage[]; state: ChatState }>();

const scrollContainer = ref<HTMLElement | null>(null);
const showScrollButton = ref(false);
let userScrolledUp = false;

// ── Chatlog collapse + infinite scroll up ──
//
// To keep the first render cheap and the tail in view (especially on mobile,
// where a long history pushes the latest exchange below the fold and slows
// the initial paint), only the LAST `INITIAL_VISIBLE` messages render at
// first. Older messages are collapsed; the user scrolls UP to reveal more in
// batches (`SCROLL_BATCH`), capped at `MAX_VISIBLE` (a hard ceiling that
// matches the server's MAX_LOG_SIZE so the client never tries to render more
// than the server can send).
//
// `visibleCount` is a local ref (NOT in the Pinia store) because it is pure
// view state — it does not survive a refresh (the cache hydrates the log, and
// the collapse re-applies from INITIAL_VISIBLE), and it has no meaning to any
// other component. Keeping it local avoids store churn and keeps the feature
// fully self-contained in ChatLog.
const INITIAL_VISIBLE = 10;
const SCROLL_BATCH = 20;
const MAX_VISIBLE = 1000;
const visibleCount = ref(INITIAL_VISIBLE);

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
const filteredMessages = computed(() =>
  props.messages.filter(m => isMessageVisible(m, props.state.verboseLogs)),
);

// The collapse window: the LAST `visibleCount` of the filtered list. When
// the list is shorter than visibleCount, all of them show (no collapse
// affordance). `visibleCount` is clamped to MAX_VISIBLE so a huge log can
// never render more than the cap in one go.
const visibleMessages = computed(() => {
  const all = filteredMessages.value;
  const count = Math.min(visibleCount.value, MAX_VISIBLE, all.length);
  return all.slice(all.length - count);
});

// Whether older messages are collapsed (drives the "加载更多" affordance at
// the top). True only when there are filtered messages the window does NOT
// show.
const hasCollapsedAbove = computed(
  () => filteredMessages.value.length > visibleMessages.value.length,
);

// v-for key for each visible message: messageKey(msg, index). The helper is
// a PURE function extracted to ../message-key.ts so the strictly-unique-key
// invariant is unit-testable without importing a .vue SFC. The key shape is
// "<raw-timestamp> <label> #<index>" — the index is ALWAYS appended as a
// deterministic tiebreaker so two messages sharing the same ms + label
// (rare but possible) still get distinct keys. See message-key.ts.

function isAtBottom(): boolean {
  const el = scrollContainer.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 50;
}

// Near the TOP of the scroll container — used to trigger infinite-scroll-up
// loading. A small threshold (px) so the next batch loads just before the
// user hits the very top, avoiding a visible "blank then pop" gap.
const TOP_LOAD_THRESHOLD = 60;

function isNearTop(): boolean {
  const el = scrollContainer.value;
  if (!el) return false;
  return el.scrollTop <= TOP_LOAD_THRESHOLD;
}

/**
 * Reveal one more batch of collapsed messages (infinite scroll up). Clamped
 * to MAX_VISIBLE so the client never renders more than the cap. After the
 * window grows, the scroll position is adjusted so the user stays at roughly
 * the same visible spot (the newly prepended messages appear ABOVE the
// current viewport, not pushing the user down). No-op if nothing is collapsed.
 */
function loadMore(): void {
  if (!hasCollapsedAbove.value) return;
  const el = scrollContainer.value;
  // Capture the scroll geometry BEFORE the window grows so we can offset the
  // new scrollTop by the height added (the prepended messages).
  const prevHeight = el ? el.scrollHeight : 0;
  const prevTop = el ? el.scrollTop : 0;
  visibleCount.value = Math.min(visibleCount.value + SCROLL_BATCH, MAX_VISIBLE);
  // nextTick: wait for the DOM to reflect the larger window, then keep the
  // user at the same content position by adding the newly prepended height.
  nextTick(() => {
    if (!el) return;
    const added = el.scrollHeight - prevHeight;
    el.scrollTop = prevTop + added;
  });
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
  // Infinite scroll up: when the user scrolls near the top and older
  // messages are collapsed, reveal the next batch. This makes "scroll up
  // for more" work without an explicit button click, capped at MAX_VISIBLE.
  if (isNearTop() && hasCollapsedAbove.value) {
    loadMore();
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
// in state.pendingSteeringReview (populated by message-dispatch.ts at the
// 'prompt' message from notes the agent never consumed), SteeringReviewCard
// renders at the tail of the chat flow and emits the user's choice here.
//
// All three actions funnel into a single positive "boomerang" resolve: the
// client declares which note ids to SEND; every note NOT declared is
// implicitly discarded. The backend atomically drains the whole steering
// queue on 'steer-resolve', so no note is re-synthesized at the next PROMPT.
// Per-note "×" is a LOCAL unselect only (removes that id from the card);
// the authoritative send/discard happens when the user clicks 发送为查询 or
// 全部丢弃 (or when the last note is unselected → resolveSteering([])).
function onSendSteeringAsQuery(): void {
  const ids = props.state.pendingSteeringReview.map((n) => n.id);
  if (ids.length === 0) return;
  chatApi.resolveSteering(ids);
}

function onDiscardSteeringNote(id: number): void {
  // Local-only unselect: remove this note from the rendered card. If none
  // remain, immediately resolve with an empty selection (drain without send).
  const idx = props.state.pendingSteeringReview.findIndex((n) => n.id === id);
  if (idx >= 0) {
    props.state.pendingSteeringReview.splice(idx, 1);
  }
  if (props.state.pendingSteeringReview.length === 0) {
    chatApi.resolveSteering([]);
  }
}

function onDiscardAllSteering(): void {
  if (props.state.pendingSteeringReview.length === 0) return;
  chatApi.resolveSteering([]);
}

// Watch for new messages — auto-scroll only if user is already at bottom.
// Also grows the collapse window so the newly appended message is visible
// when the user is following the tail: if the window already shows the whole
// tail (visibleCount >= filtered length before the append), bump visibleCount
// so the new last message renders. If the user has scrolled up (collapsed
// history in view), do NOT grow — the new tail arriving should not yank the
// window and re-collapse what they revealed.
watch(
  () => visibleMessages.value.length,
  () => {
    if (!userScrolledUp) {
      nextTick(() => scrollToBottom());
    }
  },
);

// Keep the collapse window in sync with the filtered list size. When the
// filtered list GROWS by appends AND the user is at the bottom (following the
// tail), grow visibleCount so the new message shows instead of being hidden
// behind the collapse. When the list SHRINKS (a 200 replace on reconnect
// resets the store), or the filtered set changes identity (verbose toggle),
// reset to INITIAL_VISIBLE so the collapse re-applies from the tail.
watch(
  () => filteredMessages.value.length,
  (newLen, oldLen) => {
    if (oldLen === undefined) return; // initial — leave INITIAL_VISIBLE
    if (newLen > oldLen) {
      // Appends: grow the window only if the user is at the bottom (the
      // previous tail was fully in view). Otherwise leave the window — the
      // user is reading older history and a tail arrival must not re-collapse it.
      if (!userScrolledUp) {
        // Bump by the delta so the newly appended messages render instead of
        // being hidden behind the collapse. Clamped to MAX_VISIBLE.
        visibleCount.value = Math.min(visibleCount.value + (newLen - oldLen), MAX_VISIBLE);
      }
    } else if (newLen < oldLen) {
      // Shrink / replace: reset to the initial window so the collapse
      // re-applies from the new tail (e.g. after a reconnect 200).
      visibleCount.value = INITIAL_VISIBLE;
    }
    // newLen === oldLen: no size change (e.g. a content edit) — leave the window.
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
    <!-- Collapse affordance: when older messages are hidden behind the
         window, show a "加载更多" button at the top. Clicking reveals one
         batch (SCROLL_BATCH); scrolling to the top also triggers it via
         onScroll's isNearTop() check. The count tells the user how many
         collapsed messages remain above. -->
    <div v-if="hasCollapsedAbove" class="load-more-row">
      <button class="load-more-btn" @click="loadMore" title="向上滚动或点击加载更早的消息">
        加载更多…
      </button>
    </div>
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
             flames animate; when idle (AWAIT), the background fades out and
             the rocket sits still, signalling the lead is autonomously
             waiting and can be taken back over.
         Both stop a running task / exit auto mode (the interrupt triggers
         neglection, which the AWAIT/STOP handlers catch to clear auto and
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
                 when not warping, so AWAIT (idle auto) costs nothing.
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
/* Collapse affordance at the top of the chat log. Rendered only when older
   messages are hidden behind the collapse window (hasCollapsedAbove). The
   button also fires when the user scrolls to the top (onScroll's isNearTop
   path), so this is a secondary, explicit trigger. */
.load-more-row {
  display: flex;
  justify-content: center;
  padding: 4px 0 8px;
}
.load-more-btn {
  background: var(--bg-scroll-btn);
  border: 1px solid var(--border-scroll);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  padding: 4px 14px;
  border-radius: 12px;
  box-shadow: var(--scroll-shadow);
  transition: background 0.15s, transform 0.15s;
  backdrop-filter: blur(4px);
}
.load-more-btn:hover {
  background: var(--bg-scroll-btn-hover);
  transform: scale(1.04);
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