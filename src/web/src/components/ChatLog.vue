<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount, computed } from 'vue';
import type { ChatMessage, ChatState } from '../types';
import { chatApi, isMessageVisible } from '../main';
import MessageItem from './MessageItem.vue';
import CardItem from './CardItem.vue';

const props = defineProps<{ messages: ChatMessage[]; state: ChatState }>();

const scrollContainer = ref<HTMLElement | null>(null);
const showScrollButton = ref(false);
let userScrolledUp = false;

// Warp-field element (the meteor starfield container). An animationiteration
// listener on it re-randomizes each meteor's birth position (CSS custom
// props --mx/--my) every loop, so streaks don't reuse the same start spot.
const warpFieldEl = ref<HTMLElement | null>(null);
function randomizeMeteors(): void {
  const field = warpFieldEl.value;
  if (!field) return;
  // The button interior the field fills (inset:0 of the button). Meteors
  // travel top-right → bottom-left, so births are seeded across the top and
  // right "incoming" edge band. --mx/--my are percentages of the field box.
  const meteors = field.querySelectorAll<HTMLElement>('.meteor');
  for (const m of meteors) {
    // Horizontal: bias toward the right/center two-thirds (incoming edge),
    // but allow some left births so streaks can cross the whole frame.
    const mx = 35 + Math.random() * 60;        // 35%..95%
    // Vertical: spread across the full height; bias slightly up.
    const my = Math.random() * 55;             // 0%..55%
    m.style.setProperty('--mx', `${mx}%`);
    m.style.setProperty('--my', `${my}%`);
  }
}
function onWarpIter(): void {
  randomizeMeteors();
}

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
watch(
  () => [props.state.isAutoMode, props.state.isRunning] as const,
  () => {
    if (!userScrolledUp) {
      nextTick(() => scrollToBottom());
    }
  },
);

onMounted(() => {
  scrollToBottom();
  // Seed meteor birth positions once, then re-randomize on every animation
  // loop via animationiteration (each meteor's meteor-flight animation fires
  // the event; the handler re-rolls --mx/--my for all of them so streaks
  // appear from fresh spots each pass). animationiteration only fires while
  // the starfield is actually animating (is-warping), so there's no cost in
  // WAIT.
  randomizeMeteors();
  const field = warpFieldEl.value;
  if (field) {
    field.addEventListener('animationiteration', onWarpIter);
  }
});

