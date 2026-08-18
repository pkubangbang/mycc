<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import type { ChatState, FileInfo } from '../types';
import { chatApi } from '../main';

const props = defineProps<{ state: ChatState }>();

const text = ref(props.state.inputText);
const fileInput = ref<HTMLInputElement | null>(null);
const localFiles = ref<FileInfo[]>([]);
const dragOver = ref(false);
let dragCounter = 0;

// Per-file upload size cap (MB), fetched from the server's /config endpoint
// (driven by --max-upload-mb / MYCC_MAX_UPLOAD_MB, default 50). Falls back to
// 50 if the fetch fails so the UI is still usable when /config is unreachable.
const maxUploadMb = ref(50);
const uploadError = ref('');

// Fetch the server-imposed upload cap once. /config is served on the same
// origin as the Web UI, so a relative URL works and reuses the live socket's
// host/port. A failure is non-fatal — the default cap still applies.
void (async () => {
  try {
    const res = await fetch('/config');
    if (res.ok) {
      const data = await res.json() as { maxUploadMb?: number };
      if (Number.isFinite(data.maxUploadMb) && (data.maxUploadMb as number) > 0) {
        maxUploadMb.value = data.maxUploadMb as number;
      }
    }
  } catch {
    // /config unreachable — keep default cap
  }
})();

watch(
  () => props.state.inputText,
  (val) => {
    if (val !== text.value) text.value = val;
  },
);

watch(text, (val) => {
  props.state.inputText = val;
});

watch(
  () => props.state.pendingFiles,
  (val) => {
    localFiles.value = val;
  },
);

function openFilePicker(): void {
  fileInput.value?.click();
}

// Format a byte count as a human-readable size string (e.g. "1.2 MB").
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Process a single file: size guard + FileReader → base64 → pendingFiles.
// Shared by drag/drop, file picker, and clipboard paste so the validation
// and reading logic stays DRY.
function processFile(file: File): void {
  const maxBytes = maxUploadMb.value * 1024 * 1024;
  // Size guard (client-side; the server re-checks for defense in depth).
  if (file.size > maxBytes) {
    uploadError.value = `「${file.name}」(${formatBytes(file.size)})超过 ${maxUploadMb.value}MB 上传限制，已跳过`;
    // Auto-clear the error after 4s
    setTimeout(() => {
      if (uploadError.value.startsWith(`「${file.name}」`)) uploadError.value = '';
    }, 4000);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result as string;
    const base64 = dataUrl.split(',')[1] || '';
    const info: FileInfo = {
      filename: file.name,
      data: base64,
      mimeType: file.type || 'application/octet-stream',
    };
    localFiles.value = [...localFiles.value, info];
    props.state.pendingFiles = localFiles.value;
  };
  reader.readAsDataURL(file);
}

function readFiles(rawFiles: FileList): void {
  for (let i = 0; i < rawFiles.length; i++) {
    const file = rawFiles[i];
    // Reject folders. When a folder is dropped, the browser exposes it as a
    // File whose .type is '' and .size is 0; reading it yields nothing useful.
    // webkitGetAsEntry (when available) gives a definitive answer — a dropped
    // directory is a FileSystemDirectoryEntry, not a File-backed entry.
    type FileWithEntry = File & { webkitGetAsEntry?: () => unknown };
    const item = (rawFiles as FileList & { item?(i: number): FileWithEntry }).item?.(i) as FileWithEntry | undefined;
    const entry = item?.webkitGetAsEntry?.();
    if ((entry && typeof entry === 'object' && (entry as { isDirectory?: boolean }).isDirectory)
        || (file.type === '' && file.size === 0)) {
      // Note: the size===0 && type==='' fallback may also match a genuine
      // 0-byte file, but that only triggers when webkitGetAsEntry is unavailable
      // (rare in modern browsers); a 0-byte upload is useless anyway, so the
      // misclassification is acceptable.
      uploadError.value = '不支持文件夹上传，请添加文件';
      setTimeout(() => { uploadError.value = ''; }, 4000);
      continue;
    }
    processFile(file);
  }
}

function onFilesSelected(event: Event): void {
  const input = event.target as HTMLInputElement;
  const rawFiles = input.files;
  if (!rawFiles || rawFiles.length === 0) return;
  readFiles(rawFiles);
  input.value = '';
}

function removeFile(index: number): void {
  localFiles.value.splice(index, 1);
  props.state.pendingFiles = localFiles.value;
}

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

