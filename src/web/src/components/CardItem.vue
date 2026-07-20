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

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submitInput();
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

      <!-- confirm / choice kind: option buttons -->
      <template v-else>
        <div class="card-options">
          <button
            v-for="opt in card.options"
            :key="opt.value"
            class="card-option-btn"
            :disabled="responded"
            @click="selectOption(opt.value)"
          >{{ opt.label }}</button>
        </div>
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
  background: #e6f7ff;
  color: #003a8c;
  border: 1px solid #91d5ff;
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
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 14px;
  font-family: inherit;
  line-height: 1.5;
  outline: none;
  background: #fff;
  box-sizing: border-box;
}
.card-input:focus {
  border-color: #07c160;
}
.card-input:disabled {
  background: #f0f0f0;
  color: #999;
}
.card-submit {
  margin-top: 8px;
  background: #07c160;
  color: #fff;
  border: none;
  padding: 6px 18px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.card-submit:disabled {
  background: #a0d8b6;
  cursor: not-allowed;
}
.card-options {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.card-option-btn {
  background: #fff;
  color: #003a8c;
  border: 1px solid #91d5ff;
  padding: 6px 20px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  transition: background 0.15s;
}
.card-option-btn:not(:disabled):hover {
  background: #bae7ff;
}
.card-option-btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
</style>