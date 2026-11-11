<script setup lang="ts">
/**
 * MagicQueryDialog.vue — the popup behind the magic-wand button (魔法查询).
 *
 * The wand replaces the old one-click 压缩上下文 icon: instead of firing a
 * compaction immediately, it opens a LIST of magic queries. Most rows are
 * one-shot — clicking sends the slash text through the normal input path,
 * exactly as if typed.
 *
 * THE UI DEFERS TO THE SLASH COMMAND. `/auto-commit` is not a one-liner: it is
 * a slash command with sub-commands, so its row expands in place into a small
 * editor shaped like those sub-commands — and every ACTION IS a slash command:
 *
 *     add:  [ branch :autoAdd? ]  [ 添加 ]        → /auto-commit on <branch>
 *     ─────────────────────────────────────────
 *     当前允许的分支:
 *       - main:autoAdd   [ 移除 ]                 → /auto-commit off main
 *       - dev            [ 移除 ]                 → /auto-commit off dev
 *     [ 全部移除（禁止所有自动提交） ]            → /auto-commit off --all
 *
 * THERE IS NO 提交 BUTTON. Each removal IS the submission — the slash goes out
 * on the click — so the panel can never show an edit that was never applied.
 * The list re-renders from the backend's reply, which is the confirmation.
 *
 * ADDING is the same, one field later: type a branch, press Enter or 添加, and
 * the slash goes out; the panel closes and the next open shows the backend's
 * list. There is no optimistic row — see the note on `rows` below.
 *
 * The list is seeded from the backend on expand (`/auto-commit` with no
 * argument is not enough — it PRINTS, so the dialog asks with a dedicated read),
 * and kept current by the broadcast every writer now fires.
 *
 * Still a pure capability-props view: no ChatState, no direct socket access —
 * the shell owns `runQuery`, `loadAutoCommit` and the list prop.
 *
 * Built on ModalShell (our own modal, not <dialog>) so background scroll,
 * focus containment and focus restore behave the same on every engine.
 */
import { ref, watch } from 'vue';
import ModalShell from '../common/ModalShell.vue';

/** A row in the magic-query dialog. */
export interface MagicQuery {
  /** The slash command text sent through the normal input path. */
  query: string;
  /** One-line human explanation shown next to the query. */
  description: string;
  /**
   * Present when the command takes ARGUMENTS: the row expands into an editor
   * instead of submitting immediately. The name selects the editor shape, so
   * a second argument-taking command does not need a boolean of its own.
   */
  editor?: 'auto-commit';
}

/** Separator + suffix of an allow-list entry, mirroring auto-state.ts. */
const AUTO_ADD_SEPARATOR = ':';
const AUTO_ADD_SUFFIX = 'autoAdd';

