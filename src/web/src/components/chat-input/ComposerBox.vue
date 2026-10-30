<script setup lang="ts">
/**
 * ComposerBox.vue — textarea + floating icon strip + send button.
 *
 * This component is a PASS-THROUGH: its root is `display: contents`, so its
 * three children are laid out by the SHELL root's grid (ChatInput.vue carries
 * `.composer-box`, the `--composer-*` variables and the height authority).
 * That is what keeps manual resize trivial: the drag handle is a sibling inside
 * the shell root, so it reaches the box with `currentTarget.parentElement`
 * instead of a template `ref` (which on a child component yields the component
 * instance, not an Element — the reason drags were no-ops after the split).
 *
 * Layout the shell provides:
 *   row 1  stage strip (verbose only)
 *   row 2  [ textarea (col 1) + floating strip (col 1, bottom-right) | 发送 (col 2) ]
 *   row 3  warning / upload error
 *   row 4  attachment bar (always one line)
 *
 * The textarea is NEVER disabled — not on disconnect, not on a pending card,
 * not on the steering-review card. Keeping it always enabled means it never
 * loses focus during the send→running gap or while a card is pending (the
 * browser only moves focus off a focused element when it becomes disabled).
 * The shell's warning banner explains when typed text will not be submitted,
 * and the 发送 button's :disabled is the single gatekeeper.
 *
 * Capability props only — this component never sees `ChatState`.
 */
import type { FileInfo } from '../../types';

const props = defineProps<{
  /** Current text (v-model:text). */
  text: string;
  /** Placeholder, resolved by the shell from the phase. */
  placeholder: string;
  /** Send button gate — mirrors the shell's send() guard exactly. */
  canSend: boolean;
  /** 压缩上下文 button gate. */
  canCompact: boolean;
  /** Lightning bolt is "on" (orthogonal to phase). */
  isAutoMode: boolean;
  /** WS connection state; controls the auto/attach enabled flags. */
  connected: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:text', value: string): void;
  (e: 'send'): void;
  (e: 'compact'): void;
  (e: 'auto'): void;
  /** The 附加文件 button was pressed — the shell owns the hidden picker. */
  (e: 'attach'): void;
  /** Clipboard held FILE items; the shell pushes them into the queue. */
  (e: 'paste-files', event: ClipboardEvent): void;
}>();

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    emit('send');
  }
}

// Text pastes are left to the textarea's native behaviour (no preventDefault);
// only file-bearing clipboard payloads are taken over.
function onPaste(event: ClipboardEvent): void {
  emit('paste-files', event);
}
</script>

<template>
  <div class="composer-box">
    <!-- Drag handle (top edge), supplied by the shell. Slot content lands
         inside .composer-box, so its pointer handlers can resolve the box with
         `closest('.composer-box')`. -->
    <slot name="handle" />
    <div class="composer-row">
      <div class="input-band">
        <textarea
        :value="props.text"
        class="composer-box__textarea"
        :placeholder="props.placeholder"
        rows="2"
        @input="emit('update:text', ($event.target as HTMLTextAreaElement).value)"
        @keydown="onKeydown"
        @paste="onPaste"
      ></textarea>
      <!-- Three action buttons, overlaid INSIDE the textarea's cell at the
           bottom-right. Order left→right: compact, auto, attach. -->
      <div class="composer-box__actions">
        <button
          class="tool-btn compact-btn"
          :disabled="!props.canCompact"
          title="压缩上下文"
          @click="emit('compact')"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 5 Q6 12 3 19" />
            <path d="M21 5 Q18 12 21 19" />
            <path d="M9 3 L14 3 L16 5 L15 21 L8 21 Z" />
          </svg>
        </button>
        <!-- Lightning bolt: one-way "enter auto mode". If already in auto mode
             the shell shows a transient "已经是自动模式了" toast. -->
        <button
          class="tool-btn auto-btn"
          :class="{ 'auto-btn--on': props.isAutoMode }"
          :disabled="!props.connected"
          :title="props.isAutoMode ? '已经是自动模式了' : '进入自动模式'"
          @click="emit('auto')"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
          </svg>
        </button>
        <button
          class="tool-btn attach-btn"
          :disabled="!props.connected"
          title="附加文件"
          @click="emit('attach')"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </button>
      </div>
        <button
          class="send-btn"
          :disabled="!props.canSend"
          @click="emit('send')"
        >发送</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ── Registered height driver ──
   syntax '<length>' gives the property a typed initial value, so clamp() over
   it is always valid even before the first drag; the handle's inline value
   overrides the initial one (inline beats a rule, and both are <length>). */
