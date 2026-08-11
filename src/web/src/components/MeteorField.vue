<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';

// MeteorField — the "hyperspace jump" meteor starfield clipped inside the
// auto-mode stop button. Extracted from ChatLog.vue.
//
// ── Geometry ──
// The parent (ChatLog.vue) wraps this component in a .warp-stage span that is
// position:absolute;inset:0 inside the button — that stage owns the
// out-of-flow geometry (so the component root, a flex item of the inline-flex
// button, is taken out of flex flow and the starfield keeps the full button
// width). This component's root therefore fills the stage: position:static;
// width:100%; height:100% (see .warp-field below). Do NOT re-introduce
// position:absolute here — double absolute would nest incorrectly and the
// scoped-CSS application on a child-component root is less reliable than the
// stage defined in the parent's own scoped tree.
//
// ── Performance redesign (the main reason for the extraction) ──
// The original implementation kept all 5 meteor CSS animations running
// `infinite` for the whole lifetime of the auto button, and kept an
// `animationiteration` listener attached that fired ~10×/sec doing
// querySelectorAll + 5× setProperty — even while the starfield was
// invisible (opacity 0) during WAIT (idle auto mode).
//
// This component gates everything on the `warping` prop:
//   • warping=false (WAIT / idle): the `.is-warping` class is absent →
//     `animation-play-state: paused` halts every meteor animation (no
//     compositor work, no iteration events), the field is opacity:0, and
//     the JS listener is detached. Zero per-frame cost.
//   • warping=true (RUNNING): the class is added → animations resume, the
//     listener is attached and re-rolls meteor birth positions each loop.
//
// ── CSS custom props --mx/--my ──
// Each meteor's BIRTH position is set via --mx (left) / --my (top) as % of
// the field box. The animationiteration listener re-rolls them every loop
// so streaks appear from fresh spots — true randomness, not a fixed pattern.
// The fixed per-meteor width/duration/delay still differ so they never move
// in lockstep.

const props = defineProps<{
  /** true while the agent is actively processing (isRunning in auto mode).
   *  When true the starfield animates and the iteration listener is active;
   *  when false everything is frozen (paused + listener detached). */
  warping?: boolean;
}>();

const fieldEl = ref<HTMLElement | null>(null);

function randomizeMeteors(): void {
  const field = fieldEl.value;
  if (!field) return;
  // The button interior the field fills (the .warp-stage, inset:0 of the
  // button). Meteors travel top-right → bottom-left, so births are seeded
  // across the top edge. --mx/--my are percentages of the field box.
  const meteors = field.querySelectorAll<HTMLElement>('.meteor');
  for (const m of meteors) {
    // Horizontal: spread across the FULL width (0%..100%) so meteors are
    // born everywhere — including the left edge — and streaks cross the
    // whole frame, covering the button's left semicircle. (Previously this
    // was biased to 35%..95%, which left the left edge with no streaks.)
    const mx = Math.random() * 100; // 0%..100%
    // Vertical: spread across the full height; bias slightly up (the
    // "incoming" top edge for top-right→bottom-left travel).
    const my = Math.random() * 55; // 0%..55%
    m.style.setProperty('--mx', `${mx}%`);
    m.style.setProperty('--my', `${my}%`);
  }
}

function onWarpIter(): void {
  randomizeMeteors();
}

function attachListener(): void {
  const field = fieldEl.value;
  if (field) {
    field.addEventListener('animationiteration', onWarpIter);
  }
}

function detachListener(): void {
  const field = fieldEl.value;
  if (field) {
    field.removeEventListener('animationiteration', onWarpIter);
  }
}

// Seed birth positions once on mount (cheap, no listener yet). The listener
// is only attached when warping flips true (see watch below).
onMounted(() => {
  randomizeMeteors();
});

onBeforeUnmount(() => {
  detachListener();
});