const props = defineProps<{
  open: boolean;
  /** Queries to list, in display order. */
  queries: MagicQuery[];
  /** Whether a row may be executed right now. The wand button is disabled
   *  under the same condition, but the dialog can outlive a state change
   *  (e.g. auto mode engages while it is open), so the gate is repeated here. */
  runnable: boolean;
  /** The LIVE auto-commit allow-list (encoded), mirrored from the backend.
   *  `null` = not known yet, or the backend has no provider — rendered as
   *  "unknown", never as an empty (deny-all) list. */
  autoCommitBranches: string[] | null;
  /** Ask the backend for the live list now (the editor's seed). */ loadAutoCommit: () => void;
  /** Send one composed slash command — the ONLY write path. */
  runQuery: (query: string) => void;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

// ── auto-commit editor state ───────────────────────────────────────────────
/** The expanded row (null = the plain list). Only one may be open at a time. */
const expanded = ref<string | null>(null);
/** The add-field's text; may be `branch` or `branch:autoAdd`. */
const addText = ref('');
/**
 * Why the last `添加` click did nothing, when it did nothing for a reason the
 * user cannot see (currently: the branch is already listed). Empty = no hint.
 */
const addHint = ref('');
/**
 * The rendered rows: a plain mirror of the live list.
 *
 * There is deliberately NO optimistic insert. Every write closes the dialog on
 * the same click (the slash flips the phase to 'submitted', so the panel would
 * be an inert modal of disabled controls), so a row appended locally could
 * never be seen — it would only ever be a phantom grant that outlived the
 * dialog. The list the user sees next time comes from the backend.
 */
const rows = ref<string[]>([]);

watch(
  () => props.autoCommitBranches,
  (live) => {
    // `null` = the backend has no allow-list provider. Render nothing rather
    // than an empty list, so "unknown" is never shown as "deny-all".
    rows.value = live ? [...live] : [];
  },
  { immediate: true, deep: true }
);

function expand(q: MagicQuery): void {
  if (!props.runnable) return;
  if (!q.editor) {
    // Close BEFORE running: the dialog marks #app inert while open, and the
    // slash this sends flips the phase to 'submitted' — so staying open would
    // strand the user in a dead modal whose every row is now disabled.
    emit('close');
    props.runQuery(q.query);
    return;
  }
  if (expanded.value === q.query) {
    collapse();
    return;
  }
  expanded.value = q.query;
  addText.value = '';
  addHint.value = '';
  rows.value = props.autoCommitBranches ? [...props.autoCommitBranches] : [];
  // Refresh: another tab, or the terminal, may have edited the list since the
  // last frame arrived. Every writer broadcasts now, so this is a safety net
  // rather than the only update path.
  props.loadAutoCommit();
}

function collapse(): void {
  expanded.value = null;
  addText.value = '';
  addHint.value = '';
}

/** Split an encoded entry into its branch and autoAdd flag. */
function decode(entry: string): { branch: string; autoAdd: boolean } {
  const at = entry.lastIndexOf(AUTO_ADD_SEPARATOR);
  if (at > 0 && entry.slice(at + 1).trim() === AUTO_ADD_SUFFIX) {
    return { branch: entry.slice(0, at).trim(), autoAdd: true };
  }
  return { branch: entry.trim(), autoAdd: false };
}

function encode(branch: string, autoAdd: boolean): string {
  return autoAdd ? `${branch}${AUTO_ADD_SEPARATOR}${AUTO_ADD_SUFFIX}` : branch;
}

/**
 * Whether a branch name is safe to splice into a slash command.
 *
 * The commands are a TEXT protocol, so a name that looks like a FLAG changes
 * their meaning: an entry literally named `--all` (possible via
 * `--allow-auto-commit --all`, which only splits on commas) would make a single
 * 移除 clear the WHOLE list, and a name containing a comma would grant or
 * revoke several branches at once. Such rows are rendered but cannot be acted
 * on from the dialog — the user must use the terminal, where the name is typed
 * explicitly.
 */
function isSafeForSlash(branch: string): boolean {
  return branch.length > 0 && !branch.startsWith('-') && !branch.includes(',');
}

/** `添加` — composes `/auto-commit on <branch>[:autoAdd]` and sends it. */
function addBranch(): void {
  // The first write ends the slash window (phase → 'submitted'), so every
  // write re-checks the gate instead of trusting the button's disabled state.
  if (!props.runnable) return;
  // In the 未知 (null) state the list is not rendered, so an add would have no
  // visible list to land in — the click would look like a no-op.
  // Refuse instead of pretending: the user must reload the list first.
  if (props.autoCommitBranches === null) return;
  const { branch, autoAdd } = decode(addText.value);
  if (!branch) return;
  if (!isSafeForSlash(branch)) return;
  // An exact-duplicate branch name is already listed, so an `on <branch>`
  // would be a no-op on the allow-list. Say so instead of silently eating the
  // click (the terminal path `on main:autoAdd` WOULD upgrade the grant, so a
  // silent no-op here is actively misleading).
  if (rows.value.some((e) => decode(e).branch === branch)) {
    addHint.value = '该分支已在列表中';
    return;
  }
  addText.value = '';
  addHint.value = '';
  const entry = encode(branch, autoAdd);
  // CLOSE BEFORE RUNNING, same as a one-shot row: the slash flips the phase to
  // 'submitted', so `runnable` goes false the moment it is sent. Staying open
  // would leave an inert-blocked modal whose every control is now disabled.
  emit('close');
  props.runQuery(`/auto-commit on ${entry}`);
}

/** `移除` — composes `/auto-commit off <branch>` and sends it on the click. */
function removeBranch(entry: string): void {
  if (!props.runnable) return;
  const { branch } = decode(entry);
  // Never let a flag-shaped / comma-containing name rewrite the command.
  if (!isSafeForSlash(branch)) return;
  emit('close');
  props.runQuery(`/auto-commit off ${branch}`);
}

/** `全部移除` — composes `/auto-commit off --all` and sends it on the click. */
function removeAll(): void {
  if (!props.runnable) return;
  emit('close');
  props.runQuery('/auto-commit off --all');
}

/** Close everything (the dialog's own close path). */
function closeAll(): void {
  collapse();
  emit('close');
}

/**
 * ESC on a query row: collapse the editor if this row is expanded, otherwise
 * close the dialog.
 *
 * `.stop` is on the template binding, so an unconditional expression here
 * would swallow ESC on every row — `ModalShell` listens on `window`, and a
 * stopped event never reaches it, leaving the dialog unclosable from the
 * keyboard whenever focus sat inside a row.
 */
function onRowEscape(q: MagicQuery): void {
  if (expanded.value === q.query) {
    collapse();
    return;
  }
  closeAll();
}

// A closed dialog must not keep a stale draft for the next open.
watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) collapse();
  }
);
</script>

