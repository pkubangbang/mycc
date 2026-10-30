<script setup lang="ts">
import { ref } from 'vue';
import type { CardPayload } from '../types';
import { chatApi } from '../main';

const props = defineProps<{ card: CardPayload }>();

// Whether this card has already received a response. Once true, the card
// greys out and disables all interactive elements to prevent double-submit.
const responded = ref(false);

// Local model for the 'input' kind textarea.
const inputValue = ref(props.card.initialContent ?? '');

function submitInput(): void {
  if (responded.value) return;
  const value = inputValue.value.trim();
  if (!value) return;
  chatApi.sendCardResponse(props.card.cardId, value);
  responded.value = true;
}

function selectOption(value: string): void {
  if (responded.value) return;
  chatApi.sendCardResponse(props.card.cardId, value);
  responded.value = true;
}

// ── Refusal with a reason (split "No" button) ──
//
// The CLI accepts free text at a confirm prompt: anything that is not
// y/yes/n/no is treated as FEEDBACK ("User did not confirm … User's response:
// '…'") and handed back to the model, so the user can decline AND say why in
// one gesture. A bare button token cannot express that, so the negative option
// becomes a split button whose dropdown reveals a textarea.
const reasonOpen = ref(false);

/** The negative option: the last one, or whichever matches n/no/[N]. */
function isNegativeOption(value: string, label: string): boolean {
  return /^(n|no)$/i.test(value.trim()) || /^no$/i.test(label.trim());
}

function toggleReason(): void {
  if (responded.value) return;
  reasonOpen.value = !reasonOpen.value;
}

/** Submit the refusal text as the card's response (the tool reads it as
 *  feedback, exactly like the CLI's "n: <reason>" style free text). */
function submitReason(): void {
  if (responded.value) return;
  const reason = inputValue.value.trim();
  if (!reason) return;
  chatApi.sendCardResponse(props.card.cardId, reason);
  responded.value = true;
  reasonOpen.value = false;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submitInput();
  }
}

/** Same rule for the refusal reason: Enter submits, Shift+Enter adds a line. */
function onReasonKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submitReason();
  }
}
</script>

