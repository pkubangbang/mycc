<script setup lang="ts">
/**
 * ChatInput.vue — the composer SHELL.
 *
 * Owns only what spans several regions or talks to the backend:
 *   • the text ↔ state.inputText mirror (two watchers, no emit loop)
 *   • the send gate (canSend / warning text) and send() routing (query vs steer)
 *   • the send→running latch (15 s expiry for the `submitted` phase)
 *   • the drag-and-drop bindings — the WHOLE composer is the drop target, so
 *     they cannot move into a child
 *   • the hidden <input type=file> behind the 附加文件 button
 *   • the manual top-edge height handle: it writes ONE inherited custom
 *     property (`--composer-raw-h`) on its root element, which carries the
 *     `.composer-box` grid; that grid reconciles everything inside to the
 *     resulting height (ComposerBox's root is `display: contents`)
 *
 * Everything visual lives in `components/chat-input/`:
 *   ComposerBox (textarea + floating strip + 发送), AttachmentBar (one line),
 *   AttachmentManager (the popup), InputNoticeBar (warning / upload error).
 * Upload mechanics live in `composables/useAttachmentQueue.ts`.
 *
 * Capability-props invariant: no child receives `state: ChatState`; each takes
 * only the derived values it renders.
 */
import { ref, watch, computed } from 'vue';
import type { ChatState } from '../types';
import { chatApi } from '../main';
import { useAttachmentQueue } from '../composables/useAttachmentQueue';
import ComposerBox from './chat-input/ComposerBox.vue';
import AttachmentBar from './chat-input/AttachmentBar.vue';
import AttachmentManager from './chat-input/AttachmentManager.vue';
import InputNoticeBar from './chat-input/InputNoticeBar.vue';

const props = defineProps<{ state: ChatState }>();

const text = ref(props.state.inputText);
const fileInput = ref<HTMLInputElement | null>(null);
const dragOver = ref(false);
let dragCounter = 0;
/** Whether the attachment-manager popup is open. */
const managerOpen = ref(false);

// ── Attachment queue (+ per-file upload size cap) ──
//
// All upload concerns live in one composable: read → size guard → base64 →
// pendingFiles, plus the two error banners (超限 / 文件夹拒绝). `files` is the
// single local mirror of `state.pendingFiles`, so send()/canSend can read it
// synchronously. The cap (state.maxUploadMb) is passed as a live getter.
const { files, uploadError, addFiles, onPaste, removeFile, clearFiles } =
  useAttachmentQueue({
    getMaxMb: () => props.state.maxUploadMb,
    getPending: () => props.state.pendingFiles,
    setPending: (next) => { props.state.pendingFiles = next; },
  });

// Mirror state.inputText ↔ the textarea (two watchers, so an external reset
// of state.inputText reaches the DOM and typing flows the other way).
watch(
  () => props.state.inputText,
  (val) => {
    if (val !== text.value) text.value = val;
  },
);

watch(text, (val) => {
  props.state.inputText = val;
});

// ── Toolbar actions ──

// Lightning-bolt "enter auto mode" button. One-way: clicking enters auto
// mode; if already in auto mode, surface a transient "已经是自动模式了"
// toast locally instead of sending. The toast auto-clears after 2.5s.
const autoToast = ref('');
let autoToastTimer: ReturnType<typeof setTimeout> | null = null;
function onAutoClick(): void {
  if (props.state.isAutoMode) {
    autoToast.value = '已经是自动模式了';
    if (autoToastTimer) clearTimeout(autoToastTimer);
    autoToastTimer = setTimeout(() => { autoToast.value = ''; }, 2500);
    return;
  }
  chatApi.sendAuto();
}

// "压缩上下文" (compact context) — sends the "/compact" slash command through
// the normal input path (chatApi.sendInput), reusing the whole existing
// slash-command pipeline (no new WS type, no backend change). Enabled only
// when ALL hold: not in auto mode; at PROMPT (isWaiting); no pending card;
// connected.
const canCompact = computed(() =>
  !props.state.isAutoMode &&
  props.state.isWaiting &&
  !props.state.hasPendingCard &&
  props.state.connectionStatus === 'connected',
);

function onCompactClick(): void {
  if (!canCompact.value) return;
  chatApi.sendInput('/compact');
}