<template>
  <ModalShell :open="props.open" title="魔法查询" :max-width="560" @close="closeAll">
    <ul class="mq-list">
      <li v-for="q in props.queries" :key="q.query" class="mq-item" @keydown.esc.stop="onRowEscape(q)">
        <button v-if="expanded !== q.query" class="mq-row" :disabled="!props.runnable" @click="expand(q)">
          <span class="mq-query">{{ q.query }}</span>
          <span class="mq-desc">{{ q.description }}</span>
          <span v-if="q.editor" class="mq-chevron" aria-hidden="true">›</span>
        </button>

        <!-- Expanded editor: every action below IS a slash command. -->
        <div v-else class="mq-editor">
          <div class="mq-editor-head">
            <span class="mq-query">{{ q.query }}</span>
            <button class="mq-link" @click="collapse">收起</button>
          </div>

          <div class="mq-add">
            <label class="mq-add-label" for="mq-add-input">添加：</label>
            <input
              id="mq-add-input"
              v-model="addText"
              class="mq-add-input"
              @input="addHint = ''"
              type="text"
              placeholder="分支名，可加 :autoAdd"
              :disabled="!props.runnable"
              @keydown.enter.prevent="addBranch"
            />
            <button
              class="mq-add-ok"
              :disabled="!props.runnable || props.autoCommitBranches === null || !addText.trim()"
              @click="addBranch"
            >
              添加
            </button>
          </div>
          <div v-if="addHint" class="mq-hint">{{ addHint }}</div>

          <div class="mq-section-title">当前允许的分支：</div>
          <div v-if="props.autoCommitBranches === null" class="mq-empty">未知（后端未提供白名单）</div>
          <ul v-else-if="rows.length > 0" class="mq-branches">
            <li v-for="entry in rows" :key="decode(entry).branch" class="mq-branch">
              <span class="mq-branch-name">{{ decode(entry).branch }}</span>
              <span v-if="decode(entry).autoAdd" class="mq-badge" title="无需 auto 模式也跳过询问">autoAdd</span>
              <button
                class="mq-link mq-remove"
                :disabled="!props.runnable || !isSafeForSlash(decode(entry).branch)"
                :title="
                  isSafeForSlash(decode(entry).branch) ? undefined : '该名称无法安全地作为斜杠命令参数，请在终端操作'
                "
                @click="removeBranch(entry)"
              >
                移除
              </button>
            </li>
          </ul>
          <div v-else class="mq-empty">（空）</div>

          <div class="mq-editor-actions">
            <button class="mq-clear-all" :disabled="!props.runnable || rows.length === 0" @click="removeAll">
              全部移除（禁止所有自动提交）
            </button>
          </div>

          <!--
            The auto-mode coupling, spelled out where the list is edited: the
            allow-list is only HALF of the commit gate, and the other half is a
            mode switch the user cannot see from inside this dialog.
          -->
          <div class="mq-note">
            <div class="mq-note-title">与 auto 模式的关系</div>
            <p>
              白名单只是提交闸门的一半：普通分支（如 <code>dev</code>）只有在<strong>auto 模式开启</strong>时才会跳过
              <code>git_commit</code> 的询问；plan 模式会覆盖任何授权。
            </p>
            <p>
              只有带 <code>:autoAdd</code> 后缀的分支（以及启动参数 <code>--allow-auto-commit</code> 授予的分支）无需
              auto 模式即可自动提交。
            </p>
            <p class="mq-note-dim">
              这里的添加 / 移除 / 全部移除都不会改变 auto 模式；要自动提交，请另外开启（闪电按钮或
              <code>/auto</code>）。
            </p>
          </div>
        </div>
      </li>
    </ul>
    <template #footer>
      <button class="mq-cancel" @click="closeAll">取消</button>
    </template>
  </ModalShell>
