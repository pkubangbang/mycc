<script setup lang="ts">
/**
 * SteeringReviewCard.vue - Temporary "继续…" card surfacing pending steering
 *
 * When the agent reaches PROMPT with steering notes STILL PENDING in the
 * backend queue (notes the agent never consumed — they were neither drained
 * at COLLECT nor synthesized at PROMPT), main.ts moves them from
 * `state.steeringBuffer` into `state.pendingSteeringReview` at the moment
 * the 'prompt' message flips isWaiting true. This card then renders at the
 * tail of the chat log flow — in the same visual spot as other question
 * cards — and asks the user to decide what to do with those notes:
 *
 *   • 发送为查询 — combine all remaining notes (joined by a blank line) and
 *     send them as a fresh PROMPT query (type:'input'). The agent receives
 *     the combined text as its next user message.
 *   • 丢弃此条 (per-note × button) — discard a single note. If all notes are
 *     discarded, the card auto-hides and the normal input box re-enables.
 *   • 全部丢弃 — discard every note at once.
 *
 * The card is purely transient: it is NOT stored in `state.messages`, so it
 * never persists to the chat record, survives no refresh, and auto-disappears
 * the moment `pendingSteeringReview` is empty or `isWaiting` flips false. The
 * actual state mutations (send/discard) are performed by the parent
 * (ChatLog.vue) via the emitted events — this component only renders the
 * notes and emits the user's choice.
 *
 * NOTE: notes that the agent ALREADY consumed (drained at COLLECT as a
 * REMINDER, or synthesized into a fresh query at PROMPT) do NOT appear here —
 * a 'steer-flush' clears the buffer bar without populating this card. This
 * card is strictly for the "stuck in PROMPT" case the user reported.
 */
defineProps<{ notes: string[] }>();

const emit = defineEmits<{
  (e: 'send-as-query'): void;
  (e: 'discard-note', index: number): void;
  (e: 'discard-all'): void;
}>();

function sendAsQuery(): void {
  emit('send-as-query');
}

function discardNote(index: number): void {
  emit('discard-note', index);
}

function discardAll(): void {
  emit('discard-all');
}
</script>

<template>
  <div class="card-row">
    <div class="card-bubble steering-card">
      <div class="card-query">
        继续… 以下转向消息尚未提交，请选择发送为查询或丢弃：
      </div>
      <div class="steering-notes">
        <div
          v-for="(note, i) in notes"
          :key="i"
          class="steering-note"
        >
          <span class="steering-note-text" :title="note">{{ note }}</span>
          <button
            class="steering-note-discard"
            title="丢弃此条"
            @click="discardNote(i)"
          >&times;</button>
        </div>
      </div>
      <div class="steering-actions">
        <button
          class="card-submit"
          :disabled="notes.length === 0"
          @click="sendAsQuery"
        >发送为查询</button>
        <button
          class="card-option-btn"
          :disabled="notes.length === 0"
          @click="discardAll"
        >全部丢弃</button>
      </div>
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
}
/* Amber accent distinguishes this review card from a normal ask() card. */
.steering-card {
  background: color-mix(in srgb, #f59e0b 10%, var(--bubble-prompt-bg));
  border-color: color-mix(in srgb, #f59e0b 45%, var(--bubble-prompt-border));
}
.card-query {
  font-size: 14px;
  line-height: 1.5;
  margin-bottom: 10px;
  white-space: pre-wrap;
  word-break: break-word;
}
.steering-notes {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}
.steering-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  background: color-mix(in srgb, #f59e0b 12%, transparent);
  border: 1px solid color-mix(in srgb, #f59e0b 30%, transparent);
  border-radius: 6px;
  padding: 6px 10px;
}
.steering-note-text {
  flex: 1;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-primary);
}
.steering-note-discard {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 16px;
  line-height: 1;
  padding: 0 2px;
  cursor: pointer;
  transition: color 0.15s;
}
.steering-note-discard:hover {
  color: #ef4444;
}
.steering-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.card-submit {
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
.card-option-btn {
  background: var(--bg-input-field);
  color: var(--bubble-prompt-text);
  border: 1px solid var(--bubble-prompt-border);
  padding: 6px 18px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s;
}
.card-option-btn:not(:disabled):hover {
  background: var(--bubble-prompt-bg);
}
.card-option-btn:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
</style>