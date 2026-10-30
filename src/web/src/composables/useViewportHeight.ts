/**
 * useViewportHeight.ts — keeps the app shell the size of the VISIBLE viewport.
 *
 * Why `100vh` is not enough on mobile: `vh` is sized against the *layout*
 * viewport, which does not shrink when the Android soft keyboard (IME) opens
 * (and it includes the space behind a collapsing browser toolbar). A flex
 * column laid out with `height: 100vh` therefore pushes the composer — the
 * last child — *under* the IME: the user types into a box they cannot see.
 *
 * The fix is to size the shell from `window.visualViewport` (the actually
 * visible area), which fires `resize` on every IME open/close and every
 * toolbar collapse, plus `scroll` when the IME pans the page. Both events
 * write ONE custom property, `--app-vh`, on <html>; App.vue's
 * `.app-container` sizes itself from it and flexbox does the rest (the chat
 * log shrinks, the composer stays pinned to the visible bottom edge).
 *
 * Fallbacks, in priority order, all writing the same property:
 *   1. `visualViewport.height` (px) — precise; follows the IME.
 *   2. `window.innerHeight` (px) — no visualViewport (older Safari/WebViews).
 *   3. `100vh` — nothing measured; CSS keeps its own `vh` behaviour.
 * A `resize` listener on `window` is always attached as well, because some
 * desktop browsers/WebViews only report viewport changes there.
 *
 * The listeners are installed ONCE at module scope (the property is global
 * anyway) and are idempotent: calling `installViewportHeight()` repeatedly —
 * including from Vue HMR re-executing this module — re-attaches nothing.
 */

const PROPERTY = '--app-vh';

type ManagedEvent = {
  target: Window | VisualViewport;
  type: string;
  handler: () => void;
};

/** Bookkeeping key on <html>, so an HMR re-run of this module (which resets
 *  module-level `let`s) still sees the previous install. */
const INSTALLED_KEY = '__myccViewportHeight';

type ViewportHost = HTMLElement & { [INSTALLED_KEY]?: ManagedEvent[] };

function measure(): string {
  // Round DOWN: over-reporting by a subpixel makes the shell 1px taller than
  // the visible area, which re-enables page scroll (the classic
  // "keyboard jitters by 1px" bug).
  const vv = window.visualViewport;
  if (vv && vv.height > 0) return `${Math.floor(vv.height)}px`;
  if (window.innerHeight > 0) return `${Math.floor(window.innerHeight)}px`;
  return '100vh';
}

function apply(): void {
  document.documentElement.style.setProperty(PROPERTY, measure());
}

/** Install the viewport listeners (idempotent). Returns a no-op cleanup — the
 *  property is app-global, so unmounting one component must not tear it down. */
export function installViewportHeight(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }
  const host = document.documentElement as ViewportHost;
  if (host[INSTALLED_KEY]) {
    apply();
    return () => {};
  }

  const events: ManagedEvent[] = [
    { target: window, type: 'resize', handler: apply },
    { target: window, type: 'orientationchange', handler: apply },
  ];
  const vv = window.visualViewport;
  if (vv) {
    // `resize`: IME open/close, browser-toolbar collapse.  `scroll`: the IME
    // pans the visual viewport without changing its height (fired on iOS and
    // some Android browsers) — same value, kept in sync.
    events.push({ target: vv, type: 'resize', handler: apply });
    events.push({ target: vv, type: 'scroll', handler: apply });
  }

  for (const { target, type, handler } of events) {
    target.addEventListener(type, handler, { passive: true });
  }
  Object.defineProperty(host, INSTALLED_KEY, { value: events, configurable: true });

  apply();
  return () => {};
}