// ── Send gate + warning banner (single source of truth) ──
//
// The textarea is NEVER disabled — not on disconnect, not on a pending card,
// not on the steering-review card. Instead a warning banner tells the user
// when the typed text will not be submitted, and the 发送 button's :disabled
// mirrors the actual send behaviour exactly: enabled ⇒ send() submits,
// disabled ⇒ send() is a no-op. So send() needs no redundant guards.
//
// showSteeringReview: a transient "继续…" card (rendered in ChatLog) is
// pending user action at PROMPT. While it shows, sending is blocked — the
// user must first send those notes as a query or discard them. Treated as a
// card interruption, the same category as hasPendingCard.
const showSteeringReview = computed(() =>
  props.state.isWaiting && props.state.pendingSteeringReview.length > 0,
);

const canSend = computed(() =>
  !props.state.hasPendingCard &&
  !showSteeringReview.value &&
  (text.value.trim() !== '' || files.value.length > 0) &&
  props.state.connectionStatus === 'connected',
);

const showInputWarning = computed(() =>
  props.state.hasPendingCard ||
  showSteeringReview.value ||
  props.state.connectionStatus !== 'connected',
);

const inputWarningText = computed(() => {
  if (props.state.hasPendingCard) return '请在上方卡片上回复，当前输入不会被提交';
  if (showSteeringReview.value) return '请先处理上方转向消息卡片，当前输入不会被提交';
  if (props.state.connectionStatus !== 'connected') return '网络未连接，当前输入不会被提交';
  return '';
});

/** Placeholder, resolved from the four states the composer can be in. */
const placeholder = computed(() => {
  if (props.state.hasPendingCard) return '请在卡片上回复…';
  if (props.state.isWaiting) return '输入消息…';
  if (props.state.isAutoMode) return '给自动模式发指引…';
  return '等待回复中…';
});

function send(): void {
  // canSend is the single source of truth — the button mirrors it, and the
  // Enter key path calls this same function.
  if (!canSend.value) return;
  const value = text.value;
  const payload = files.value.length > 0 ? [...files.value] : undefined;
  // Tag the content with the actual loop stage: a PROMPT wait (isWaiting) →
  // a fresh query (type:'input'); every other state (working, auto, the
  // transient send→running gap) → a steering note (type:'steer'), buffered in
  // the backend and drained at the next COLLECT or surfaced for review at the
  // next PROMPT.
  if (props.state.isWaiting) {
    chatApi.sendInput(value, payload);
    // Arm the send→running latch (see latchSubmitted below).
    latchSubmitted();
  } else {
    chatApi.sendSteer(value, payload);
  }
  text.value = '';
  clearFiles();
}

// ── ComposerBox events ──

/** 附加文件: open the hidden picker (the input element lives in this shell). */
function openFilePicker(): void {
  fileInput.value?.click();
}

/** Hidden <input type=file> change handler: queue the picked files, then
 *  reset the input so re-picking the same file fires change again. */
function onFilesPicked(event: Event): void {
  const input = event.target as HTMLInputElement;
  const rawFiles = input.files;
  if (rawFiles && rawFiles.length > 0) addFiles(rawFiles);
  input.value = '';
}

// Clipboard paste: hand FILE items to the attachment queue (text pastes stay
// native — no preventDefault). The queue synthesises a filename for clipboard
// image blobs, which carry no original name.
function onPasteFiles(event: ClipboardEvent): void {
  if (onPaste(event)) event.preventDefault();
}

// ── Drag-and-drop on the whole composer ──
//
// The root is the drop target, so these bindings stay in the shell. A drop's
// default action would otherwise navigate the page to the file. Any file type
// is accepted; size and folder rejections happen inside the queue.
function onDragEnter(event: DragEvent): void {
  event.preventDefault();
  dragCounter++;
  dragOver.value = true;
}

function onDragOver(event: DragEvent): void {
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy';
  }
}

function onDragLeave(event: DragEvent): void {
  event.preventDefault();
  dragCounter--;
  if (dragCounter === 0) {
    dragOver.value = false;
  }
}

function onDrop(event: DragEvent): void {
  event.preventDefault();
  dragCounter = 0;
  dragOver.value = false;
  const rawFiles = event.dataTransfer?.files;
  if (!rawFiles || rawFiles.length === 0) return;
  addFiles(rawFiles);
}

// ── Pending-file manager popup ──
function openManager(): void {
  managerOpen.value = true;
}
function closeManager(): void {
  managerOpen.value = false;
}
function removeAllFiles(): void {
  clearFiles();
  managerOpen.value = false;
}

