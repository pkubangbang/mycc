<script setup lang="ts">
import type { ChatState } from './types';
import StatusBar from './components/StatusBar.vue';
import SteeringBuffer from './components/SteeringBuffer.vue';
import ChatLog from './components/ChatLog.vue';
import ChatInput from './components/ChatInput.vue';

defineProps<{ state: ChatState }>();
</script>

<template>
  <div class="app-container">
    <StatusBar :state="state" />
    <SteeringBuffer :notes="state.steeringBuffer" />
    <ChatLog :messages="state.messages" :state="state" />
    <ChatInput :state="state" />
  </div>
</template>

<style scoped>
.app-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #ededed; /* WeChat background gray */
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  margin: 0;
}
</style>