// "压缩上下文" (compact context) button — sits to the LEFT of the
// lightning-bolt button. Clicking sends the "/compact" slash command via
// the normal input path (chatApi.sendInput), so it reuses the entire
// existing slash-command pipeline (no new WS type, no backend changes).
//
// The button is only enabled when ALL of these hold:
//   - not in auto mode (state.isAutoMode === false) — the lightning bolt
//     being on disables compact, per the user's requirement;
//   - at the PROMPT stage (state.isWaiting === true) — a fresh prompt is
//     pending and the loop is idle, so the slash command can run;
//   - no interactive card is pending (state.hasPendingCard === false);
//   - connected to the server (connectionStatus === 'connected').
const canCompact = computed(() =>
  !props.state.isAutoMode &&
  props.state.isWaiting &&
  !props.state.hasPendingCard &&
  props.state.connectionStatus === 'connected',
);

// ── Send gate + warning banner (single source of truth) ──
//
// The chatInput textarea is NEVER disabled — not on disconnect, not on a
// pending card, not on the steering-review card. Instead, a warning banner
// tells the user when the typed text will not be submitted, and the send
// button's :disabled mirrors the actual send behavior: the button is
// disabled exactly when sending is impossible, so if the button is enabled,
// send() will submit; if disabled, send() is a no-op. This removes the need
// for any redundant guards inside send().
//
// showSteeringReview: a transient "继续…" card (rendered in ChatLog) is
// pending user action at PROMPT. While it is showing, sending from the chat
// box is blocked — the user must first deal with the card (send the notes as
// a query or discard them). This is treated as a "card interruption", the
// same category as hasPendingCard.
const showSteeringReview = computed(() =>
  props.state.isWaiting && props.state.pendingSteeringReview.length > 0,
);

// canSend: the three disable conditions the send button mirrors —
// (1) no pending card (interactive ask() card OR the steering-review card),
// (2) non-empty content (text or files),
// (3) connected to the server.
const canSend = computed(() =>
  !props.state.hasPendingCard &&
  !showSteeringReview.value &&
  (text.value.trim() !== '' || localFiles.value.length > 0) &&
  props.state.connectionStatus === 'connected',
);

// Warning banner shown when the textarea is enabled (always) but the typed
// text will NOT be submitted. Covers: a pending ask() card, a pending
// steering-review card, and network disconnection. The banner replaces the
// old behavior of disabling the textarea — the box stays focusable so it
// never loses focus, and the banner explains why the text won't go through.
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

function onCompactClick(): void {
  if (!canCompact.value) return;
  chatApi.sendInput('/compact');
}

function send(): void {
  // canSend is the single source of truth: the send button's :disabled
  // mirrors it, so if we reach here, sending is genuinely possible. No
  // redundant empty/card/disconnect guards are needed — the button being
  // enabled guarantees they all pass. The Enter key path calls send() too,
  // so the same guard protects it.
  if (!canSend.value) return;
  const value = text.value;
  const files = localFiles.value.length > 0 ? [...localFiles.value] : undefined;
  // Tag the content with the actual loop stage: a PROMPT wait is pending
  // (isWaiting) → send as a fresh query (type:'input'); every other state
  // (agent working, auto mode, the transient send→running gap) → send as a
  // mid-task steering note (type:'steer'), buffered in the backend and
  // consumed at the next COLLECT (REMINDER) or surfaced for review at the
  // next PROMPT.
  if (props.state.isWaiting) {
    chatApi.sendInput(value, files);
  } else {
    chatApi.sendSteer(value, files);
  }
  text.value = '';
  localFiles.value = [];
  props.state.pendingFiles = [];
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
}