// ── Manual input-box height (top-edge drag handle) ──
//
// The root element is the height authority: it carries the `.composer-box`
// grid and its height is ONE unclamped custom property, `--composer-raw-h`,
// written inline here. CSS owns the clamp (min-height / max-height) and the
// grid row makes the inner structure reconcile — so this handler never
// computes a final height, never clamps, and never touches the textarea.
//
// The handle is the root's first child, so the box is
// `handle.parentElement`. (A template `ref` on <ComposerBox> would yield the
// child's component instance, on which `.style` does not exist — the reason
// the handle reached nothing after the split.)
//
// The anchor is taken from the BOX's own rect at drag start (one snapshot),
// not from a nested element: measuring the textarea (as an earlier version
// did) mixed container chrome into the value and made the box jump on the
// first pointermove.
let inputDragging = false;
let dragMoved = false;
let dragStartY = 0;
let dragStartHeight = 0;
/** Pixels of vertical travel before the drag engages (a plain click on the
 *  handle must not resize the box). */
const DRAG_THRESHOLD = 3;

/** The .composer-box root that owns the height contract. */
function boxOf(el: Element | null): HTMLElement | null {
  return el?.closest<HTMLElement>('.composer-box') ?? null;
}

function onInputHandleDown(e: PointerEvent): void {
  const box = boxOf(e.currentTarget as Element);
  if (!box) return;
  inputDragging = true;
  dragMoved = false;
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
  e.preventDefault();
  dragStartY = e.clientY;
  // Anchor on the box's CURRENT height. It is a snapshot taken once, so the
  // handle's own offset (and any layout settle on the first move) can never be
  // folded into the delta — the cause of the old first-move jump.
  dragStartHeight = box.getBoundingClientRect().height;
}
function onInputHandleMove(e: PointerEvent): void {
  if (!inputDragging) return;
  const box = boxOf(e.currentTarget as Element);
  if (!box) return;
  const dy = dragStartY - e.clientY;
  // Swallow the first couple of pixels: without this, pressing the handle and
  // twitching the pointer resizes the box by a jump of one or two rows.
  if (!dragMoved) {
    if (Math.abs(dy) < DRAG_THRESHOLD) return;
    dragMoved = true;
  }
  // The handle is at the TOP edge: dragging up (clientY shrinks) grows the
  // box. Write the UNCLAMPED target; CSS min/max-height does the rest, so the
  // drag stays anchored even when it overshoots a bound.
  box.style.setProperty(
    '--composer-raw-h',
    `${dragStartHeight + dy}px`,
  );
}
function onInputHandleUp(e: PointerEvent): void {
  inputDragging = false;
  dragMoved = false;
  try {
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  } catch {
    /* already released */
  }
}

// ── State-machine stage tag row (diagnostic) ──

// Labels use the unified uppercase vocabulary PROMPT / RUNNING / AWAIT /
// PARSING / QCARD / IDLE / OFFLINE. Each maps 1:1 onto a phase, so routing
// semantics are unchanged:
//   1. OFFLINE  — no connection; nothing is sent anyway.
//   2. QCARD    — card phase; routing is blocked by the card gate.
//   3. PROMPT   — isWaiting, no card → sendInput (query).
//   4. RUNNING  — working → sendSteer (COLLECT drains as REMINDER).
//   5. AWAIT    — auto-mode idle → sendSteer (await.ts polls the queue).
//   6. PARSING  — the send→running gap (`submitted`): a query was just
//                 submitted and the backend is still inside the PROMPT
//                 handler doing post-input LLM work; messages sent here go to
//                 the steer buffer and ARE consumed at the imminent COLLECT.
//   7. IDLE     — the phase-enum vacuum: send() would route to sendSteer with
//                 no consumer scheduled (the 停止-button vacuum). Amber.
const stage = computed(() => {
  if (props.state.connectionStatus !== 'connected') return 'OFFLINE';
  const phase = props.state.phase;
  if (phase === 'card') return 'QCARD';
  if (phase === 'prompt') return 'PROMPT';
  if (phase === 'working') return 'RUNNING';
  if (phase === 'await') return 'AWAIT';
  if (phase === 'submitted') return 'PARSING';
  return 'IDLE';
});
// The IDLE vacuum is the smoking-gun state — flag it so it renders amber.
const isVacuumStage = computed(() => stage.value === 'IDLE');