<template>
  <div class="card-row">
    <div class="card-bubble" :class="{ responded }">
      <div class="card-query">{{ card.query }}</div>

      <!-- input kind: textarea + submit -->
      <template v-if="card.kind === 'input'">
        <textarea
          v-model="inputValue"
          class="card-input"
          :placeholder="card.placeholder ?? '输入内容…'"
          :disabled="responded"
          rows="3"
          @keydown="onKeydown"
        ></textarea>
        <button
          class="card-submit"
          :disabled="responded || !inputValue.trim()"
          @click="submitInput"
        >提交</button>
      </template>

      <!-- notice kind: instruction + single OK button, NO free-text input.
           Used by /load & --from DOSQ confirmations where the user just
           needs to review/edit an external file then acknowledge — a
           textarea would be useless and misleading here. -->
      <template v-else-if="card.kind === 'notice'">
        <div class="card-options">
          <button
            v-for="opt in card.options"
            :key="opt.value"
            class="card-option-btn"
            :class="{ 'card-option-default': opt.isDefault }"
            :disabled="responded"
            @click="selectOption(opt.value)"
          >{{ opt.label }}</button>
        </div>
      </template>

      <!-- choice kind: option buttons ONLY, NO free-text input.
           choice cards come from queries with a trailing [?/?] bracket
           suffix (e.g. [1/2/3/4] for external-path-access grants, [y/N] for
           yes/no prompts). The backend only parses the bracket tokens — any
           free text falls through to a default/deny and is silently
           discarded, so offering a textarea here is misleading. The user
           must pick one of the buttons.
           EXCEPTION: a NEGATIVE option is a SPLIT button — its caret reveals a
           reason textarea, because "No, because …" is meaningful feedback the
           tool can act on (see submitReason). -->
      <template v-else-if="card.kind === 'choice'">
        <div class="card-options">
          <template v-for="opt in card.options" :key="opt.value">
            <div
              v-if="isNegativeOption(opt.value, opt.label)"
              class="card-split"
            >
              <button
                class="card-option-btn card-split-main"
                :class="{ 'card-option-default': opt.isDefault }"
                :disabled="responded"
                @click="selectOption(opt.value)"
              >{{ opt.label }}</button>
              <button
                class="card-option-btn card-split-caret"
                :class="{ 'card-option-default': opt.isDefault }"
                :disabled="responded"
                :aria-expanded="reasonOpen"
                :title="reasonOpen ? '收起理由' : '输入拒绝理由'"
                @click="toggleReason"
              >▾</button>
            </div>
            <button
              v-else
              class="card-option-btn"
              :class="{ 'card-option-default': opt.isDefault }"
              :disabled="responded"
              @click="selectOption(opt.value)"
            >{{ opt.label }}</button>
          </template>
        </div>
        <div v-if="reasonOpen && !responded" class="card-reason">
          <textarea
            v-model="inputValue"
            class="card-input card-input-below"
            placeholder="写下拒绝的理由，Enter 提交，Shift+Enter 换行…"
            rows="2"
            @keydown="onReasonKeydown"
          ></textarea>
        </div>
      </template>

      <!-- confirm kind: option buttons + free-text input.
           confirm cards have no [?/?] bracket — they use Continue/Cancel
           buttons but the free-text textarea is retained so the user can
           type a custom response (e.g. git_commit feedback, a custom file
           path for plan_on) instead of clicking a button. -->
      <template v-else>
        <div class="card-options">
          <template v-for="opt in card.options" :key="opt.value">
            <div
              v-if="isNegativeOption(opt.value, opt.label)"
              class="card-split"
            >
              <button
                class="card-option-btn card-split-main"
                :class="{ 'card-option-default': opt.isDefault }"
                :disabled="responded"
                @click="selectOption(opt.value)"
              >{{ opt.label }}</button>
              <button
                class="card-option-btn card-split-caret"
                :class="{ 'card-option-default': opt.isDefault }"
                :disabled="responded"
                :aria-expanded="reasonOpen"
                :title="reasonOpen ? '收起理由' : '输入拒绝理由'"
                @click="toggleReason"
              >▾</button>
            </div>
            <button
              v-else
              class="card-option-btn"
              :class="{ 'card-option-default': opt.isDefault }"
              :disabled="responded"
              @click="selectOption(opt.value)"
            >{{ opt.label }}</button>
          </template>
        </div>
        <!-- The refusal reason takes over the free-text box: once the user asks
             for a reason, the textarea belongs to the "No, because …" path. -->
        <div v-if="reasonOpen && !responded" class="card-reason">
          <textarea
            v-model="inputValue"
            class="card-input card-input-below"
            placeholder="写下拒绝的理由，Enter 提交，Shift+Enter 换行…"
            rows="2"
            @keydown="onReasonKeydown"
          ></textarea>
        </div>
        <template v-else>
          <textarea
            v-model="inputValue"
            class="card-input card-input-below"
            :placeholder="card.placeholder ?? '或输入自定义内容…'"
            :disabled="responded"
            rows="2"
            @keydown="onKeydown"
          ></textarea>
          <button
            class="card-submit"
            :disabled="responded || !inputValue.trim()"
            @click="submitInput"
          >提交</button>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.card-row {
  display: flex;
  justify-content: center;
  padding: 4px 16px;
  margin: 2px 0;
}
.card-bubble {
  max-width: 80%;
  padding: 12px 16px;
  border-radius: 10px;
  background: var(--bubble-prompt-bg);
  color: var(--bubble-prompt-text);
  border: 1px solid var(--bubble-prompt-border);
  transition: opacity 0.2s, filter 0.2s;
}
.card-bubble.responded {
  opacity: 0.55;
  filter: grayscale(0.6);
  pointer-events: none;
}
.card-query {
  font-size: 14px;
  line-height: 1.5;
  margin-bottom: 10px;
  white-space: pre-wrap;
  word-break: break-word;
}
.card-input {
  width: 100%;
  resize: none;
  border: 1px solid var(--border-input);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 14px;
  font-family: inherit;
  line-height: 1.5;
  outline: none;
  background: var(--bg-input-field);
  color: var(--text-primary);
  box-sizing: border-box;
}
.card-input:focus {
  border-color: var(--accent);
}
.card-input:disabled {
  background: var(--bg-input-field-disabled);
  color: var(--text-input-disabled);
}
.card-submit {
  margin-top: 8px;
  background: var(--accent);
  color: var(--accent-text);
  border: none;
  padding: 6px 18px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  transition: opacity 0.15s;
}
.card-submit:not(:disabled):hover {
  opacity: 0.85;
}
.card-submit:disabled {
  background: var(--accent-disabled);
  cursor: not-allowed;
}
.card-options {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.card-option-btn {
  background: var(--bg-input-field);
  color: var(--bubble-prompt-text);
  border: 1px solid var(--bubble-prompt-border);
  padding: 6px 20px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  transition: background 0.15s;
}
.card-option-btn:not(:disabled):hover {
  background: var(--bubble-prompt-bg);
}
.card-option-btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
/* Default option (uppercase letter in the bracket suffix, e.g. [y/N] → No):
   accent border + bold font so the safe/expected choice stands out. */
.card-option-btn.card-option-default {
  border-color: var(--accent);
  font-weight: 600;
}
/* Free-text input rendered below the option buttons (confirm cards only). */
.card-input.card-input-below {
  margin-top: 10px;
  font-size: 13px;
}
/* ── Split button (the negative option) ──
   Main half = the plain "No"; caret half reveals the reason textarea. The two
   halves share one rounded outline: the main button keeps the left corners,
   the caret the right ones, and the seam is a 1px divider instead of a gap. */
.card-split {
  display: inline-flex;
  align-items: stretch;
}
.card-split-main {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.card-split-caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  padding: 6px 8px;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
  /* Overlap the main button's right border by 1px so the seam is one line. */
  margin-left: -1px;
  font-size: 11px;
  line-height: 1;
}
/* Reason box under the split button. Visually tied to the option row it
   belongs to (accent left rule) so it reads as "the reason for No". */
.card-reason {
  margin-top: 10px;
  padding-left: 10px;
  border-left: 2px solid var(--accent);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.card-reason .card-submit {
  margin-top: 8px;
}
</style>