// Handle clipboard paste (Ctrl/Cmd+V) into the textarea. Scans the clipboard
// for file/image items (e.g. a screenshot copied to clipboard, or a file
// copied in the OS file manager) and routes each through processFile so they
// join the pendingFiles queue just like a drag/drop or picker selection.
// Text pastes are left to the textarea's native behavior (no preventDefault)
// so the user can still paste text normally. Only file-typed items are taken;
// image blobs are given a synthesized filename (image-<ts>.<ext>) since the
// clipboard carries no original name for them.
function onPaste(event: ClipboardEvent): void {
  const items = event.clipboardData?.items;
  if (!items) return;
  let hasFile = false;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    // kind:'file' covers both copied image blobs (image/png etc.) and files
    // copied in the OS file manager (which expose their real name). kind:
    // 'string'/'text' is plain text — let the textarea handle it natively.
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file) continue;
    hasFile = true;
    // Synthesize a filename for image blobs from the clipboard (screenshots
    // etc.) since they carry no original name. Use the MIME subtype as the
    // extension when available; fall back to 'bin'.
    let name = file.name;
    if (!name || name.startsWith('image.') || /^[0-9a-f]{8}-/i.test(name)) {
      const sub = file.type.split('/')[1] || 'bin';
      name = `image-${Date.now()}.${sub}`;
    }
    // Wrap in a new File to attach the synthesized name (the original File
    // from getAsFile may carry a browser-generated placeholder name).
    const named = new File([file], name, { type: file.type });
    processFile(named);
  }
  // Only prevent default when we actually consumed file items — otherwise
  // a plain text paste would be swallowed.
  if (hasFile) {
    event.preventDefault();
  }
}

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

// Handle a drop onto the input area. Previously this handler was missing
// (the template bound @drop="onDrop" but no function existed), so drops did
// nothing useful and the browser's default "open file" behaviour could even
// navigate the page away. Now we read the dropped files into the upload
// queue — any file type is accepted (the old accept="image/*" only constrained
// the file picker, not the dataTransfer). Size is checked per-file in
// readFiles against maxUploadMb.
function onDrop(event: DragEvent): void {
  event.preventDefault();
  dragCounter = 0;
  dragOver.value = false;
  const rawFiles = event.dataTransfer?.files;
  if (!rawFiles || rawFiles.length === 0) return;
  readFiles(rawFiles);
}

// ── Draggable input-box height ──
//
// A horizontal resize handle above the input box lets the user drag upward
// to grow the textarea (and downward to shrink it). Height is tracked in px,
// clamped to [MIN_HEIGHT, MAX_HEIGHT]. Pointer events drive the drag; the
// textarea itself stays `resize:none` so the native browser gripper doesn't
// conflict. The handle uses row-resize cursor.
const MIN_INPUT_HEIGHT = 40;   // px — roughly the 2-row default
const MAX_INPUT_HEIGHT = 320;  // px — keep the chat log usable
const inputHeight = ref(0);    // 0 = unset → textarea uses its default rows

let inputDragging = false;
// Anchor captured on pointerdown: the pointer's starting Y and the box's
// starting height. The new height on each move is startHeight + (startY -
// clientY) — dragging UP (clientY decreases) grows the box. Anchoring to a
// snapshot taken once at drag start keeps the math stable: it does not
// depend on a rect that itself changes as the box resizes, which is what
// caused the "jump" on the first move (the parent rect measured the whole
// .chat-input container, not the textarea, so the first computed height
// differed from the textarea's real height by ~the container chrome).
let dragStartY = 0;
let dragStartHeight = 0;
function onInputHandleDown(e: PointerEvent): void {
  inputDragging = true;
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
  e.preventDefault();
  dragStartY = e.clientY;
  // Snapshot the textarea's current rendered height. If inputHeight is
  // unset (0), measure the actual element so the first drag continues from
  // the visible size instead of jumping.
  const ta = (e.currentTarget as HTMLElement)
    .parentElement?.querySelector<HTMLTextAreaElement>('.input-area');
  dragStartHeight = inputHeight.value > 0
    ? inputHeight.value
    : (ta ? ta.getBoundingClientRect().height : MIN_INPUT_HEIGHT);
}
function onInputHandleMove(e: PointerEvent): void {
  if (!inputDragging) return;
  // The handle sits at the TOP of the input box. Dragging the pointer up
  // (clientY shrinks) increases the box height; dragging down decreases it.
  // Using the pointer-down anchor avoids re-measuring a rect that shifts as
  // the box resizes.
  const h = dragStartHeight + (dragStartY - e.clientY);
  inputHeight.value = Math.max(MIN_INPUT_HEIGHT, Math.min(h, MAX_INPUT_HEIGHT));
}
function onInputHandleUp(e: PointerEvent): void {
  inputDragging = false;
  try {
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  } catch {
    /* already released */
  }
}
const inputAreaStyle = computed(() =>
  inputHeight.value > 0 ? { height: `${inputHeight.value}px` } : {},
);
</script>