@property --composer-raw-h {
  syntax: '<length>';
  inherits: true;
  initial-value: 40px;
}

/* ── The composer box: placement grid (NOT the height box) ──
 *
 * The height contract lives on `.composer-row` (below): that row is the
 * min-height/max-height box, and it carries the vertical padding. The shell
 * and this box have NO padding, so nothing can add an empty band below the
 * last child (the attachment bar). ──
 *
 *   columns: [ text | 发送 ]
 *   rows   : [ stage strip? ] [ COMPOSER BAND ] [ notices ] [ attachments ]
 *
 * The middle band is what `--composer-raw-h` sizes. Because it is a real grid
 * row of a real box, the textarea (`height:100%`) and the floating strip
 * (`align-self:end`) fill it automatically — no px math anywhere.
 *
 * --composer-raw-h is NOT declared here: the shell writes it INLINE on
 * `.composer-box` (root of this component) from the drag handle. A local
 * declaration would win over the inherited inline value and turn every drag
 * into a no-op; the `auto` fallback supplies the default.
 *
 * The stage strip is `v-if`-ed, so placement is keyed off its presence with
 * `:has()`; the middle band is always row 2 when it shows and row 1 when it
 * does not.
 */
.composer-box {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto auto auto;
  align-content: start;
  align-items: start;
  /* NO row-gap: the box's height is the composer row plus the notice rows,
     so the bottom of the box IS the bottom of the textarea (a gap here would
     show as an empty line under the textarea). */
  gap: 0;
  /* The stage strip needs breathing room above the composer row. */
  row-gap: 0;
  width: 100%;
  position: relative;
  box-sizing: border-box;

  /* Clamps are NOT on the box: the box = composer row + notice rows + the
     attachment bar, which must be able to add their own height below the
     textarea. A max-height here would scroll (or clip) those rows instead of
     just the textarea. The clamps live on the composer row (below), which is
     exactly the part the drag handle sizes. */
  overflow: visible;
}

/* Row assignment. */
/* The drag handle is absolutely positioned on the top edge (it takes no grid
   row). Everything else follows in document order: stage strip? → composer
   row → notices → attachment bar. */
.composer-box > .stage-row { grid-row: 1; grid-column: 1 / 3; margin: 0 var(--composer-gutter, 8px); }
.composer-box:not(:has(> .stage-row)) > .composer-row { grid-row: 1; }
.composer-box:has(> .stage-row)    > .composer-row { grid-row: 2; }
.composer-box > .composer-row { grid-column: 1 / 3; }
.composer-box:not(:has(> .stage-row)) > .input-warning,
.composer-box:not(:has(> .stage-row)) > .upload-error  { grid-row: 2; }
.composer-box:has(> .stage-row) > .input-warning,
.composer-box:has(> .stage-row) > .upload-error        { grid-row: 3; }
.composer-box:not(:has(> .stage-row)) > .attachment-bar { grid-row: 3; }
.composer-box:has(> .stage-row)    > .attachment-bar { grid-row: 4; }
.composer-box > .input-warning,
.composer-box > .upload-error,
.composer-box > .attachment-bar                    { grid-column: 1 / 3; }

/* The composer row carries the horizontal gutter (the shell pads only the
   box's bottom, so the drag handle can sit ON the container's top edge).
   It is a grid item of the box (row 1 or 2, next to the stage strip). */
