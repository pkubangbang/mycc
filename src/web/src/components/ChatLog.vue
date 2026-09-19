<script setup lang="ts">
import { ref, watch, nextTick, onMounted, computed } from 'vue';
import type { ChatMessage, ChatState } from '../types';
import { chatApi, isMessageVisible } from '../main';
import { messageKey } from '../message-key';
import {
  INITIAL_VISIBLE,
  SCROLL_BATCH,
  MAX_VISIBLE,
  loadMore as reduceLoadMore,
  returnToTail as reduceReturnToTail,
  leaveTail as reduceLeaveTail,
  applyObservation,
} from '../collapse-state';
import type { CollapseState, Observation } from '../collapse-state';
import MessageItem from './MessageItem.vue';
import CardItem from './CardItem.vue';
import SteeringReviewCard from './SteeringReviewCard.vue';
import RocketIcon from './RocketIcon.vue';
import MeteorField from './MeteorField.vue';

const props = defineProps<{ messages: ChatMessage[]; state: ChatState }>();

const scrollContainer = ref<HTMLElement | null>(null);
const showScrollButton = ref(false);
let userScrolledUp = false;

// ── Chatlog collapse + infinite scroll up (x / t / trackingTail scheme) ──
//
// To keep the first render cheap and the tail in view (especially on mobile,
// where a long history pushes the latest exchange below the fold and slows
// the initial paint), only a tail window of the filtered list renders at
// first. Older messages are collapsed; the user scrolls UP to reveal more.
//
// The window is governed by THREE pieces of local view state (NOT in the
// Pinia store — pure view state, does not survive a refresh, meaningless to
// other components):
//
//   x            — capacity. The steady-state size of the rendered window.
//                  Starts at INITIAL_VISIBLE. Grows when the user scrolls up
//                  to reveal older history (loadMore adds SCROLL_BATCH), and
//                  self-trims back toward INITIAL_VISIBLE as new messages
//                  arrive while the user is pinned to the tail (so a long
//                  idle-with-tail session does not render an ever-growing
//                  window). Floor: INITIAL_VISIBLE. Ceiling: MAX_VISIBLE.
//
//   t            — tail buffer. New messages that arrive WHILE the user is
//                  scrolled up (trackingTail = false) are buffered here
//                  instead of disturbing the viewed history. They are still
//                  RENDERED (the window is the last x+t), but they sit below
//                  the viewport, so the user does not see the list jump. When
//                  the user returns to the tail, t folds into x (x += t) and
//                  t clears — the window SIZE is unchanged across the fold
//                  (no visual jump), and the buffered tail is now in view.
//
//   trackingTail — whether the user is pinned to the live tail. True after
//                  mount / scroll-to-bottom / scrolling to the bottom; false
//                  once the user scrolls up. It decides whether a new message
//                  is buffered (t += 1) or folded-and-trimmed (x trims by 1).
//
// INVARIANT: the rendered window is ALWAYS the last (x + t) filtered
// messages — all.slice(len - (x + t)). x and t together define the window
// size; t is never a hidden offset, it is rendered tail overflow.
//
// Worked example (INITIAL_VISIBLE=10, SCROLL_BATCH=20):
//   start            x=10  t=0  tracking=false  → window = last 10
//   scroll up        x=30  t=0  tracking=false  → window = last 30 (more old)
//   new msg (away)   x=30  t=1  tracking=false  → window = last 31 (new msg
//                                                   rendered, below viewport —
//                                                   viewed history stable)
//   return to tail   x=31  t=0  tracking=true   → window = last 31 (SIZE
//                                                   unchanged; buffered tail
//                                                   now in view)
//   new msg (track)  x=30  t=0  tracking=true   → window = last 30 (new msg
//                                                   at bottom, oldest drops
//                                                   off top — "trades 2 old
//                                                   for 1 new" until x bottoms
//                                                   out at INITIAL_VISIBLE)
//
// MAX_VISIBLE is a hard ceiling on (x + t) mirroring the server's
// MAX_LOG_SIZE (1000) so the client never renders more than the server can
// send.
//
// The transition LOGIC (loadMore / returnToTail / leaveTail / onAppend /
// onShrink) lives in the PURE module ../collapse-state.ts so it is directly
// unit-testable in node (see collapse-state.test.ts). ChatLog only holds the
// reactive refs and applies the reducer results + the DOM/scroll
// side-effects the pure module can't do.
const capacity = ref(INITIAL_VISIBLE); // x
const tailBuffer = ref(0);             // t
const trackingTail = ref(true);        // pinned to the live tail?