<template>
  <div
    class="chat-input"
    :class="{ 'drag-over': dragOver }"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- Horizontal resize handle at the top of the input box. Drag up to
         grow the textarea, down to shrink it. -->
    <div
      class="input-resize-handle"
      @pointerdown="onInputHandleDown"
      @pointermove="onInputHandleMove"
      @pointerup="onInputHandleUp"
      @pointercancel="onInputHandleUp"
      title="拖拽调整输入框高度"
    ></div>
    <div class="input-row">
      <div class="input-area-wrapper">
        <!-- The textarea is NEVER disabled — not on disconnect, not on a
             pending card, not on the steering-review card. Keeping it
             always enabled means it never loses focus during the
             send→running gap, while a card is pending, or while
             disconnected: the browser only moves focus off a focused
             element when it becomes disabled. Instead of disabling, a
             warning banner (input-warning below) tells the user when the
             typed text will not be submitted, and the 发送 button's own
             :disabled binding (canSend) is the single gatekeeper for
             whether sending actually happens. -->
        <textarea
          v-model="text"
          class="input-area"
          :style="inputAreaStyle"
          :placeholder="state.hasPendingCard ? '请在卡片上回复…' : (state.isWaiting ? '输入消息…' : (state.isAutoMode ? '给自动模式发指引…' : '等待回复中…'))"
          rows="2"
          @keydown="onKeydown"
          @paste="onPaste"
        ></textarea>
        <!-- Toolbar with the three action buttons (compact, auto, attach),
             rendered as a single horizontal row. The toolbar is always an
             overlay INSIDE the textarea (absolute-positioned relative to
             .input-area-wrapper). Its placement is responsive via CSS:
               - wide  (>600px): anchored to the bottom-right corner; the
                 textarea uses padding-right to clear the button strip;
               - narrow (≤600px): spans the full bottom edge; the textarea
                 uses padding-bottom to clear the toolbar row.
             Order left→right: compact, auto, attach (attach rightmost). -->
        <div class="input-toolbar">
          <!-- "压缩上下文" button — sends the "/compact" slash command via
               the normal input path. Only enabled in normal mode at the
               PROMPT stage; disabled when auto mode is on or the loop is
               busy. -->
          <button
            class="tool-btn compact-btn"
            :disabled="!canCompact"
            title="压缩上下文"
            @click="onCompactClick"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 5 Q6 12 3 19" />
              <path d="M21 5 Q18 12 21 19" />
              <path d="M9 3 L14 3 L16 5 L15 21 L8 21 Z" />
            </svg>
          </button>
          <!-- Lightning bolt: one-way "enter auto mode" button. If already
               in auto mode, surface a transient "已经是自动模式了" toast
               locally (no round-trip); otherwise send the 'auto' WS message
               to enter auto mode. -->
          <button
            class="tool-btn auto-btn"
            :class="{ 'auto-btn--on': state.isAutoMode }"
            :disabled="state.connectionStatus !== 'connected'"
            :title="state.isAutoMode ? '已经是自动模式了' : '进入自动模式'"
            @click="onAutoClick"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </button>
          <button
            class="tool-btn attach-btn"
            :disabled="state.connectionStatus !== 'connected'"
            title="附加文件"
            @click="openFilePicker"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </button>
        </div>
        <transition name="auto-toast">
          <div v-if="autoToast" class="auto-toast">{{ autoToast }}</div>
        </transition>
      </div>
      <input
        ref="fileInput"
        type="file"
        multiple
        class="file-input-hidden"
        @change="onFilesSelected"
      />
      <button
        class="send-btn"
        :disabled="!canSend"
        @click="send"
      >发送</button>
    </div>
    <!-- Warning banner: shown when the textarea is enabled (always) but the
         typed text will NOT be submitted — a pending ask() card, a pending
         steering-review card, or network disconnection. Replaces the old
         behavior of disabling the textarea; the box stays focusable. -->
    <div v-if="showInputWarning" class="input-warning">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span>{{ inputWarningText }}</span>
    </div>
    <div v-if="uploadError" class="upload-error">{{ uploadError }}</div>
    <div v-if="localFiles.length > 0" class="file-chips">
      <span
        v-for="(f, i) in localFiles"
        :key="i"
        class="file-chip"
      >
        <span class="file-chip-name">{{ f.filename }}</span>
        <button class="file-chip-remove" @click="removeFile(i)">&times;</button>
      </span>
    </div>
  </div>
</template>