// ── Send→running latch ──
//
// The `submitted` phase is set optimistically by chatApi.sendInput. This latch
// is its 15 s expiry safety net: if the backend is genuinely desynced (e.g.
// the input was silently dropped by a stale-client race), `submitted` MUST
// expire back to `idle` so the genuine vacuum stage re-surfaces. The watcher
// clears the timer the moment any server message moves the phase away.
const justSubmitted = ref(false);
let submitLatchTimer: ReturnType<typeof setTimeout> | null = null;
function latchSubmitted(): void {
  justSubmitted.value = true;
  if (submitLatchTimer) clearTimeout(submitLatchTimer);
  submitLatchTimer = setTimeout(() => {
    justSubmitted.value = false;
    // Only fall back if we're STILL in `submitted` — a server message may have
    // already transitioned us (the watcher normally clears the timer first).
    if (props.state.phase === 'submitted') {
      chatApi.expireSubmitted();
    }
  }, 15000);
}
function clearSubmitLatch(): void {
  justSubmitted.value = false;
  if (submitLatchTimer) { clearTimeout(submitLatchTimer); submitLatchTimer = null; }
}
watch(
  () => [props.state.phase, props.state.connectionStatus] as const,
  ([newPhase, conn]) => {
    if (justSubmitted.value && (newPhase !== 'submitted' || conn !== 'connected')) {
      clearSubmitLatch();
    }
  },
);

// ── Last-server-message timestamp (tag row) ──
function fmtTime(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
</script>

<template>
  <div
    :class="['chat-input', { 'drag-over': dragOver }]"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- State-machine stage tag row (diagnostic) — visible ONLY in
         detailed-logs (详细日志) mode. -->
    <div
      v-if="state.verboseLogs"
      class="stage-row"
      :class="{ 'stage-row--vacuum': isVacuumStage }"
    >
      <span
        class="stage-chip stage-chip--phase"
        :class="{ 'stage-chip--warn': isVacuumStage }"
      >{{ stage }}</span>
      <span class="stage-chip stage-chip--steer">steerBuffer={{ state.steeringBuffer.length }}</span>
      <span class="stage-chip stage-chip--review">review={{ state.pendingSteeringReview.length }}</span>
      <span
        v-if="state.lastServerMsg"
        class="stage-chip stage-chip--msg"
      >最后消息: {{ state.lastServerMsg.type }} @{{ fmtTime(state.lastServerMsg.at) }}</span>
    </div>

    <!-- textarea + floating action strip + 发送. ComposerBox owns the grid and
         the height clamp; the drag handle is passed into its root via the
         `handle` slot, so the handler reaches the box with
         `currentTarget.closest('.composer-box')` — no template `ref` (on a
         child component that yields the component instance, not an Element). -->
    <ComposerBox
      :text="text"
      :placeholder="placeholder"
      :can-send="canSend"
      :can-compact="canCompact"
      :is-auto-mode="state.isAutoMode"
      :connected="state.connectionStatus === 'connected'"
      @update:text="(v: string) => (text = v)"
      @send="send"
      @compact="onCompactClick"
      @auto="onAutoClick"
      @attach="openFilePicker"
      @paste-files="onPasteFiles"
    >
      <template #handle>
        <div
          class="input-resize-handle"
          @pointerdown="onInputHandleDown"
          @pointermove="onInputHandleMove"
          @pointerup="onInputHandleUp"
          @pointercancel="onInputHandleUp"
          title="拖拽调整输入框高度"
        ></div>
      </template>
    </ComposerBox>
    <!-- Transient "already in auto mode" toast, floating just above the box. -->
    <transition name="auto-toast">
      <div v-if="autoToast" class="auto-toast">{{ autoToast }}</div>
    </transition>

    <!-- Hidden picker for 附加文件 (the shell owns it; the button emits). -->
    <input
      ref="fileInput"
      type="file"
      multiple
      class="file-input-hidden"
      @change="onFilesPicked"
    />

    <InputNoticeBar
      :warning="showInputWarning ? inputWarningText : null"
      :error="uploadError || null"
    />
    <AttachmentBar
      :files="files"
      @manage="openManager"
      @remove="removeFile"
    />
    <!-- Teleported to <body> by ModalShell; sits here only for prop wiring. -->
    <AttachmentManager
      :open="managerOpen"
      :files="files"
      @close="closeManager"
      @remove="removeFile"
      @remove-all="removeAllFiles"
    />
  </div>
</template>

<style scoped>
/* The shell root IS the composer box: it carries the drag target, the drop
   target, and the height contract. */
.chat-input {
  display: flex;
  flex-direction: column;
  /* NO horizontal padding (full-bleed, so the drag handle spans the whole
     width) — each visual child owns its own x-margin via --composer-gutter.
     The BOTTOM inset belongs to the shell alone: whatever the last child is
     (textarea, notice, or attachment bar) it sets no bottom margin, so the
     visual bottom margin stays exactly ~5px and never stacks. */
  padding: 0 0 5px;
  background: var(--bg-input);
  border-top: 1px solid var(--border-color);
  flex-shrink: 0;
  transition: background 0.15s;
  position: relative;
}
.chat-input.drag-over {
  background: color-mix(in srgb, var(--accent) 8%, var(--bg-input));
}
/* ── The height contract variables ──
   They live on this root and INHERIT into ComposerBox, whose `.composer-box`
   root is the grid + clamp owner. --composer-raw-h is written INLINE by the
   drag handle and must never be declared in any rule: a local declaration wins
   over the inline value and turns every drag into a no-op. */
.chat-input {
  --composer-gutter: 8px;
  --composer-min-h: 40px;
  --composer-max-h: 320px;
  --toolbar-w: 98px;
  --toolbar-inset: 2px;
}

/* ── State-machine stage tag row (diagnostic, detailed-logs only) ──
   A full-width chip strip above the composer. Amber accent when the stage is
   the IDLE vacuum state (the smoking-gun for the isWaiting desync). */
.stage-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 2px;
  border-radius: 6px;
  font-size: 11px;
  line-height: 1.4;
  user-select: text;
}
.stage-row--vacuum {
  background: color-mix(in srgb, #f59e0b 10%, transparent);
  border: 1px solid color-mix(in srgb, #f59e0b 35%, transparent);
}
.stage-chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--bg-input-field);
  color: var(--text-muted);
  border: 1px solid var(--border-color);
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}
/* Fixed-width value chips: anti-jitter. min-width (NOT width) + a ch budget
   that INCLUDES the 18px border-box chrome (2×8px padding + 2×1px border):
   the widest realistic value (steerBuffer=99=14ch, review=99=9ch) fills the
   pill exactly; narrower values stay centered.
   min-width over width: an underestimated budget makes the chip grow ~1ch
   (harmless reflow) instead of spilling glyphs past the pill. Keep the 18px
   in sync with .stage-chip's horizontal padding (2×8px) + border (2×1px). */