// Read the current collapse state as a plain object (for the pure reducer).
function collapseState(): CollapseState {
  return {
    capacity: capacity.value,
    tailBuffer: tailBuffer.value,
    trackingTail: trackingTail.value,
  };
}
// Apply a reducer result back onto the reactive refs.
function applyCollapseState(s: CollapseState): void {
  capacity.value = s.capacity;
  tailBuffer.value = s.tailBuffer;
  trackingTail.value = s.trackingTail;
}

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

// The collapse window: the LAST (capacity + tailBuffer) of the filtered
// list — see the INVARIANT above. Clamped to MAX_VISIBLE and to the list
// length (when the list is shorter than the window, all show — no collapse).
const visibleMessages = computed(() => {
  const all = filteredMessages.value;
  const count = Math.min(capacity.value + tailBuffer.value, MAX_VISIBLE, all.length);
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
 * Reveal one more batch of collapsed messages (infinite scroll up). Delegates
 * the capacity/tracking transition to the pure reducer; keeps the DOM
 * side-effect (scroll-anchoring) here. Scrolling up means the user is no
 * longer tracking the tail (the reducer flips trackingTail false). After the
 * window grows, the scroll position is adjusted so the user stays at roughly
 * the same visible spot (the newly prepended messages appear ABOVE the
 * current viewport, not pushing the user down). No-op if nothing is collapsed.
 *
 * SCROLL ANCHORING (#23): the anchor is the FIRST VISIBLE MESSAGE ELEMENT,
 * not total scrollHeight. The prior scrollHeight-delta approach
 * (scrollTop = prevTop + (scrollHeight - prevHeight)) was racy: a message
 * arriving while the nextTick is pending (buffered into tailBuffer since
 * loadMore sets trackingTail=false) grows scrollHeight, so the delta
 * included the new tail message's height and pushed the user DOWN —
 * violating the x/t goal that arrivals while reading older history do not
 * disturb the viewed position. Anchoring on a DOM message element (located
 * by its data-msg-key) makes the operation insensitive to concurrent
 * additions at the bottom AND to variable message heights: we record the
 * first visible message's viewport offset before the window grows, then
 * after the DOM update restore that same message to the same offset.
 */
function loadMore(): void {
  if (!hasCollapsedAbove.value) return;
  const el = scrollContainer.value;
  // The first visible message BEFORE the window grows — this is the anchor
  // we will restore to its current viewport offset after prepending older
  // messages above it. visibleMessages[0] is the oldest rendered message;
  // its data-msg-key lets us relocate it in the DOM after the re-render.
  const anchorMsg = visibleMessages.value[0];
  const anchorKey = anchorMsg ? messageKey(anchorMsg, 0) : null;
  // Capture the anchor element's offset from the top of the scroll
  // container's viewport (its rect top minus the container's rect top).
  // This is the position we want to preserve for this message after older
  // messages are prepended above it.
  let anchorOffsetFromTop = 0;
  let anchorEl: Element | null = null;
  if (el && anchorKey !== null) {
    anchorEl = el.querySelector(`[data-msg-key="${CSS.escape(anchorKey)}"]`);
    if (anchorEl) {
      const elRect = el.getBoundingClientRect();
      const anchorRect = anchorEl.getBoundingClientRect();
      anchorOffsetFromTop = anchorRect.top - elRect.top;
    }
  }
  applyCollapseState(reduceLoadMore(collapseState(), filteredMessages.value.length));
  // nextTick: wait for the DOM to reflect the larger window (older messages
  // prepended above the anchor), then restore the anchor message to its
  // prior viewport offset. The prepended messages push the anchor down by
  // their total height; we compensate by increasing scrollTop by that same
  // amount so the anchor stays at anchorOffsetFromTop. Because we anchor on
  // a specific element (not scrollHeight), a concurrent tail-buffer addition
  // below the anchor does NOT affect this offset (#23).
  nextTick(() => {
    if (!el || anchorKey === null) return;
    const anchorAfter = el.querySelector(`[data-msg-key="${CSS.escape(anchorKey)}"]`);
    if (!anchorAfter) return;
    const elRect = el.getBoundingClientRect();
    const anchorRectAfter = anchorAfter.getBoundingClientRect();
    const offsetAfter = anchorRectAfter.top - elRect.top;
    // Shift scrollTop so the anchor returns to its captured offset. If the
    // anchor is now further down (offsetAfter > anchorOffsetFromTop, the
    // normal prepend case), increase scrollTop by the difference; if it
    // ended up higher (shouldn't happen on a pure prepend, but guards
    // against measurement jitter), decrease. This is exact, not heuristic.
    el.scrollTop += offsetAfter - anchorOffsetFromTop;
  });
}

function scrollToBottom(): void {
  const el = scrollContainer.value;
  if (el) {
    el.scrollTop = el.scrollHeight;
  }
  userScrolledUp = false;
  showScrollButton.value = false;
  // Re-tracking the tail: fold the tail buffer into capacity and clear it
  // (size-preserving across the fold — no visual jump). The pure reducer
  // computes the new x; the DOM scroll happens above.
  applyCollapseState(reduceReturnToTail(collapseState()));
}

function onScroll(): void {
  if (isAtBottom()) {
    showScrollButton.value = false;
    userScrolledUp = false;
    // Scrolled to the bottom → re-tracking the tail (x += t, t = 0).
    applyCollapseState(reduceReturnToTail(collapseState()));
  } else {
    userScrolledUp = true;
    showScrollButton.value = true;
    // Scrolled away from the bottom → no longer tracking the tail; new
    // arrivals will buffer into t instead of disturbing the viewed history.
    applyCollapseState(reduceLeaveTail(collapseState()));
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

// Keep the collapse window in sync with the filtered list. This is the core
// of the x / t / trackingTail scheme: it reacts to filtered-list GROWTH
// (new messages arriving), SHRINKAGE (a 200 replace on reconnect resets the
// store), and FILTER CHANGES (toggling 详细日志 changes which messages
// isMessageVisible() admits). The transition LOGIC is in the pure reducer
// (../collapse-state.ts); this watcher only applies the result + the DOM
// scroll side-effect.
//
// SINGLE-WATCHER + PURE-TRANSITION DESIGN (#15 / #16 / #19 / #20 / #21):
// the watcher is a THIN CALLER over the pure `applyObservation` transition
// in collapse-state.ts. It uses Vue's (newValue, oldValue) callback
// signature — Vue evaluates the watched source at setup time and supplies
// the previous tuple on every change, so:
//   - the append `delta` is nextLen - prevLen with the REAL prev value
//     (round-8 #19: the prior manual ref was advanced before delta was
//     computed, making every append delta=0 → onAppend no-op'd);
//   - the FIRST real change gets a real prev observation, NOT undefined
//     (round-8 #20: the prior manual refs started undefined + the lazy
//     watcher meant the first change classified as 'none' and was dropped).
// There are NO manual prev refs to advance — Vue owns the previous value —
// so neither bug can recur. The whole state transition (classify → dispatch
// to onAppend/onShrink/onFilterChange → shouldScrollToTail signal, including
// the wasTrackingTail-before-reset capture for #16) lives in the pure
// `applyObservation` function and is unit-tested directly
// (collapse-state.test.ts), which is what lets this class of bug be caught
// in tests instead of only at runtime.
//
// RE-SCROLL CORRECTNESS (#9): applyObservation's 'append' branch returns
// shouldScrollToTail=true whenever trackingTail is true and messages
// arrived — EVEN when the rendered length stayed constant (the floor-swap
// case: x=10, one old leaves + one new enters → length unchanged, but the
// new tail message must still be scrolled into view).
//
// HISTORY-REVISION SIGNAL (#22): the watched tuple ALSO includes
// props.state.historyRevision, a monotonic counter bumped on every
// authoritative /history replacement (a 200 that splices the chat arrays)
// and on a session-change clear. A replacement can leave the filtered
// length UNCHANGED (e.g. the server's 1000-entry cap: old entries leave +
// new entries enter → count stays 1000), so the length/verbose classifier
// would call it 'none' and keep a now-invalid window position. The revision
// change makes the replacement boundary explicit: when prevRevision !==
// nextRevision, applyObservation short-circuits to onHistoryReplace()
// (reset + re-scroll to the new tail) regardless of the classifyChange
// result. This separates "the list was replaced" from "the list grew /
// shrank / was filtered" — cardinality alone cannot carry both meanings.
watch(
  () => [props.state.verboseLogs, filteredMessages.value.length, props.state.historyRevision] as const,
  ([nextVerbose, nextFilteredLen, nextRevision], prev) => {
    // prev is the tuple Vue captured at setup / the last change. On the very
    // first change it is the setup-time value (NOT undefined), so the first
    // real append/filter transition is processed (round-8 #20).
    const prevObs: Observation | undefined =
      prev === undefined
        ? undefined
        : { verbose: prev[0], filteredLength: prev[1] };
    const nextObs: Observation = { verbose: nextVerbose, filteredLength: nextFilteredLen };
    // #22: a history-revision change means the store was authoritatively
    // replaced (a /history 200 or session-clear splice). This is independent
    // of length/verbose — pass it to applyObservation as the replacement
    // signal. prev may be undefined on the true first run; in that case the
    // revision is treated as unchanged (the initial load's 0→1 bump is
    // observed as a real prev→next pair once the watcher has fired once,
    // which is correct: the first 200 IS an authoritative replacement).
    const prevRevision = prev?.[2];
    const historyReplaced = prevRevision !== undefined && prevRevision !== nextRevision;
    const { state, shouldScrollToTail } = applyObservation(prevObs, nextObs, collapseState(), historyReplaced);
    applyCollapseState(state);
    if (shouldScrollToTail) {
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
    if (trackingTail.value) {
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
    <div
      v-for="(msg, index) in visibleMessages"
      :key="messageKey(msg, index)"
      :data-msg-key="messageKey(msg, index)"
      class="chat-msg-row"
    >
      <CardItem v-if="msg.type === 'card' && msg.card" :card="msg.card" />
      <MessageItem v-else :message="msg" :on-quote="onQuote" />
    </div>
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
/* Wrapper around each visible message row (v-for). `display:contents` makes
   the wrapper generate NO box, so MessageItem's `.message-row` (display:flex)
   and CardItem's root render exactly as they did under the bare <template>
   v-for — no extra block, no margin collapse change, no layout shift. The
   wrapper exists ONLY to carry `data-msg-key` so loadMore() can locate a
   specific message element by key for scroll anchoring (#23). The attribute
   survives display:contents (it's a DOM attribute, not a layout property),
   and the wrapper's firstElementChild (the real .message-row) provides the
   geometry getBoundingClientRect needs. */
.chat-msg-row {
  display: contents;
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