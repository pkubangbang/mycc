<script setup lang="ts">
/**
 * ImageViewer.vue — a dedicated full-screen image viewer popup.
 *
 * Opens on a window `open-image-viewer` CustomEvent carrying the image src
 * (and optional alt text). Rendered ONCE in App.vue so it overlays the whole
 * app regardless of which MessageItem's image was clicked — no prop drilling
 * through App → ChatLog → MessageItem.
 *
 * Features:
 *  • Click image in a chat bubble → opens here at natural size, centered.
 *  • Backdrop click / ESC / ✕ button closes.
 *  • Click the image itself toggles between "fit" (scaled to viewport) and
 *    "1:1" (natural size, scrollable) — useful for inspecting dense diagrams.
 *  • A caption (the image alt text) shows under the image when present.
 *  • Download button (the image's own URL) for convenience.
 */
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';

const open = ref(false);
const src = ref('');
const alt = ref('');
const naturalMode = ref(false);
const naturalSize = ref({ w: 0, h: 0 });
const viewport = ref({ w: 0, h: 0 });
// True when the current <img> failed to load (404/broken). Suppresses the
// toggle/download actions and shows a failure message instead of a
// broken-image icon. Reset on every open.
const loadError = ref(false);
// Element that had focus when the viewer opened — focus is restored to it
// on close so keyboard users land back where they were.
let returnFocusTarget: HTMLElement | null = null;
// Previous body.overflow value captured before we lock scroll, restored on
// close so we never clobber a value another overlay may have set.
let prevBodyOverflow = '';

const closeBtn = ref<HTMLButtonElement | null>(null);

function onOpen(e: Event): void {
  const ce = e as CustomEvent<{ src: string; alt?: string }>;
  if (!ce.detail || !ce.detail.src) return;
  // Capture current focus so we can restore it on close.
  returnFocusTarget = document.activeElement as HTMLElement | null;
  src.value = ce.detail.src;
  alt.value = ce.detail.alt ?? '';
  naturalMode.value = false; // start in fit mode
  loadError.value = false;
  // Reset dimensions from any previously-viewed image so the
  // "click to view full size" hint doesn't leak into this one before the
  // new image's `load` event fires and repopulates naturalSize.
  naturalSize.value = { w: 0, h: 0 };
  open.value = true;
  // Lock body scroll while the modal is open so wheel/trackpad/Space don't
  // scroll the chat log behind the overlay. Only capture the prior value
  // when body isn't already locked by us — otherwise a second open (without
  // an intervening close) would capture 'hidden' as the "previous" value
  // and leave body locked after the eventual close.
  if (document.body.style.overflow !== 'hidden') {
    prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  // Measure viewport for the fit↔1:1 toggle sizing decision.
  viewport.value = { w: window.innerWidth, h: window.innerHeight };
  // Move focus into the dialog for keyboard users (a11y). nextTick so the
  // close button ref is bound after the v-if render.
  nextTick(() => closeBtn.value?.focus());
}

function close(): void {
  open.value = false;
  // Restore body scroll + focus.
  document.body.style.overflow = prevBodyOverflow;
  returnFocusTarget?.focus?.();
  returnFocusTarget = null;
}

function onKeydown(e: KeyboardEvent): void {
  if (!open.value) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
  }
}

function onImageLoad(e: Event): void {
  // Discard late load events from a previously-opened image that arrive
  // after close() — otherwise a slow prior image could overwrite naturalSize
  // for whatever is (or isn't) currently shown.
  if (!open.value) return;
  const img = e.target as HTMLImageElement;
  naturalSize.value = { w: img.naturalWidth, h: img.naturalHeight };
}

/** Image failed to load (404/broken). Mark loadError so the UI shows a
 *  failure message and disables the toggle/download actions. */
function onImageError(): void {
  naturalSize.value = { w: 0, h: 0 };
  loadError.value = true;
}

/** Click on the image itself toggles fit ↔ 1:1. */
function toggleMode(): void {
  naturalMode.value = !naturalMode.value;
}

/** Whether the image is larger than the viewport in fit mode — controls the
 *  "click to view full size" hint affordance. */
const isLargerThanViewport = computed(() =>
  naturalSize.value.w > viewport.value.w * 0.9 ||
  naturalSize.value.h > viewport.value.h * 0.9
);