</template>

<style scoped>
.mq-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.mq-item {
  display: flex;
  flex-direction: column;
}
.mq-row {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 8px 10px;
  text-align: left;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-input-field);
  color: var(--text-primary);
  cursor: pointer;
  position: relative;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.mq-row:not(:disabled):hover {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, var(--bg-input-field));
}
.mq-row:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.mq-query {
  font-size: 13px;
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  color: var(--accent);
}
.mq-desc {
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted);
}
.mq-chevron {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
  font-size: 16px;
}

/* ── expanded editor ── */
.mq-editor {
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--accent) 6%, var(--bg-input-field));
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mq-editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.mq-add {
  display: flex;
  align-items: center;
  gap: 6px;
}
.mq-add-label {
  font-size: 12px;
  color: var(--text-muted);
  flex-shrink: 0;
}
.mq-add-input {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  color: var(--text-primary);
  background: var(--bg-input);
  border: 1px solid var(--border-color);
  border-radius: 5px;
}
.mq-add-input:focus {
  outline: none;
  border-color: var(--accent);
}
.mq-add-ok {
  flex-shrink: 0;
  padding: 4px 12px;
  font-size: 12px;
  border-radius: 5px;
  border: 1px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--text-primary);
  cursor: pointer;
}
.mq-add-ok:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.mq-section-title {
  font-size: 12px;
  color: var(--text-muted);
  padding-top: 2px;
  border-top: 1px solid var(--border-color);
}
.mq-branches {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 160px;
  overflow-y: auto;
}
.mq-branch {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
.mq-branch-name {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  color: var(--text-primary);
}
.mq-badge {
  font-size: 10px;
  padding: 0 4px;
  border-radius: 3px;
  border: 1px solid var(--border-color);
  color: var(--text-muted);
}
.mq-remove {
  margin-left: auto;
}
.mq-hint {
  margin: 2px 0 0 0;
  font-size: 12px;
  opacity: 0.7;
}

.mq-empty {
  font-size: 12px;
  color: var(--text-muted);
  padding-left: 2px;
}
.mq-editor-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.mq-clear-all {
  padding: 5px 10px;
  font-size: 12px;
  border-radius: 5px;
  border: 1px solid var(--border-color);
  background: none;
  color: var(--text-muted);
  cursor: pointer;
}
.mq-clear-all:not(:disabled):hover {
  color: #e5534b;
  border-color: #e5534b;
}
.mq-clear-all:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.mq-link {
  background: none;
  border: none;
  padding: 0 2px;
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
}
.mq-link:hover {
  color: var(--accent);
}
.mq-cancel {
  background: none;
  border: 1px solid var(--border-color);
  color: var(--text-muted);
  border-radius: 6px;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
}
.mq-cancel:hover {
  color: var(--text-primary);
}
/* ── auto-mode coupling note (below 全部移除) ── */
.mq-note {
  border-top: 1px solid var(--border-color);
  padding-top: 6px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-muted);
}
.mq-note-title {
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 2px;
}
.mq-note p {
  margin: 0 0 4px;
}
.mq-note-dim {
  opacity: 0.75;
}
.mq-note code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  padding: 0 3px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--text-muted) 14%, transparent);
}
</style>
