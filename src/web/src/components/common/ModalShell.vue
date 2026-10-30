<script setup lang="ts">
/**
 * ModalShell.vue — our own modal primitive (NO native <dialog>).
 *
 * Why not <dialog>: `showModal()` puts the panel in the top layer, but the
 * page behind it still owns its scroll containers (here: ChatLog) in ways
 * that differ per engine, and the chrome/backdrop is platform-specific. This
 * shell states all three behaviours explicitly instead, so they are identical
 * everywhere and reviewable in one file:
 *
 *   1. Background scroll  — body overflow is locked (prior value captured and
 *      restored) AND the overlay is a non-ancestor sibling of the app, so
 *      pointer wheel events never reach ChatLog. `overscroll-behavior: contain`
 *      on the panel stops wheel chaining at its own boundaries.
 *   2. Focus containment  — `inert` is set on #app while open. The component is
 *      Teleported to <body>, i.e. OUTSIDE #app, so Tab/click cannot reach the
 *      page behind without a hand-rolled focus-trap key handler.
 *   3. Focus restore      — the opener is captured on open and refocused on
 *      close (same idiom as ImageViewer.vue), so keyboard users land back on
 *      the `+N` pill.
 *
 * ESC is a single window keydown listener, added on open and removed on close
 * AND on unmount (never leaked).
 */
import { ref, watch, onBeforeUnmount, nextTick } from 'vue';

const props = defineProps<{
  /** Whether the modal is mounted/visible. */
  open: boolean;
  /** Title shown in the header (also the aria-label of the dialog). */
  title: string;
  /** Optional max panel width in px (default 520). */
  maxWidth?: number;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const panel = ref<HTMLElement | null>(null);
/** Document element that had focus when we opened — restored on close. */
let returnFocusTarget: HTMLElement | null = null;
/** Prior body overflow, captured before locking (may be set by another overlay). */
let prevBodyOverflow = '';

function lockPage(): void {
  returnFocusTarget = document.activeElement as HTMLElement | null;
  prevBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  // Teleported OUTSIDE #app, so making the app inert traps focus here.
  document.getElementById('app')?.setAttribute('inert', '');
  window.addEventListener('keydown', onKeydown);
  void nextTick(() => panel.value?.focus());
}

function unlockPage(): void {
  document.body.style.overflow = prevBodyOverflow;
  document.getElementById('app')?.removeAttribute('inert');
  window.removeEventListener('keydown', onKeydown);
  returnFocusTarget?.focus?.();
  returnFocusTarget = null;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
  }
}

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) lockPage();
    else unlockPage();
  },
  { immediate: true },
);

// Never leak the listener / the scroll lock if we unmount while open.
onBeforeUnmount(() => {
  if (props.open) unlockPage();
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="props.open"
      class="modal-overlay"
      @click.self="emit('close')"
    >
      <div
        ref="panel"
        class="modal-panel"
        role="dialog"
        aria-modal="true"
        :aria-label="props.title"
        tabindex="-1"
        :style="{ maxWidth: `calc(${props.maxWidth ?? 520}px + 32px)` }"
      >
        <header class="modal-header">
          <h2 class="modal-title">{{ props.title }}</h2>
          <button class="modal-close" aria-label="关闭" @click="emit('close')">&times;</button>
        </header>
        <div class="modal-body">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="modal-footer">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: color-mix(in srgb, #000 45%, transparent);
}
.modal-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  /* Height follows the content: the panel only grows to its max-height when
     the list is long, so a short list does not leave empty room under it. */
  flex: 0 1 auto;
  /* The overlay's 16px padding is the outer margin; `maxWidth` is the CONTENT
     width it is computed against, so the panel adds the padding back (see the
     :style binding) — otherwise a `max-width` of N left 0 side margin on
     narrow viewports. */
  max-height: min(70vh, 520px);
  background: var(--bg-input);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
  outline: none;
  /* Wheel chaining stops at the panel boundaries instead of scrolling
     whatever sits behind the overlay. */
  overscroll-behavior: contain;
}
.modal-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}
.modal-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  flex: 1;
}
.modal-close {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 20px;
  line-height: 1;
  padding: 0 4px;
  cursor: pointer;
}
.modal-close:hover {
  color: var(--text-primary);
}
.modal-body {
  /* Content-sized: do NOT `flex: 1`, which made the body stretch to the
     panel's max-height and left empty room under a short list. */
  flex: 0 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  /* Bottom padding 0: the footer's own top padding is the only gap, and the
     panel's bottom edge hugs the footer's bottom padding. */
  padding: 10px 14px 0;
}
.modal-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: flex-end;
  padding: 10px 14px;
  border-top: 1px solid var(--border-color);
  flex-shrink: 0;
  /* Tighter than the body padding so the dialog does not carry a dead band
     under its buttons. */
  padding-bottom: 10px;
}
</style>