.stage-chip--steer {
  min-width: calc(14ch + 18px);
  justify-content: center;
}
.stage-chip--review {
  min-width: calc(9ch + 18px);
  justify-content: center;
}
/* The FIRST (stage/phase) chip carries the unified uppercase vocabulary
   PROMPT / RUNNING / AWAIT / PARSING / QCARD / IDLE / OFFLINE — the widest
   label is 7ch. Same recipe as above: min-width = 7ch content budget + 18px
   border-box chrome, so the pill's width is CONSTANT across label flips (no
   reflow as the phase changes) while always containing its text. */
.stage-chip--phase {
  min-width: calc(7ch + 18px);
  justify-content: center;
}
.stage-chip--warn {
  background: color-mix(in srgb, #f59e0b 18%, var(--bg-input-field));
  color: #f59e0b;
  border-color: color-mix(in srgb, #f59e0b 50%, transparent);
  font-weight: 600;
}
.stage-chip--msg {
  color: var(--text-primary);
  border-style: dashed;
}
/* Horizontal resize handle at the top edge of the composer. A thin bar with a
   wider transparent hit area; row-resize cursor. Highlights on hover/active.

   touch-action:none is REQUIRED for stable touch dragging: without it the
   browser interprets the first pointermove as a pan/scroll gesture and fires
   pointercancel (or lets the page scroll), which severs setPointerCapture
   mid-drag — the "can't drag reliably on touchscreen" bug. */
.input-resize-handle {
  /* Sits ON the container's top edge, spanning the FULL width of the composer
     box (it is a grid item of .composer-box, which has no padding). The 4px of
     transparent padding straddles the top border so the grip is reachable from
     just outside; 3px of visible bar marks the edge. */
  position: relative;
  grid-column: 1 / 3;
  grid-row: 1;
  height: 3px;
  margin: -4px 0 1px;
  padding: 4px 0;
  cursor: row-resize;
  background: var(--border-color);
  z-index: 5;
  transition: background 0.15s;
  touch-action: none;
  -webkit-touch-callout: none;
  user-select: none;
}
.input-resize-handle:hover,
.input-resize-handle:active {
  background: var(--accent);
}
/* Transient toast shown when the user clicks the lightning bolt while
   already in auto mode. Floats above the composer, auto-clears in 2.5s. */
.auto-toast {
  position: absolute;
  bottom: calc(100% + 6px);
  right: 12px;
  background: color-mix(in srgb, #f59e0b 16%, var(--bg-input));
  color: #b45309;
  border: 1px solid color-mix(in srgb, #f59e0b 40%, transparent);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  z-index: 6;
  pointer-events: none;
}
.auto-toast-enter-active,
.auto-toast-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}
.auto-toast-enter-from,
.auto-toast-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
.file-input-hidden {
  display: none;
}
</style>