onBeforeUnmount(() => {
  const field = warpFieldEl.value;
  if (field) {
    field.removeEventListener('animationiteration', onWarpIter);
  }
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
        <!-- A small "warp jump" scene clipped inside the button, split into
             three visual layers so the effect is a clipped dynamic scene,
             not a button-surface texture:

               button (overflow:hidden, the clip frame)
               ├── .warp-field  ← meteor starfield (independent moving .meteor
               │                  elements, top-right → bottom-left, opposite
               │                  the rocket's bottom-left → top-right flight)
               ├── .rocket-stage ← the rocket SVG (slight bob when warping)
               └── exhaust       ← three rocket-flame streams (always firing;
                                  faster when warping)

             isRunning toggles the starfield (on) + speeds up the exhaust;
             it does NOT stop the exhaust. The rocket always fires. -->
        <span ref="warpFieldEl" class="warp-field" aria-hidden="true">
          <span class="meteor meteor-a"></span>
          <span class="meteor meteor-b"></span>
          <span class="meteor meteor-c"></span>
          <span class="meteor meteor-d"></span>
          <span class="meteor meteor-e"></span>
        </span>
        <svg class="interrupt-rocket rocket-stage" :class="{ 'rocket--active': state.isRunning }" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <!-- Whole scene rotated 45° for delivery. Drawn upright first:
               1) U-shaped body, 2) window, 3) two fins, 4) exhaust = hot
               outer plume + bright inner core + mach diamonds (shock rings)
               that propagate downward from the nozzle — a real jet/spray. -->
          <g class="rocket-frame" transform="rotate(45 12 12)">
            <!-- 1. U-shaped rocket body with a rounded top (open at the bottom) -->
            <path d="M8 14 V7 A4 4 0 0 1 16 7 V14 Z"/>
            <!-- 2. Round window in the center, sized to the larger body -->
            <circle cx="12" cy="9" r="1.8"/>
            <!-- 3. Two fins on the sides, attached at the wider body corners -->
            <path d="M8 14 L5 17 L8 17"/>
            <path d="M16 14 L19 17 L16 17"/>
            <!-- 4. Exhaust — drawn in the un-rotated frame (rotated as a whole
                 by the parent rocket-frame rotate(45 12 12)). A hot outer plume
                 + bright inner core + mach diamonds (shock rings) that
                 propagate downward from the nozzle, giving a real jet/spray
                 feel rather than伸缩线条. -->
            <g class="rocket-exhaust">
              <!-- Outer high-temperature plume -->
              <path
                class="exhaust-flame exhaust-flame--outer"
                d="M8.8 14
                   C9.0 16.0 9.4 18.2 12 21
                   C14.6 18.2 15.0 16.0 15.2 14
                   C14.3 15.0 13.5 15.5 12 15.5
                   C10.5 15.5 9.7 15.0 8.8 14Z"
              />
              <!-- Inner bright core -->
              <path
                class="exhaust-flame exhaust-flame--core"
                d="M10.2 14
                   C10.5 15.7 10.8 17.0 12 18.8
                   C13.2 17.0 13.5 15.7 13.8 14
                   C13.2 14.7 12.7 15.0 12 15
                   C11.3 15.0 10.8 14.7 10.2 14Z"
              />
              <!-- Mach diamonds / shock rings (diamonds read clearer than
                   circles at this 22x22 size; match the line-art rocket). -->
              <g class="mach-rings">
                <path
                  class="mach-ring mach-ring--1"
                  d="M10.0 16.2 L12 17.0 L14.0 16.2 L12 15.5 Z"
                />
                <path
                  class="mach-ring mach-ring--2"
                  d="M10.4 18.2 L12 19.0 L13.6 18.2 L12 17.4 Z"
                />
                <path
                  class="mach-ring mach-ring--3"
                  d="M10.8 20.0 L12 20.6 L13.2 20.0 L12 19.4 Z"
                />
              </g>
            </g>
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
/* AUTO variant — sky-blue button framing a small "warp jump" scene clipped
   inside it. The button itself is just the clip frame (overflow:hidden); the
   actual effect lives in two child layers:
     • .warp-field — a meteor starfield (independent .meteor elements moving
       top-right → bottom-left, opposite the rocket's flight direction)
     • .rocket-stage — the rocket SVG, with a slight bob when warping
   The exhaust streams (.rocket-flame) live inside the SVG and always fire;
   isRunning only speeds them up and reveals the starfield. The button never
   uses a background-image texture for the effect. */
.interrupt-btn--auto {
  background-color: #38bde8;
  position: relative;
  /* overflow:hidden turns the button into the clip frame for the warp-field
     and any rocket bob, so meteors/streaks never bleed outside the pill. */
  overflow: hidden;
  transition: background-color 0.4s ease;
}
.interrupt-btn--auto:hover:not(:disabled) {
  background-color: #0ea5e9;
}
.interrupt-btn--auto.is-warping {
  background-color: #1e8ab5;
}

/* ── Warp field: the clipped meteor starfield ── */
/* Absolutely fills the button interior; sits BEHIND the rocket. Meteors are
   children that move independently. opacity is driven by is-warping so the
   starfield only shows while the agent is actively processing. */
.warp-field {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  z-index: 0;
  opacity: 0;
  transition: opacity 0.25s ease;
}
.is-warping .warp-field {
  opacity: 1;
}