// Toggle the listener + animation cost on warping transitions. Using
// watch with immediate:true means: on mount, if already warping, we seed +
// attach the listener (covers the page-refresh-during-running case); if not
// warping on mount, nothing is attached and the animations stay paused.
watch(
  () => !!props.warping,
  (warping, prev) => {
    if (warping) {
      // Starting a warp: re-seed positions so the first frame isn't stale,
      // then attach the listener.
      randomizeMeteors();
      attachListener();
    } else if (prev) {
      // Stopping a warp: detach the listener. The `.is-warping` class
      // removal (via the template binding) pauses the CSS animations.
      detachListener();
    }
  },
  { immediate: true },
);
</script>

<template>
  <span ref="fieldEl" class="warp-field" :class="{ 'is-warping': warping }" aria-hidden="true">
    <span class="meteor meteor-a"></span>
    <span class="meteor meteor-b"></span>
    <span class="meteor meteor-c"></span>
    <span class="meteor meteor-d"></span>
    <span class="meteor meteor-e"></span>
  </span>
</template>

<style scoped>
/* ── Warp field: the clipped meteor starfield ── */
/* Fills its parent (.warp-stage in ChatLog.vue, which is the
   position:absolute;inset:0 element that takes the starfield out of the
   button's flex flow). This root is therefore position:static + width/height
   100% so it just fills the stage; the stage owns the out-of-flow geometry.
   opacity is driven by is-warping so the starfield only shows while the
   agent is actively processing.

   ── Enter/exit effect ──
   On top of the show/hide (opacity), the whole field scales — exaggerated
   for a dramatic hyperspace feel. The two properties have DIFFERENT
   durations and are deliberately staggered on exit:
     • scale: 0.5s animation.
     • opacity: 0.2s animation.
     • ENTER (false → warping): both start at t=0 (aligned). scale runs
       3 → 1 over 0.5s; opacity runs 0 → 1 over 0.2s (finishes early, then
       holds visible while scale continues settling).
     • EXIT (warping → false): scale starts immediately (1 → 3 over 0.5s);
       opacity is TRAILING-aligned — it waits 0.3s (transition-delay), then
       fades 1 → 0 over its 0.2s, finishing at t=0.5s exactly when scale
       ends. So the starfield keeps full opacity for the first 0.3s of the
       zoom-out-then-vanish, then fades in the last 0.2s.
   transform-origin is the CENTER of the field so the scale is symmetric
   and the field stays centered on the button — it grows/shrinks in place
   rather than sliding toward a corner. The stage's overflow:hidden (via
   the button's overflow:hidden clip frame) keeps the blown-up field from
   bleeding outside the pill during exit.

   ── Position offset ──
   The field's resting position is shifted LEFT ~20px from the stage's
   natural inset:0 origin (left: -20px) to correct the starfield's alignment
   inside the button. This is a STATIC position fix applied in BOTH states
   (idle and warping) — it is NOT part of the enter/exit animation, so the
   transition does not touch it. Only opacity + scale animate. */
.warp-field {
  position: static;
  inset: auto;
  width: 100%;
  height: 100%;
  /* Static left offset: shift the starfield ~20px left of the stage's
     natural origin to correct its resting alignment. Applies in both
     states; not animated. */
  left: -20px;
  overflow: hidden;
  /* EXIT / idle state: zoomed IN (scale 3) + hidden. This is the resting
     target the field animates TO when warping flips false, and the starting
     point it animates FROM when warping flips true. */
  opacity: 0;
  transform: scale(3);
  transform-origin: center center;
  /* EXIT timing: scale runs 0.5s from t=0; opacity is trailing-aligned —
     delayed 0.3s then runs 0.2s, finishing at t=0.5s alongside scale. The
     static left offset is NOT transitioned. */
  transition: transform 0.5s ease, opacity 0.2s ease 0.3s;
}
/* ENTER / warping state: zoomed OUT to natural size (scale 1) + shown.
   The left: -20px offset is inherited from the base rule (unchanged here).
   ENTER timing overrides the opacity delay to 0 so both properties start
   aligned at t=0 (scale 0.5s, opacity 0.2s). */
.warp-field.is-warping {
  opacity: 1;
  transform: scale(1);
  transition: transform 0.5s ease, opacity 0.2s ease 0s;
}

