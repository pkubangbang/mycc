<script setup lang="ts">
/**
 * SteeringBuffer.vue - Buffer bar showing queued steering notes
 *
 * Displays mid-task steering notes the user sent while the LLM was working.
 * The notes are buffered in `state.steeringBuffer` (populated by 'steer-echo'
 * WS messages from the backend) and cleared on a 'steer-flush' WS message
 * (when the backend consumes the notes at COLLECT or synthesizes them at
 * PROMPT). Rendered as a thin amber chip bar between StatusBar and ChatLog.
 */
defineProps<{ notes: string[] }>();
</script>

<template>
  <div v-if="notes.length > 0" class="steering-buffer">
    <span class="sb-label">🧭 转向</span>
    <div class="sb-chips">
      <span v-for="(note, i) in notes" :key="i" class="sb-chip" :title="note">{{ note }}</span>
    </div>
  </div>
</template>

<style scoped>
.steering-buffer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  background: #fff3cd;
  border-bottom: 1px solid #ffe082;
  flex-shrink: 0;
  overflow-x: auto;
}
.sb-label {
  font-size: 12px;
  color: #856404;
  white-space: nowrap;
  font-weight: 600;
}
.sb-chips {
  display: flex;
  gap: 6px;
  overflow-x: auto;
}
.sb-chip {
  background: #ffe082;
  color: #665500;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
  white-space: nowrap;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>