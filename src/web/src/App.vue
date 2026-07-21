<script setup lang="ts">
import { ref } from 'vue';
import type { ChatState } from './types';
import StatusBar from './components/StatusBar.vue';
import SteeringBuffer from './components/SteeringBuffer.vue';
import ChatLog from './components/ChatLog.vue';
import ChatInput from './components/ChatInput.vue';
import TeammateCard from './components/TeammateCard.vue';
import TeammateDrawer from './components/TeammateDrawer.vue';

defineProps<{ state: ChatState }>();

// Teammate drawer state. The card floats over the chat area and hides when
// the drawer is open. Clicking a teammate row opens the drawer with that
// teammate's accordion expanded. See the "@-prefix teammate label
// convention" section in MYCC.md.
const drawerOpen = ref(false);
const initiallyExpanded = ref('');

function openDrawer(name: string): void {
  initiallyExpanded.value = name;
  drawerOpen.value = true;
}

function closeDrawer(): void {
  drawerOpen.value = false;
}
</script>

<template>
  <div class="app-container">
    <StatusBar :state="state" />
    <SteeringBuffer :notes="state.steeringBuffer" />
    <div class="middle-section">
      <ChatLog
        :messages="state.messages"
        :state="state"
      />
      <TeammateCard
        v-if="!drawerOpen && state.teammateMessages.length > 0"
        :teammate-messages="state.teammateMessages"
        @open-teammate="openDrawer"
      />
      <TeammateDrawer
        v-if="drawerOpen"
        :teammate-messages="state.teammateMessages"
        :initially-expanded="initiallyExpanded"
        @close="closeDrawer"
      />
    </div>
    <ChatInput :state="state" />
  </div>
</template>

<style scoped>
.app-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-app);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  margin: 0;
}
/* Middle section holds the chat log, the floating teammate card, and the
   right-half teammate drawer. The chat log takes the remaining width; the
   drawer is 50% of this section (set in TeammateDrawer.vue). The card is
   position:absolute so it floats over the chat log without affecting its
   layout. */
.middle-section {
  flex: 1;
  display: flex;
  position: relative;
  overflow: hidden;
}
</style>