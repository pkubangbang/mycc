# WebUI composer — component split, layout contract, height contract

The chat input used to be one 977-line `ChatInput.vue`. It is now a thin
**shell** plus a set of capability-props children. This file records the three
invariants that keep the split real (capability props, one layout owner, one
height clamp) and the mechanics that back them.

---

## 1. Layout

```
ChatInput.vue                        ← shell (~630 L)
│  owns: text↔state.inputText mirror · send gate · send() routing (query vs
│        steer) · send→running latch · @drag* bindings (whole composer is the
│        drop target) · hidden <input type=file> · manual height handle
│        (passed to ComposerBox via the `handle` slot) · verbose-only stage
│        chip row · auto-mode toast
│
├─ chat-input/ComposerBox.vue        textarea + floating strip + 发送
├─ chat-input/InputNoticeBar.vue     amber warning / red upload error
├─ chat-input/AttachmentBar.vue      one line, always: 2 chips + "+N 个附件"
├─ chat-input/AttachmentManager.vue  popup: list · remove · remove-all
│    └─ common/ModalShell.vue        our own modal (Teleport + inert + scroll lock)
└─ composables/useAttachmentQueue.ts read → size guard → base64 → pendingFiles
                                     (+ 超限 / 文件夹拒绝 banners)
   format-bytes.ts                   "1.2 MB" formatting shared by queue + manager
```

DOM (the order matters — the shell is a flex column, `ComposerBox` is the grid
that holds everything else):

```
div.chat-input                       ← full-bleed, padding: 0 0 5px, 8px x-margins on children
└ div.composer-box                  ← placement grid (position: relative)
   ├ div.input-resize-handle        ← absolutely positioned, spans the FULL width
   ├ div.stage-row        [v-if verboseLogs]
   ├ div.composer-row               ← x-margin, vertical padding, THE CLAMP BOX
   │  └ div.input-band              ← height: clamp(min, --composer-raw-h, max)
   │     ├ textarea.composer-box__textarea   (grid 1/1, height 100%)
   │     ├ div.composer-box__actions         (grid 1/1, align-self:end, floating)
   │     └ button.send-btn                    (grid 1/2, 发送)
   ├ div.input-warning / .upload-error       [v-if]
   └ div.attachment-bar                       [v-if files]
```

## 2. Invariant — capability props only

**No child receives `state: ChatState`.** Each child declares exactly the
derived values it renders:

| Component | Props | Emits |
|---|---|---|
| `ComposerBox.vue` | `text, placeholder, canSend, canCompact, isAutoMode, connected` | `update:text, send, compact, auto, attach, paste-files` |
| `InputNoticeBar.vue` | `warning: string \| null, error: string \| null` | — |
| `AttachmentBar.vue` | `files: FileInfo[]` | `manage, remove(index)` |
| `AttachmentManager.vue` | `open, files` | `close, remove(index), remove-all` |
| `ModalShell.vue` | `open, title, maxWidth?` | `close` |

The shell keeps everything that spans regions (send routing, the latch) or
must talk to the backend (`chatApi`). `ComposerBox` does no file I/O: it emits
`attach` (the shell opens its hidden picker) and `paste-files` (the shell hands
the `ClipboardEvent` to the queue). Drag handlers stay in the shell because the
whole composer is the drop target.

## 3. Invariant — one layout owner, margins on the children

| Inset | Owner | Value |
|---|---|---|
| horizontal gutter | **each visual child** (`margin: 0 var(--composer-gutter)`) | `--composer-gutter: 8px` on `.chat-input` |
| bottom inset | **the shell only** (`padding: 0 0 5px`) | exactly 5px, whatever the last child is |
| space above the textarea | `.composer-row` (`padding-top: 8px`) | 8px |

Rules that follow:

- **The shell has NO horizontal padding.** It is full-bleed, which is what lets
  the absolutely-positioned drag handle span the container's entire width
  (`handle x=0, width=1280` at a 1280px viewport).