.composer-row {
  /* ── The composer row IS the clamp boundary ──
     Horizontal inset is a MARGIN on this row (the shell is full-bleed, so the
     drag handle can run the whole width). Vertically this row is the box's
     min-height / max-height box: the band inside is clamped to its limits and
     the row never grows past them, so the rows BELOW it (notices + attachment
     bar) can never push it taller — and the shell/box carry no padding of
     their own, so there is no empty band under the bar. */
  margin: 0 var(--composer-gutter, 8px);
  padding: 8px 0 0;
  min-width: 0;
  min-height: var(--composer-min-h, 40px);
  max-height: var(--composer-max-h, 320px);
  overflow: hidden;
  /* ── Where the height contract is CLAMPED (the one place, CSS-only) ──
     The band height is whatever the handle wrote; the floor and ceiling are
     enforced right here so the inner grid always has a sane box to fill.
     min = 40px (≈ one textarea line + border + padding) — the handle simply
     cannot drag the band below that, so an overlapped/inverted layout is
     impossible by construction. */
  /* The band height: whatever the handle wrote, clamped to [floor, ceiling].
     `--composer-raw-h` is a REGISTERED <length> property (see the @property
     block at the bottom of this file) with initial-value 40px, so the clamp()
     below always receives a concrete length. (A plain unregistered custom
     property would make `clamp(40px, auto, 320px)` INVALID CSS when the
     handle had not written yet, and the whole height declaration would be
     dropped.) The handle's inline px value still wins over the registration. */
  --band-h: clamp(
    var(--composer-min-h, 40px),
    var(--composer-raw-h),
    var(--composer-max-h, 320px)
  );
}

/* ── The composer band: textarea (col 1) + floating strip (col 1) + 发送
   (col 2). Its height comes from the box's grid row above; when the box is
   squeezed below the band's natural size this band scrolls the textarea
   internally because the textarea has `min-height:0; overflow:auto`. ── */
.input-band {
  height: var(--band-h);
  /* Belt and braces: even if --band-h were somehow overridden, the band can
     never be shorter than the floor. */
  min-height: var(--composer-min-h, 40px);
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: minmax(0, 1fr);
  align-items: start;
  gap: 8px;
}

.composer-box__textarea {
  grid-area: 1 / 1 / 2 / 2;
  height: 100%;
  min-height: 0;
  width: 100%;
  resize: none;
  border: 1px solid var(--border-input);
  border-radius: 6px;
  /* Right gutter clears the floating strip. */
  padding: 8px var(--toolbar-w, 98px) 8px 12px;
  font-size: 14px;
  font-family: inherit;
  line-height: 1.5;
  outline: none;
  background: var(--bg-input-field);
  color: var(--text-primary);
  overflow-y: auto;
}
.composer-box__textarea:focus {
  border-color: var(--accent);
}

/* Overlay strip: same cell as the textarea, anchored bottom-right. Being a
   content-sized grid item (not a stretched absolutely positioned container)
   is what keeps it from covering the last text line. */
.composer-box__actions {
  grid-area: 1 / 1 / 2 / 2;
  align-self: end;
  justify-self: end;
  margin: 0 calc(var(--toolbar-inset, 2px) + 4px) var(--toolbar-inset, 2px) 0;
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

/* Narrow screens cannot afford the 98px right gutter (it leaves ~330-390px of
   empty space right of wrapped text). The strip is bottom-anchored, so reserve
   BOTTOM padding instead and let text use the full width.
   48px = 28px button + 4px inset + 2px border (34px) + one full 14px/1.5 line
   box (21px) rounded up — otherwise the last line sits inside the strip. */
@media (max-width: 600px) {
  .composer-box__textarea {
    padding: 8px 12px 48px;
  }
  .composer-box__actions {
    margin-right: 4px;
    margin-bottom: 4px;
  }
}

.send-btn {
  grid-area: 1 / 2 / 2 / 3;
  align-self: start;
  background: var(--accent);
  color: var(--accent-text);
  border: none;
  padding: 8px 20px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  height: 40px;
  font-weight: 500;
  /* CJK line-breaking allows a break between ANY two glyphs, and .send-btn is
     a shrinkable grid item: without nowrap the label "发送" wraps to 发/送 and
     the button collapses to ~1 glyph wide. */
  white-space: nowrap;
  transition: opacity 0.15s;
}
.send-btn:not(:disabled):hover {
  opacity: 0.85;
}
.send-btn:disabled {
  background: var(--accent-disabled);
  cursor: not-allowed;
}
</style>
