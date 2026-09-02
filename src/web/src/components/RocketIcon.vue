<script setup lang="ts">
// RocketIcon — the line-art rocket drawn for the auto-mode stop button.
// Extracted from ChatLog.vue so the (large) SVG markup + exhaust animations
// live in their own component and only mount while the auto button is in the
// DOM (the auto button is `v-else-if="state.isAutoMode"`-gated, so this
// component is absent entirely in regular mode — zero cost there).
//
// Performance note: the exhaust flames + mach rings use CSS keyframe
// animations. They are now driven by the `warping` prop via the `.rocket--active`
// class so the high-energy (faster) variant only applies while the agent is
// actively processing. The idle (AWAIT) thrust keeps a gentle animation; if
// even that is unwanted, the parent can simply not render this component.
//
// The SVG markup is unchanged from the original inline version; only the
// surrounding component boundary + prop wiring is new. The "RUNNING faster"
// exhaust rules were originally keyed off the ancestor
// `.interrupt-btn--auto.is-warping` selector; after extraction the button is
// no longer an ancestor in this child's scoped tree, so they are rekeyed to
// `.rocket--active` (bound to the `warping` prop on the SVG root).
defineProps<{
  /** true while the agent is actively processing (isRunning in auto mode).
   *  Toggles the high-energy exhaust (faster flames + mach rings). */
  warping?: boolean;
}>();
</script>

<template>
  <svg
    class="interrupt-rocket rocket-stage"
    :class="{ 'rocket--active': warping }"
    viewBox="0 0 24 24"
    width="22"
    height="22"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <!-- Whole scene rotated 45° for delivery. Drawn upright first:
         1) U-shaped body, 2) window, 3) two fins, 4) exhaust = hot
         outer plume + bright inner core + mach diamonds (shock rings)
         that propagate downward from the nozzle — a real jet/spray. -->
    <g class="rocket-frame" transform="rotate(45 12 12)">
      <!-- 1. U-shaped rocket body with a rounded top (open at the bottom) -->
      <path d="M8 14 V7 A4 4 0 0 1 16 7 V14 Z" />
      <!-- 2. Round window in the center, sized to the larger body -->
      <circle cx="12" cy="9" r="1.8" />
      <!-- 3. Two fins on the sides, attached at the wider body corners -->
      <path d="M8 14 L5 17 L8 17" />
      <path d="M16 14 L19 17 L16 17" />
      <!-- 4. Exhaust — drawn in the un-rotated frame (rotated as a whole
           by the parent rocket-frame rotate(45 12 12)). A hot outer plume
           + bright inner core + mach diamonds (shock rings) that
           propagate downward from the nozzle, giving a real jet/spray
           feel rather than伸缩线条. -->
      <g class="rocket-exhaust">
        <!-- Outer high-temperature plume -->
        <path
          class="exhaust-flame exhaust-flame--outer"
          d="M8.8 14
             C9.0 16.0 9.4 18.2 12 21
             C14.6 18.2 15.0 16.0 15.2 14
             C14.3 15.0 13.5 15.5 12 15.5
             C10.5 15.5 9.7 15.0 8.8 14Z"
        />
        <!-- Inner bright core -->
        <path
          class="exhaust-flame exhaust-flame--core"
          d="M10.2 14
             C10.5 15.7 10.8 17.0 12 18.8
             C13.2 17.0 13.5 15.7 13.8 14
             C13.2 14.7 12.7 15.0 12 15
             C11.3 15.0 10.8 14.7 10.2 14Z"
        />
        <!-- Mach diamonds / shock rings (diamonds read clearer than
             circles at this 22x22 size; match the line-art rocket). -->
        <g class="mach-rings">
          <path
            class="mach-ring mach-ring--1"
            d="M10.0 16.2 L12 17.0 L14.0 16.2 L12 15.5 Z"
          />
          <path
            class="mach-ring mach-ring--2"
            d="M10.4 18.2 L12 19.0 L13.6 18.2 L12 17.4 Z"
          />
          <path
            class="mach-ring mach-ring--3"
            d="M10.8 20.0 L12 20.6 L13.2 20.0 L12 19.4 Z"
          />
        </g>
      </g>
    </g>
  </svg>
</template>