<style scoped>
.chat-input {
  display: flex;
  flex-direction: column;
  padding: 8px 16px 16px;
  background: var(--bg-input);
  border-top: 1px solid var(--border-color);
  flex-shrink: 0;
  transition: background 0.15s;
  position: relative;
}
.chat-input.drag-over {
  background: color-mix(in srgb, var(--accent) 8%, var(--bg-input));
}
/* Horizontal resize handle at the top edge of the input box. A thin bar
   with a wider transparent hit area; row-resize cursor. Highlights on
   hover/active to signal it's draggable. */
.input-resize-handle {
  position: absolute;
  top: -4px;
  left: 0;
  right: 0;
  height: 3px;
  padding: 4px 0;
  cursor: row-resize;
  background: var(--border-color);
  z-index: 5;
  transition: background 0.15s;
}
.input-resize-handle:hover,
.input-resize-handle:active {
  background: var(--accent);
}
.input-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
}
.input-area-wrapper {
  position: relative;
  flex: 1;
  display: flex;
}
.input-area {
  flex: 1;
  resize: none;
  border: 1px solid var(--border-input);
  border-radius: 6px;
  /* Default (wide, >600px): right padding clears the toolbar strip
     (three 28px buttons + 2×4px gaps + 2px margin ≈ 98px) anchored at the
     bottom-right of the textarea. The narrow-screen layout switches this
     to a bottom padding via the @media query below. */
  padding: 8px 98px 8px 12px;
  font-size: 14px;
  font-family: inherit;
  line-height: 1.5;
  /* No max-height: the draggable handle controls height via inline style.
     The textarea's own scrolling kicks in once content exceeds the set
     height (overflow-y is auto by default for textarea). */
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
/* Toolbar overlay: a single horizontal row of three icon buttons. It is
   always absolutely positioned INSIDE the textarea (relative to
   .input-area-wrapper). On wide screens it hugs the bottom-right corner;
   on narrow screens (≤600px) it spans the full bottom edge. The buttons
   share a common .tool-btn base; each adds its own hover color. */
.input-toolbar {
  position: absolute;
  right: 2px;
  bottom: 2px;
  display: flex;
  align-items: center;
  gap: 4px;
  z-index: 2;
}
/* Shared icon-button base for the three toolbar buttons. */
.tool-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-input-field);
  color: var(--text-muted);
  border: none;
  border-radius: 4px;
  padding: 4px;
  width: 28px;
  height: 28px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.tool-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.attach-btn:hover:not(:disabled),
.compact-btn:hover:not(:disabled) {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, var(--bg-input-field));
}
.auto-btn:hover:not(:disabled) {
  color: #f59e0b;
  background: color-mix(in srgb, #f59e0b 12%, var(--bg-input-field));
}
.auto-btn--on {
  color: #f59e0b;
}
/* Narrow screens (≤600px): the toolbar drops to span the full bottom edge
   of the textarea, right-aligned within the row. The textarea switches its
   clear-space from padding-right (wide) to padding-bottom so the toolbar
   row no longer overlaps typed text. The toolbar is still INSIDE the
   textarea (absolute overlay), just stretched across the bottom. */
@media (max-width: 600px) {
  .input-area {
    padding: 8px 12px 40px;
  }
  .input-toolbar {
    right: 4px;
    left: 4px;
    bottom: 4px;
    justify-content: flex-end;
  }
}
/* Transient toast shown when the user clicks the lightning bolt while
   already in auto mode. Floats above the input box, auto-clears in 2.5s. */
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
.upload-error {
  margin-top: 8px;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  background: color-mix(in srgb, #ef4444 12%, var(--bg-input));
  color: #ef4444;
  border: 1px solid color-mix(in srgb, #ef4444 30%, transparent);
}
/* Warning banner shown when the textarea is enabled (always) but the typed
   text will NOT be submitted — a pending ask() card, a pending
   steering-review card, or network disconnection. Amber accent signals a
   warning (distinct from the old accent-blue card-pending hint). */
.input-warning {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  background: color-mix(in srgb, #f59e0b 12%, var(--bg-input));
  color: #b45309;
  border: 1px solid color-mix(in srgb, #f59e0b 30%, transparent);
}
.file-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.file-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--accent);
  color: var(--accent-text);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 12px;
  max-width: 200px;
}
.file-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-chip-remove {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0;
  margin-left: 2px;
  opacity: 0.8;
}
.file-chip-remove:hover {
  opacity: 1;
}
</style>
