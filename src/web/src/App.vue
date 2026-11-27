<script setup lang="ts">
import { ref } from 'vue';
import type { ChatState } from './types';
import StatusBar from './components/StatusBar.vue';
import SteeringBuffer from './components/SteeringBuffer.vue';
import ChatLog from './components/ChatLog.vue';
import ChatInput from './components/ChatInput.vue';
import TeammateCard from './components/TeammateCard.vue';
import TeammateDrawer from './components/TeammateDrawer.vue';
import TodoCard from './components/TodoCard.vue';
import DebugPanel from './components/DebugPanel.vue';
import ImageViewer from './components/ImageViewer.vue';
import { installViewportHeight } from './composables/useViewportHeight';

defineProps<{ state: ChatState }>();

// Size the shell from the VISIBLE viewport (window.visualViewport) instead of
// `100vh`, so the composer stays above the Android soft keyboard and never
// hides under the IME. Installed once at module scope (idempotent, see the
// composable) rather than in onMounted: the property must be live even if this
// component fails to mount, and there is nothing to tear down.
installViewportHeight();

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
    <DebugPanel v-if="state.debugMode" :state="state" />
    <div class="middle-section" :class="{ 'has-team-card': !drawerOpen && state.teammateMessages.length > 0 }">
      <ChatLog :messages="state.messages" :state="state" />
      <TodoCard :messages="state.messages" />
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
    <!-- Dedicated full-screen image viewer popup. Mounted once here so it
         overlays the whole app regardless of which chat bubble's image was
         clicked. Opens on a window `open-image-viewer` CustomEvent emitted
         by MessageItem's markdown image click handler. -->
    <ImageViewer />
  </div>
</template>

<style scoped>
.app-container {
  display: flex;
  flex-direction: column;
  /* `--app-vh` is written by composables/useViewportHeight.ts from
     window.visualViewport (falls back to innerHeight, then `100vh`). The
     100dvh fallback is the pre-JS, mobile-toolbar-aware value. Using the
     visible height — not the layout viewport — keeps the composer above the
     Android soft keyboard. */
  height: 100vh;
  height: 100dvh;
  height: var(--app-vh, 100dvh);
  /* Belt and braces against a WHITE strip at the bottom: the visible height
     can be fractional, so never let the shell exceed it (the column is a flex
     container, so shrinking only squeezes the chat log). */
  max-height: var(--app-vh, 100dvh);
  overflow: hidden;
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
  /* --team-card-clearance is the card's FOOTPRINT measured from the right
     edge: `right` offset (16px) + card width. --team-card-gap is the breathing
     room between the assistant bubble's right edge and the card's left edge.
     MessageItem reserves `gap + clearance` as right padding on non-user rows,
     so the bubble stops `gap` px short of the card. Arithmetic (wide card
     180px, right:16px): clearance = 16 + 180 = 196; card left edge sits at
     viewportRight − 196; bubble right edge = viewportRight − (gap + clearance)
     = viewportRight − (8 + 196); gap between them = 8px. Both numbers are 0
     when the card is hidden (drawer open or no teammates), so the rule is a
     genuine no-op then. User (right-aligned) rows are excluded — they stay
     flush right. Consumed by MessageItem (padding-right) and TeammateCard
     (max-width, derived from the same clearance). */
  --team-card-clearance: 0px;
  /* Breathing room between the assistant bubble's right edge and the card's
     left edge. Single owner for the gap — MessageItem consumes this var, not
     a hard-coded literal. */
  --team-card-gap: 8px;
}
.middle-section.has-team-card {
  /* Wide card is 180px at right:16px → footprint 196px. */
  --team-card-clearance: 196px;
  /* While the card is visible, lift the assistant bubble's aesthetic 80%
     width cap to 100%: the reserved clearance gutter already keeps bubbles
     clear of the card, so the cap would only waste the reclaimed width
     (a dead band on phones). Inherited down to MessageItem's .message-col.
     Reset to 80% implicitly when this class is absent. */
  --team-assistant-max: 100%;
}
/* Narrow screens (≤600px): the card collapses to a compact auto-width pill.
   The WIDEST narrow variant is the collapsed "Team · 已完成" pill (~95px); the
   active "TEAM (x)" pill is narrower (~71px). Size clearance for the WIDEST
   pill so neither variant overlaps: footprint = 16 + 95 = 111px. With the 8px
   gap the collapsed pill sits 8px clear of the bubble; the narrower active
   pill leaves more slack (≈32px) — accepted, to avoid a fragile per-state
   measured publisher for a ~24px dead band.
   KEEP IN SYNC with TeammateCard.vue's NARROW_QUERY = '(max-width: 600px)'
   (the matchMedia breakpoint that switches the card to its narrow pill): the
   pill layout and this clearance must agree on the cutoff. */
@media (max-width: 600px) {
  .middle-section.has-team-card {
    --team-card-clearance: 111px;
  }
}
</style>