- **The shell owns the bottom inset, the last child must not.** No child sets
  `margin-bottom`; otherwise the inset would stack (bar margin + shell padding)
  and the visual bottom gap would drift. Measured: attachment-bar bottom 572 vs
  container bottom 577 → **5px**.
- **No `row-gap` on `.composer-box`.** A gap between the composer row and the
  attachment bar showed as a dead band directly under the textarea. The only
  vertical space below the textarea is the bar's own 32px row.

## 4. Invariant — the height contract

Manual drag-resize only. **No auto-grow** (`field-sizing: content` was
considered and rejected: the box must not resize under the user while typing).

```
--composer-raw-h   REGISTERED <length>, initial-value 40px, written INLINE by
                   the drag handle on .composer-box, UNCLAMPED
--composer-min-h   40px   (≈ one line of 14px/1.5 text + padding + border)
--composer-max-h   320px  (keeps the chat log usable)
```

```css
/* ComposerBox.vue — one registered property, so clamp() is always valid */
@property --composer-raw-h { syntax: '<length>'; inherits: true; initial-value: 40px; }

/* the CLAMP BOX: min/max-height live here, not on .composer-box */
.composer-row {
  margin: 0 var(--composer-gutter, 8px);
  padding: 8px 0 0;
  min-height: var(--composer-min-h, 40px);
  max-height: var(--composer-max-h, 320px);
  overflow: hidden;
}
.input-band {
  --band-h: clamp(var(--composer-min-h, 40px), var(--composer-raw-h), var(--composer-max-h, 320px));
  height: var(--band-h);
  min-height: var(--composer-min-h, 40px);      /* belt and braces */
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: minmax(0, 1fr);           /* the textarea fills this row */
}
.composer-box__textarea { grid-area: 1 / 1; height: 100%; min-height: 0; overflow-y: auto; }
.composer-box__actions  { grid-area: 1 / 1; align-self: end; justify-self: end; }
.send-btn               { grid-area: 1 / 2; align-self: start; }
```

### Why each rule exists (each one fixed a real regression)

1. **`--composer-raw-h` is never declared in a rule.** A declaration on the
   element that also receives the inline value wins over it, and every drag
   became a no-op. The handle writes it inline; `@property` supplies the initial
   value only.
2. **Registered, not a bare custom property.** An unregistered and unset custom
   property substitutes as a token before `clamp()` parses, so the declaration
   becomes `clamp(40px, auto, 320px)` — **invalid**, the whole `height` is
   dropped, and the band never moves. `syntax: '<length>'` guarantees a concrete
   length.
3. **The clamp lives on `.composer-row`, not `.composer-box`.** The box is
   *composer row + notice rows + attachment bar*; a `max-height` there would
   scroll or clip those rows instead of only the textarea. On the row, the
   notices and the bar can add height below the textarea freely.
4. **The handle resolves its box through the DOM, not a template `ref`.** The
   handle is slot content inside `.composer-box`, so the handler uses
   `(e.currentTarget as Element).closest('.composer-box')`. A `ref` placed on
   `<ComposerBox>` yields the child's **component instance** (no `.style`) and
   nothing ever wrote the property.

### The drag handler (ChatInput.vue)

```ts
const DRAG_THRESHOLD = 3;   // px of travel before a drag engages

function onInputHandleDown(e: PointerEvent) {
  const box = boxOf(e.currentTarget as Element);          // closest('.composer-box')
  inputDragging = true; dragMoved = false;
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
  e.preventDefault();
  dragStartY = e.clientY;
  dragStartHeight = box.getBoundingClientRect().height;  // ONE snapshot
}
function onInputHandleMove(e: PointerEvent) {
  const dy = dragStartY - e.clientY;                      // up (clientY shrinks) = grow
  if (!dragMoved) { if (Math.abs(dy) < DRAG_THRESHOLD) return; dragMoved = true; }
  boxOf(e.currentTarget as Element)!.style
    .setProperty('--composer-raw-h', `${dragStartHeight + dy}px`);   // UNCLAMPED
}
```

