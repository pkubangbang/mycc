/**
 * highlight.ts - Shiki-based syntax highlighting service for the WebUI.
 *
 * Two rendering paths consume this module:
 *  1. markdown-it code blocks (` ```lang ` fences) — wired via the
 *     markdown-it `highlight` option in MessageItem.vue, which calls
 *     `highlightCode(code, lang)`.
 *  2. Bash command cards (the bash tool's pre-execution info log,
 *     `label:'bash'`/`type:'log'`) — `highlightBash(command)` wraps the
 *     highlighted command with a `$` prompt span.
 *
 * Async-init, sync-use design
 * ---------------------------
 * Shiki's `createHighlighter` is async (it loads TextMate grammars + WASM),
 * but markdown-it's `highlight` callback and Vue's template rendering are
 * synchronous. So we pre-initialize a singleton highlighter at app startup:
 * `main.ts` awaits `ensureHighlighterReady()` before mounting the Vue app,
 * which guarantees the first render (including history loaded from
 * `/history`) already has the highlighter available. The sync `highlightCode`
 * / `highlightBash` functions then call `highlighter.codeToHtml` directly.
 *
 * Dual theme (light + dark) in a single render
 * --------------------------------------------
 * The WebUI supports a light theme (`:root`) and a dark theme
 * (`:root.dark` on `<html>`), toggled live without re-rendering messages.
 * Shiki's multi-theme mode (`themes: { light, dark }` with
 * `defaultColor: false`) emits inline styles using CSS variables
 * (`--shiki-light` / `--shiki-dark`) instead of hard-coded colors. We pair
 * that with the CSS rules in MessageItem.vue that map those variables to the
 * active theme under `:root` vs `:root.dark`, so ONE highlighted render
 * automatically switches colors when the user toggles the theme — no
 * re-highlighting of every bubble is needed.
 */

import { createHighlighter, type Highlighter } from 'shiki';

// Languages bundled into the highlighter at init time. These cover the most
// common code blocks the LLM emits in replies. Languages outside this set
// fall back to plain escaped text (graceful, not an error). The set is kept
// small to limit bundle size / init cost; shiki loads grammars on demand
// only for these langs.
const LANGS = [
  'bash',
  'sh',
  'shell',
  'typescript',
  'javascript',
  'ts',
  'js',
  'json',
  'jsonc',
  'yaml',
  'html',
  'css',
  'python',
  'py',
  'sql',
  'markdown',
  'diff',
] as const;

// A GitHub-style light + dark pair — neutral and readable on both the
// WebUI's light (WeChat gray) and dark (navy) backgrounds.
const LIGHT_THEME = 'github-light';
const DARK_THEME = 'github-dark';

let highlighter: Highlighter | null = null;
let initPromise: Promise<Highlighter> | null = null;

/**
 * Create (once) and return the singleton Shiki highlighter. The first call
 * kicks off async init; subsequent calls return the same promise. Resolves
 * to a ready-to-use `Highlighter` with the bundled themes + langs loaded.
 */
function getHighlighter(): Promise<Highlighter> {
  if (highlighter) return Promise.resolve(highlighter);
  if (!initPromise) {
    initPromise = createHighlighter({
      themes: [LIGHT_THEME, DARK_THEME],
      langs: [...LANGS],
    }).then((hl) => {
      highlighter = hl;
      return hl;
    });
  }
  return initPromise;
}

/**
 * Awaited by `main.ts` before the Vue app mounts, so the first render has
 * highlighting available. Safe to call multiple times (idempotent).
 */
export function ensureHighlighterReady(): Promise<unknown> {
  return getHighlighter();
}

/**
 * Map a possibly-aliased or unknown language id to a canonical id that the
 * highlighter bundled at init. Returns '' when the language is unknown /
 * unsupported, signaling the caller to fall back to plain escaped text.
 */
function resolveLang(lang: string): string {
  if (!lang) return '';
  const lower = lang.toLowerCase();
  // Alias normalization to the bundled grammar ids.
  const aliases: Record<string, string> = {
    ts: 'typescript',
    js: 'javascript',
    py: 'python',
    sh: 'bash',
    shell: 'bash',
    'shell-script': 'bash',
    yml: 'yaml',
    md: 'markdown',
  };
  const canonical = aliases[lower] ?? lower;
  return (LANGS as readonly string[]).includes(canonical) ? canonical : '';
}

/**
 * Highlight a code string for the given language, returning Shiki's `<pre>`
 * HTML. Uses dual-theme mode so a single render works under both the light
 * and dark WebUI themes. When the language is unknown (or the highlighter is
 * not yet initialized), returns an escaped, unstyled `<pre><code>` block so
 * markdown-it still gets valid HTML.
 *
 * MUST be called only after `ensureHighlighterReady()` has resolved (main.ts
 * awaits it before mount). If invoked before init, falls back to plain text.
 */
export function highlightCode(code: string, lang: string): string {
  const hl = highlighter;
  if (!hl) return fallbackPre(code);
  const resolved = resolveLang(lang);
  if (!resolved) return fallbackPre(code);
  try {
    return hl.codeToHtml(code, {
      lang: resolved,
      themes: { light: LIGHT_THEME, dark: DARK_THEME },
      defaultColor: false,
    });
  } catch {
    return fallbackPre(code);
  }
}

/**
 * Highlight a bash command for the bash command card. The `$` prompt is
 * prepended as a styled span OUTSIDE the highlighted code so the prompt
 * glyph is never colored by the grammar. Returns an HTML string ready for
 * `v-html`. Falls back to a plain escaped block if the highlighter is not
 * ready or highlighting fails.
 */
export function highlightBash(command: string): string {
  const highlighted = highlightCode(command, 'bash');
  // Shiki returns `<pre ...><code ...>...</code></pre>`. Inject the prompt
  // span right after the opening `<code>` tag so it sits inside the code
  // block but is not itself tokenized.
  const promptSpan = '<span class="bash-prompt">$</span>';
  const injected = highlighted.replace(/(<code[^>]*>)/, `$1${promptSpan}`);
  if (injected === highlighted) {
    // The regex didn't match (unexpected shape) — return the prompt + the
    // raw block so the user still sees the command.
    return `${promptSpan}${escapeHtml(command)}`;
  }
  return injected;
}

/** Escape HTML special characters for safe insertion into a `<pre><code>`. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A plain, escaped `<pre><code>` block — the no-highlight fallback. */
function fallbackPre(code: string): string {
  return `<pre class="shiki-fallback"><code>${escapeHtml(code)}</code></pre>`;
}