function download(): void {
  // Validate the URL scheme before assigning it to <a>.href + invoking
  // .click(): a `javascript:` or `data:text/html` URL could execute in
  // embedded/older WebView contexts where the download attribute is ignored
  // for non-http(s) schemes. Only allow image-bearing schemes.
  const allowedSchemes = ['http:', 'https:', 'blob:', 'data:'];
  let parsed: URL | null = null;
  try {
    parsed = new URL(src.value);
  } catch {
    // Relative URLs (no scheme) are safe — resolve against the current base.
    parsed = null;
  }
  if (parsed && !allowedSchemes.includes(parsed.protocol)) return;
  // Block non-image data: URLs (e.g. data:text/html) — only data:image/* is
  // safe to download as an image.
  if (parsed && parsed.protocol === 'data:' && !/^data:image\//i.test(src.value)) return;

  const a = document.createElement('a');
  a.href = src.value;
  // Derive a filename. For data: URLs split('/').pop() mangles the mime
  // type into the filename, so use a fixed image name derived from the
  // embedded mime when present, else a generic fallback. For http(s)/blob
  // URLs take the path tail (sans query) and ensure it's non-empty.
  let tail = '';
  if (/^data:/i.test(src.value)) {
    const mimeMatch = src.value.match(/^data:(image\/[a-z+.-]+)/i);
    const ext = mimeMatch ? mimeMatch[1].split('/')[1].replace('+xml', '').split('+')[0] : 'png';
    tail = `image.${ext || 'png'}`;
  } else {
    tail = src.value.split('/').pop()?.split('?')[0] || '';
    if (!tail || !tail.includes('.')) tail = 'image.png';
  }
  a.download = tail;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function onResize(): void {
  viewport.value = { w: window.innerWidth, h: window.innerHeight };
}

onMounted(() => {
  window.addEventListener('open-image-viewer', onOpen as EventListener);
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', onResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('open-image-viewer', onOpen as EventListener);
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', onResize);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="image-viewer"
      role="dialog"
      aria-modal="true"
      :aria-label="alt || '图片查看器'"
      @click.self="close"
    >
      <!-- Top-right controls. @click.self on the backdrop closes; these
           buttons stopPropagation so clicking them does not also close. -->
      <div class="iv-controls">
        <button
          class="iv-btn"
          :title="naturalMode ? '适应窗口' : '原始尺寸 (1:1)'"
          :disabled="loadError"
          @click.stop="toggleMode"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path v-if="naturalMode" d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>
            <path v-else d="M3 8V5a2 2 0 0 1 2-2h3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>
          </svg>
        </button>
        <button
          class="iv-btn"
          title="下载图片"
          :disabled="loadError"
          @click.stop="download"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="7 10 12 15 17 10"/>
            <line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </button>
        <button
          ref="closeBtn"
          class="iv-btn"
          title="关闭 (Esc)"
          @click.stop="close"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <!-- The image. In fit mode it scales to the viewport (max 90vw/90vh);
           in 1:1 mode it shows natural size and the container scrolls.
           .iv-stage-natural switches alignment to flex-start so an
           oversized 1:1 image's top-left stays reachable by scroll
           (flex centering + overflow:auto would clip it permanently). -->
      <div
        class="iv-stage"
        :class="{ 'iv-stage-natural': naturalMode }"
        @click.self="close"
      >
        <img
          v-if="!loadError"
          :src="src"
          :alt="alt"
          :class="{ 'iv-natural': naturalMode }"
          draggable="false"
          @load="onImageLoad"
          @error="onImageError"
          @click.stop="toggleMode"
        />
        <div v-else class="iv-error">图片加载失败</div>
        <div v-if="alt && !loadError" class="iv-caption">{{ alt }}</div>
        <div v-if="isLargerThanViewport && !naturalMode && !loadError" class="iv-hint">
          点击图片查看原始尺寸
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.image-viewer {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.82);
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(2px);
  animation: iv-fade-in 0.15s ease-out;
}
@keyframes iv-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.iv-controls {
  position: absolute;
  top: 16px;
  right: 16px;
  display: flex;
  gap: 6px;
  z-index: 2;
}
.iv-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.9);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.iv-btn:hover {
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
  border-color: rgba(255, 255, 255, 0.4);
}
.iv-stage {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  max-width: 90vw;
  max-height: 90vh;
  overflow: auto;
  padding: 12px;
}
/* In 1:1 mode, switch to flex-start alignment so an oversized image's
   top-left corner stays reachable by scroll. Flex centering + overflow:auto
   would center the overflow and permanently clip the top/left portion. */
.iv-stage.iv-stage-natural {
  align-items: flex-start;
  justify-content: flex-start;
}
.iv-stage img {
  max-width: 90vw;
  max-height: 80vh;
  object-fit: contain;
  border-radius: 4px;
  cursor: zoom-in;
  transition: max-width 0.2s, max-height 0.2s;
  user-select: none;
}
.iv-stage img.iv-natural {
  max-width: none;
  max-height: none;
  width: auto;
  height: auto;
  cursor: zoom-out;
}
.iv-caption {
  margin-top: 10px;
  color: rgba(255, 255, 255, 0.72);
  font-size: 13px;
  text-align: center;
  max-width: 80vw;
  word-break: break-word;
}
.iv-hint {
  margin-top: 6px;
  color: rgba(255, 255, 255, 0.5);
  font-size: 11.5px;
}
.iv-error {
  color: rgba(255, 255, 255, 0.7);
  font-size: 15px;
  padding: 40px 20px;
  text-align: center;
}
.iv-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.iv-btn:disabled:hover {
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.9);
  border-color: rgba(255, 255, 255, 0.18);
}
</style>