/* Each meteor is a short streak flying top-right → bottom-left (the rocket
   flies bottom-left → top-right, so the streaks rush past it in reverse).
   The streak's bright HEAD leads at the bottom-left (the travel direction)
   and the faint TAIL trails toward the top-right (behind). rotate(-45deg)
   sets the streak's SHAPE orientation; translate(-X, +Y) sets the actual
   MOTION direction. Different meteors get distinct starts, lengths, speeds,
   and delays so the field reads as a star array, not a moving texture. */
.meteor {
  position: absolute;
  display: block;
  width: 14px;
  height: 2.2px;
  border-radius: 1.2px;
  /* Head (bright) at the LEFT edge of the un-rotated bar → after rotate
     (-45deg) it sits at the bottom-left = the direction of travel (the
     meteor flies right-top → left-bottom). Tail (faint) at the RIGHT edge
     → top-right, pointing back where the meteor came from (trailing).
     rotate(-45deg) maps local-left → bottom-left, local-right → top-right. */
  background: linear-gradient(
    to right,
    rgba(255, 255, 255, 0.76),
    rgba(180, 230, 255, 0.12)
  );
  transform: translate(0, 0) rotate(-45deg);
  opacity: 0;
  /* PERFORMANCE: pause the flight animation unless warping. Without this the
     5 meteors animate `infinite` for the whole auto-mode lifetime, keeping
     the compositor busy + firing animationiteration events even while the
     field is invisible (opacity 0) during WAIT. paused = zero per-frame
     cost; the .is-warping rule below resumes them. */
  animation-play-state: paused;
}
/* Five meteors spread across the button interior so the starfield fills the
   frame around the rocket rather than bunching on one side. Each enters near
   the top/right edge (the "incoming" edge for top-right→bottom-left travel)
   and exits toward the bottom-left. Starts are staggered across the width
   and height; lengths/speeds/delays differ so they never move in lockstep. */
/* Each meteor's BIRTH position is set via CSS custom props --mx (left) and
   --my (top), expressed as % of the warp-field box. A JS animationiteration
   listener (see script setup) re-rolls them every loop, so streaks appear
   from fresh spots each pass — true randomness, not a fixed pattern. The
   fixed per-meteor width/duration/delay still differ so they never move in
   lockstep. */
.meteor-a {
  left: var(--mx, 50%);
  top: var(--my, 10%);
  width: 16px;
  animation: meteor-flight 0.54s linear infinite;
  animation-delay: 0s;
}
.meteor-b {
  left: var(--mx, 60%);
  top: var(--my, 20%);
  width: 22px;
  animation: meteor-flight 0.72s linear infinite;
  animation-delay: 0.18s;
}
.meteor-c {
  left: var(--mx, 45%);
  top: var(--my, 5%);
  width: 13px;
  animation: meteor-flight 0.48s linear infinite;
  animation-delay: 0.36s;
}
.meteor-d {
  left: var(--mx, 70%);
  top: var(--my, 50%);
  width: 19px;
  animation: meteor-flight 0.84s linear infinite;
  animation-delay: 0.12s;
}
.meteor-e {
  left: var(--mx, 80%);
  top: var(--my, 35%);
  width: 24px;
  animation: meteor-flight 0.66s linear infinite;
  animation-delay: 0.48s;
  opacity: 0.44;
}

/* PERFORMANCE: only run the flight animation while warping. The base
   animation-play-state: paused (above) is overridden here for the active
   state. This is what makes WAIT (idle auto) cost nothing. */
.warp-field.is-warping .meteor {
  animation-play-state: running;
}

/* The motion: meteors start at a top-right offset (translate(45px, -45px))
   and travel to the bottom-left (translate(-45px, 45px)) — opposite the
   rocket's bottom-left→top-right flight. They fade in, hold, then fade out
   as they exit. */
@keyframes meteor-flight {
  from {
    transform: translate(45px, -45px) rotate(-45deg);
    opacity: 0;
  }

  15% {
    opacity: 1;
  }

  70% {
    opacity: 1;
  }

  to {
    transform: translate(-45px, 45px) rotate(-45deg);
    opacity: 0;
  }
}
</style>