/* Each meteor is a short streak flying top-right → bottom-left (the rocket
   flies bottom-left → top-right, so the streaks rush past it in reverse).
   The streak's bright HEAD leads at the bottom-left (the travel direction)
   and the faint TAIL trails toward the top-right (behind). rotate(-45deg)
   sets the streak's SHAPE orientation; translate(-X, +Y) sets the actual
   MOTION direction. Different meteors get distinct starts, lengths, speeds,
   and delays so the field reads as a star array, not a moving texture. */
.meteor {
  position: absolute;
  display: block;
  width: 14px;
  height: 2.2px;
  border-radius: 1.2px;
  /* Head (bright) at the LEFT edge of the un-rotated bar → after rotate
     (-45deg) it sits at the bottom-left = the direction of travel (the
     meteor flies right-top → left-bottom). Tail (faint) at the RIGHT edge
     → top-right, pointing back where the meteor came from (trailing).
     rotate(-45deg) maps local-left → bottom-left, local-right → top-right. */
  background: linear-gradient(
    to right,
    rgba(255, 255, 255, 0.76),
    rgba(180, 230, 255, 0.12)
  );
  transform: translate(0, 0) rotate(-45deg);
  opacity: 0;
}
/* Five meteors spread across the button interior so the starfield fills the
   frame around the rocket rather than bunching on one side. Each enters near
   the top/right edge (the "incoming" edge for top-right→bottom-left travel)
   and exits toward the bottom-left. Starts are staggered across the width
   and height; lengths/speeds/delays differ so they never move in lockstep. */
/* Each meteor's BIRTH position is set via CSS custom props --mx (left) and
   --my (top), expressed as % of the warp-field box. A JS animationiteration
   listener (see script setup) re-rolls them every loop, so streaks appear
   from fresh spots each pass — true randomness, not a fixed pattern. The
   fixed per-meteor width/duration/delay still differ so they never move in
   lockstep. */
.meteor-a {
  left: var(--mx, 50%);
  top: var(--my, 10%);
  width: 16px;
  animation: meteor-flight 0.54s linear infinite;
  animation-delay: 0s;
}
.meteor-b {
  left: var(--mx, 60%);
  top: var(--my, 20%);
  width: 22px;
  animation: meteor-flight 0.72s linear infinite;
  animation-delay: 0.18s;
}
.meteor-c {
  left: var(--mx, 45%);
  top: var(--my, 5%);
  width: 13px;
  animation: meteor-flight 0.48s linear infinite;
  animation-delay: 0.36s;
}
.meteor-d {
  left: var(--mx, 70%);
  top: var(--my, 50%);
  width: 19px;
  animation: meteor-flight 0.84s linear infinite;
  animation-delay: 0.12s;
}
.meteor-e {
  left: var(--mx, 80%);
  top: var(--my, 35%);
  width: 24px;
  animation: meteor-flight 0.66s linear infinite;
  animation-delay: 0.48s;
  opacity: 0.44;
}
/* The motion: meteors start at a top-right offset (translate(45px, -45px))
   and travel to the bottom-left (translate(-45px, 45px)) — opposite the
   rocket's bottom-left→top-right flight. They fade in, hold, then fade out
   as they exit. */
@keyframes meteor-flight {
  from {
    transform: translate(45px, -45px) rotate(-45deg);
    opacity: 0;
  }

  15% {
    opacity: 1;
  }

  70% {
    opacity: 1;
  }

  to {
    transform: translate(-45px, 45px) rotate(-45deg);
    opacity: 0;
  }
}

/* ── Rocket SVG ── */
/* z-index lifts the rocket above the warp-field. A gentle bob when warping
   (small translateX + scale pulse) gives a light "jump" feel without large
   lateral motion — the speed sensation is carried by the meteors + exhaust,
   not by moving the rocket across the button. */
.interrupt-rocket {
  flex-shrink: 0;
  display: inline-block;
  position: relative;
  z-index: 1;
}
.rocket-stage {
  transition: transform 0.3s ease;
}