The anchor is a snapshot taken **once** at pointerdown: the handler never
re-measures a rect that shifts as the box resizes (the old code measured the
*textarea from a handler anchored to the container*, so the first move applied a
~one-chrome jump). Writing the unclamped target lets CSS clamp it, so a drag
that overshoots a bound stays anchored instead of sticking.

Observed (live page, 1280px): band height 141 → **142** (1px) → **143** (2px) →
**147** (10px up) → **127** (10px down); floored at one line, ceiling 320px.

## 5. Invariant — the attachment bar is one line, capsules are content-sized

```css
.attachment-bar { display: flex; flex-wrap: nowrap; height: 32px; overflow: hidden;
                  margin: 0 var(--composer-gutter, 8px); }
.file-chip      { flex: 0 0 auto; width: max-content; max-width: 160px; min-width: 0; }
.file-chip-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attachment-pill{ flex: 0 0 auto; }
```

- One line is structural (`nowrap` + fixed height), never measured.
- The first **2** chips render inline; the rest collapse into `+N 个附件`, which
  opens `AttachmentManager` — the only place the whole queue can be seen and
  pruned.
- `flex: 0 0 auto` + `width: max-content` makes each capsule exactly as wide as
  its content. A previous `flex: 0 1 200px` gave every chip a 200px basis, so a
  short name sat in a wide capsule with a large empty run (measured now: "f0.txt"
  → 54px capsule, 26px name).

## 6. The modal — hand-written, not `<dialog>`

`ModalShell.vue` avoids `showModal()` because its background-scroll handling
varies by engine and the look is platform-specific. Instead:

| concern | how |
|---|---|
| background scroll | `body.style.overflow` locked (prior value captured/restored) **and** the overlay is Teleported to `<body>`, a non-ancestor of the app, so wheel events never reach ChatLog; `overscroll-behavior: contain` on the panel/body stops wheel chaining |
| focus containment | `inert` on `#app` while open (the panel lives outside `#app`) — no hand-rolled Tab cycle |
| focus restore | opener captured on open, refocused on close |
| ESC | one window `keydown` listener, removed on close **and** `onBeforeUnmount` |
| height | `.modal-panel` and `.modal-body` are `flex: 0 1 auto` — the dialog ends at its content (measured: panel 253px, `footerBottom 414` vs `panelBottom 415`) instead of padding out to `max-height` |

The panel is centred in the full-viewport overlay, so there is empty page above
and below it by design; the dialog itself has no internal dead band.

## 7. Verification

There is **no component test harness** in this repo — `vitest.config.ts` is
`environment: 'node'`, `@vue/test-utils`/`happy-dom` are not installed, and
eslint's config only matches `**/*.ts` (`.vue` files are not linted). The gates
are therefore:

1. `npm run typecheck:web` — `vue-tsc` on the SFCs (catches template/prop/emit
   mistakes; this is the only automated component check).
2. `npx vitest run src/tests/loop src/tests/tools src/tests/context` — 1345
   tests, proving the refactor did not touch the backend contract.
3. Manual `--serve` smoke (`agent-browser` is handy):
   - drag the top handle — 1:1 from the first pixel, stops at 40 / 320px;
   - long text scrolls inside the textarea;
   - the floating strip stays bottom-right and never steals the last line;
   - Enter sends, Shift+Enter newlines, paste an image, drop a file;
   - 6 attachments → one line + `+4 个附件` → popup lists all six; ESC closes
     and focus returns; the page behind does not scroll;
   - compact is disabled in auto mode; the warning banner shows with a pending
     card;
   - 详细日志 shows the stage chips.

## 8. Reverting

The split is one commit on top of the pre-split tree; `git revert <sha>` restores
the single `ChatInput.vue`. No store, WS-protocol or `.mycc/` state is involved.