<style scoped>
/* ── Rocket SVG ── */
/* z-index lifts the rocket above the warp-field. A gentle bob when warping
   (small translateX + scale pulse) gives a light "jump" feel without large
   lateral motion — the speed sensation is carried by the meteors + exhaust,
   not by moving the rocket across the button. */
.interrupt-rocket {
  flex-shrink: 0;
  display: inline-block;
  position: relative;
  z-index: 1;
}
.rocket-stage {
  transition: transform 0.3s ease;
}

/* ── Rocket exhaust ── */
/* A hot outer plume + bright inner core + mach diamonds (shock rings) that
   propagate downward from the nozzle. The plume continuously disturbs
   (scaleY/scaleX breathing) and the mach rings travel outward + fade,
   giving a real jet/spray feel rather than伸缩线条. AWAIT keeps a gentle
   idle thrust; is-warping (RUNNING) boosts opacity + speeds every part. */
.rocket-exhaust {
  transform-origin: 12px 14px;
  transform-box: view-box;
  /* AWAIT: gentle idle thrust */
  opacity: 0.7;
}
/* RUNNING: high-energy propulsion */
.rocket--active .rocket-exhaust {
  opacity: 1;
}

/* Outer hot exhaust */
.exhaust-flame--outer {
  fill: currentColor;
  opacity: 0.38;
  transform-origin: 12px 14px;
  animation: exhaust-flame 0.72s ease-in-out infinite;
}
/* Bright inner core */
.exhaust-flame--core {
  fill: currentColor;
  opacity: 0.9;
  transform-origin: 12px 14px;
  animation: exhaust-core 0.48s ease-in-out infinite;
}

/* ── Mach diamonds / shock rings ── */
.mach-rings {
  transform-origin: 12px 14px;
}
.mach-ring {
  fill: none;
  stroke: currentColor;
  stroke-width: 0.65;
  stroke-linejoin: round;
  opacity: 0;
  transform-origin: 12px 14px;
}
.mach-ring--1 {
  stroke-width: 0.8;
  animation: mach-ring 0.72s linear infinite;
}
.mach-ring--2 {
  stroke-width: 0.6;
  animation: mach-ring 0.72s linear infinite;
  animation-delay: 0.18s;
}
.mach-ring--3 {
  stroke-width: 0.45;
  animation: mach-ring 0.72s linear infinite;
  animation-delay: 0.36s;
}

/* ── Flame motion ── */
@keyframes exhaust-flame {
  0% {
    transform: scaleY(0.65) scaleX(0.85);
    opacity: 0.28;
  }
  35% {
    transform: scaleY(1.05) scaleX(1);
    opacity: 0.42;
  }
  70% {
    transform: scaleY(1.25) scaleX(0.92);
    opacity: 0.34;
  }
  100% {
    transform: scaleY(0.7) scaleX(0.82);
    opacity: 0.24;
  }
}
@keyframes exhaust-core {
  0% {
    transform: scaleY(0.65);
    opacity: 0.65;
  }
  25% {
    transform: scaleY(1.1);
    opacity: 1;
  }
  55% {
    transform: scaleY(0.85);
    opacity: 0.82;
  }
  100% {
    transform: scaleY(0.6);
    opacity: 0.6;
  }
}

/* ── Shock diamond propagation ── */
@keyframes mach-ring {
  0% {
    transform: translateY(0) scale(0.55);
    opacity: 0;
  }
  15% {
    opacity: 0.65;
  }
  45% {
    transform: translateY(1.5px) scale(0.9);
    opacity: 0.4;
  }
  75% {
    transform: translateY(3px) scale(1.15);
    opacity: 0.15;
  }
  100% {
    transform: translateY(4.5px) scale(1.3);
    opacity: 0;
  }
}

/* ── RUNNING (warping): faster, higher-energy exhaust ── */
.rocket--active .exhaust-flame--outer {
  animation-duration: 0.48s;
}
.rocket--active .exhaust-flame--core {
  animation-duration: 0.32s;
}
.rocket--active .mach-ring--1 {
  animation-duration: 0.48s;
}
.rocket--active .mach-ring--2 {
  animation-duration: 0.48s;
}
.rocket--active .mach-ring--3 {
  animation-duration: 0.48s;
}
</style>