/* ── Rocket exhaust ── */
/* A hot outer plume + bright inner core + mach diamonds (shock rings) that
   propagate downward from the nozzle. The plume continuously disturbs
   (scaleY/scaleX breathing) and the mach rings travel outward + fade,
   giving a real jet/spray feel rather than伸缩线条. WAIT keeps a gentle
   idle thrust; is-warping (RUNNING) boosts opacity + speeds every part. */
.rocket-exhaust {
  transform-origin: 12px 14px;
  transform-box: view-box;
  /* WAIT: gentle idle thrust */
  opacity: 0.7;
}
/* RUNNING: high-energy propulsion */
.interrupt-btn--auto.is-warping .rocket-exhaust {
  opacity: 1;
}

/* Outer hot exhaust */
.exhaust-flame--outer {
  fill: currentColor;
  opacity: 0.38;
  transform-origin: 12px 14px;
  animation: exhaust-flame 0.72s ease-in-out infinite;
}
/* Bright inner core */
.exhaust-flame--core {
  fill: currentColor;
  opacity: 0.9;
  transform-origin: 12px 14px;
  animation: exhaust-core 0.48s ease-in-out infinite;
}

/* ── Mach diamonds / shock rings ── */
.mach-rings {
  transform-origin: 12px 14px;
}
.mach-ring {
  fill: none;
  stroke: currentColor;
  stroke-width: 0.65;
  stroke-linejoin: round;
  opacity: 0;
  transform-origin: 12px 14px;
}
.mach-ring--1 {
  stroke-width: 0.8;
  animation: mach-ring 0.72s linear infinite;
}
.mach-ring--2 {
  stroke-width: 0.6;
  animation: mach-ring 0.72s linear infinite;
  animation-delay: 0.18s;
}
.mach-ring--3 {
  stroke-width: 0.45;
  animation: mach-ring 0.72s linear infinite;
  animation-delay: 0.36s;
}

/* ── Flame motion ── */
@keyframes exhaust-flame {
  0% {
    transform: scaleY(0.65) scaleX(0.85);
    opacity: 0.28;
  }
  35% {
    transform: scaleY(1.05) scaleX(1);
    opacity: 0.42;
  }
  70% {
    transform: scaleY(1.25) scaleX(0.92);
    opacity: 0.34;
  }
  100% {
    transform: scaleY(0.7) scaleX(0.82);
    opacity: 0.24;
  }
}
@keyframes exhaust-core {
  0% {
    transform: scaleY(0.65);
    opacity: 0.65;
  }
  25% {
    transform: scaleY(1.1);
    opacity: 1;
  }
  55% {
    transform: scaleY(0.85);
    opacity: 0.82;
  }
  100% {
    transform: scaleY(0.6);
    opacity: 0.6;
  }
}

/* ── Shock diamond propagation ── */
@keyframes mach-ring {
  0% {
    transform: translateY(0) scale(0.55);
    opacity: 0;
  }
  15% {
    opacity: 0.65;
  }
  45% {
    transform: translateY(1.5px) scale(0.9);
    opacity: 0.4;
  }
  75% {
    transform: translateY(3px) scale(1.15);
    opacity: 0.15;
  }
  100% {
    transform: translateY(4.5px) scale(1.3);
    opacity: 0;
  }
}

/* ── RUNNING (is-warping): faster, higher-energy exhaust ── */
.interrupt-btn--auto.is-warping .exhaust-flame--outer {
  animation-duration: 0.48s;
}
.interrupt-btn--auto.is-warping .exhaust-flame--core {
  animation-duration: 0.32s;
}
.interrupt-btn--auto.is-warping .mach-ring--1 {
  animation-duration: 0.48s;
}
.interrupt-btn--auto.is-warping .mach-ring--2 {
  animation-duration: 0.48s;
}
.interrupt-btn--auto.is-warping .mach-ring--3 {
  animation-duration: 0.48s;
}
</style>