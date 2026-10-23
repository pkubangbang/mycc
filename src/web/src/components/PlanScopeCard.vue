<script setup lang="ts">
/**
 * PlanScopeCard.vue - the Web UI rendering of a PLAN-mode scope reflection.
 *
 * The backend appends a step-back reflection to every plan-mode brief
 * (src/loop/plan-scope.ts) and prints it as a labeled log
 * (brief('info', 'plan-scope', …)). That log's content is formatted for a
 * TERMINAL: an ASCII rule line plus four padEnd()-aligned label columns.
 * markdown-it cannot render that faithfully — the rule becomes an <hr>, the
 * alignment collapses, and the four checks read as one undifferentiated
 * paragraph — so the reflection is effectively invisible in the chat log.
 *
 * This component renders the same text as intended: a distinct violet panel
 * (matching the terminal's chalk.magenta plan-scope colour), a title, the
 * model's lead-in, then one row per check showing
 *   LABEL   [one-line meaning of the check]
 *           [the model's answer]
 * Every answer — including a "none — …" / "no — …" / "two-way — …" sentinel —
 * renders at full body weight: it is the model's content, and a dimmed line
 * reads as disabled to a reader.
 *
 * Parsing lives in ../plan-scope.ts (pure, node-testable). This SFC is only
 * presentation: it must never drop content — unlabelled prose and unknown
 * lines are rendered verbatim.
 */
import { computed } from 'vue';
import {
  parsePlanScope,
  PLAN_SCOPE_HINTS,
  isSentinelAnswer,
} from '../plan-scope';

const props = defineProps<{
  /** The plan-scope log's raw content (the terminal-formatted block). */
  content: string;
}>();

const parsed = computed(() => parsePlanScope(props.content ?? ''));

const rows = computed(() =>
  parsed.value.checks.map((check) => {
    const { text, truncated } = splitTruncation(check.value);
    return {
      label: check.label,
      hint: PLAN_SCOPE_HINTS[check.label] ?? '',
      // `html` is the escaped, pre-rendered answer (see renderValue) — computed
      // once per parse instead of once per re-render.
      html: renderValue(text),
      hasAnswer: text.length > 0,
      truncated,
      // The model answers with a sentinel ("none — …", "no — …", "two-way — …")
      // when the check found nothing. That is content, not noise — it renders
      // at the SAME weight as a real finding (a dimmed row reads as disabled /
      // inactive text to most users). `sentinel` is kept only so the CSS can
      // distinguish, not so it can fade the row out.
      sentinel: isSentinelAnswer(check.value),
    };
  }),
);

/** The backend clamps an over-long reflection at a word boundary and appends
 *  this marker (src/loop/plan-scope.ts clamp()). */
const TRUNCATION_MARKER = /…\s*\(truncated\)/i;

/** Split the backend's truncation marker off a value so the card can show it
 *  as an explicit marker instead of inline text. */
function splitTruncation(value: string): { text: string; truncated: boolean } {
  if (!TRUNCATION_MARKER.test(value)) return { text: value, truncated: false };
  return { text: value.replace(TRUNCATION_MARKER, '').trimEnd(), truncated: true };
}

/**
 * Render one answer value as escaped HTML. The model writes identifiers,
 * paths and snippets inline; running the value through markdown-it would let
 * a stray `_` or `*` in prose start an emphasis span (and the labels are
 * already structure). Instead: escape the text, then wrap
 *   - backtick spans (`x`) → <code>;
 *   - a WHOLE [bracketed] phrase → <code>, the model's convention for naming
 *     a UI chip / option (e.g. `[⌄ button]`).
 * Only a WHOLE `[...]` is a chip: a bracket that OPENS or CLOSES in the middle
 * of a word (the terminal formatter's cut marker `co[ntain]`, which marks a
 * truncated word) must stay literal, otherwise a cut word would be styled as
 * an identifier and the marker hidden in a code chip. A `[` directly before
 * the first and a `]` directly after the closing bracket are required.
 * v-html is safe because the escaping happens first: the only tags in the
 * result are the wrappers inserted here.
 */
function renderValue(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`([^`\n]+)`/g, (_match, code: string): string => `<code>${code}</code>`)
    .replace(
      /(^|[^\w])\[([^[\]\n]{1,40})\](?!\w)/g,
      (_match, before: string, label: string): string => `${before}[<code>${label}</code>]`,
    );
}
</script>

<template>
  <div class="plan-scope-card">
    <div class="plan-scope-title">
      <span class="plan-scope-mark" aria-hidden="true">↺</span>
      <span class="plan-scope-name">plan-scope</span>
      <span class="plan-scope-subtitle">计划模式 · 退一步审视框架</span>
    </div>
    <!-- Lead-in before the first label (e.g. "Serves the ask."): shown above
         the rows so it is not mistaken for a check's answer. -->
    <div v-if="parsed.leadIn" class="plan-scope-lead">{{ parsed.leadIn }}</div>

    <!-- Unlabelled prose: the terminal formatter passes such text through
         verbatim, so render it as a preformatted block — never drop it. -->
    <pre v-if="parsed.prose" class="plan-scope-prose">{{ parsed.prose }}</pre>

    <ul v-if="rows.length" class="plan-scope-rows">
      <li
        v-for="row in rows"
        :key="row.label"
        class="plan-scope-row"
        :class="{ sentinel: row.sentinel }"
      >
        <div class="plan-scope-row-head">
          <span class="plan-scope-label">{{ row.label }}</span>
          <span v-if="row.hint" class="plan-scope-hint">{{ row.hint }}</span>
        </div>
        <!-- eslint-disable-next-line vue/no-v-html -- html is escaped in renderValue; only <code> wrappers are inserted -->
        <div
          v-if="row.hasAnswer"
          class="plan-scope-value"
          v-html="row.html"
        ></div>
        <div v-else class="plan-scope-value plan-scope-empty">（无输出）</div>
        <!-- The backend clamps a long reflection and appends "…(truncated)";
             surface that as a marker on its own line so a cut answer is never
             mistaken for a complete one. -->
        <div v-if="row.truncated" class="plan-scope-truncated">
          （回答超长，已被截断）
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
/* Violet panel — see the --plan-scope-* tokens in style.css (light + dark).
   The panel has NO left rule: the message bubble and the card border already
   frame it, and an extra bar (plus the per-row bars below) made the left edge
   read as a stack of stacked vertical lines. The check labels carry the
   "this is a step-back" signal by their colour instead. */
.plan-scope-card {
  background: var(--plan-scope-bg);
  border: 1px solid var(--plan-scope-border);
  border-radius: 8px;
  padding: 10px 12px;
  color: var(--plan-scope-text);
}

.plan-scope-title {
  display: flex;
  align-items: baseline;
  gap: 6px;
  margin-bottom: 8px;
  user-select: none;
}
.plan-scope-mark {
  color: var(--plan-scope-heading);
  font-size: 14px;
  line-height: 1;
}
.plan-scope-name {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 13px;
  font-weight: 600;
  color: var(--plan-scope-heading);
  letter-spacing: 0.2px;
}
.plan-scope-subtitle {
  font-size: 11px;
  color: var(--plan-scope-hint);
}

.plan-scope-lead {
  font-size: 13px;
  color: var(--plan-scope-text);
  margin-bottom: 8px;
}

.plan-scope-prose {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}

/* One row per check. The label column is a fixed min width so the four
   labels align like the terminal block, but it wraps gracefully on a narrow
   screen (flex-wrap) instead of squeezing the answer. */
.plan-scope-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.plan-scope-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.plan-scope-row-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px;
}
.plan-scope-label {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.6px;
  color: var(--plan-scope-label);
  min-width: 9ch;
}
.plan-scope-hint {
  font-size: 11.5px;
  color: var(--plan-scope-hint);
}
.plan-scope-value {
  font-size: 13px;
  line-height: 1.5;
  color: var(--plan-scope-text);
  word-break: break-word;
  overflow-wrap: anywhere;
}
.plan-scope-value :deep(code) {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  background: var(--md-code-bg);
  padding: 1px 4px;
  border-radius: 4px;
}
.plan-scope-empty {
  font-style: italic;
  color: var(--plan-scope-hint);
}

/* A sentinel answer ("none — …", "no — …", "two-way — …") is an honest
   non-finding, but it is STILL the model's answer and stays at full body
   weight — dimming it made readers think the text was disabled or cut off.
   Only the label loses a little emphasis, so the scan order of the four
   checks stays visible. */
.plan-scope-row.sentinel .plan-scope-label {
  opacity: 0.85;
}

/* Truncation marker: the backend cut the answer (`clamp()` appends
   "…(truncated)"), so say so explicitly instead of letting a clipped sentence
   look like a finished one. */
.plan-scope-truncated {
  margin-top: 2px;
  font-size: 11.5px;
  font-style: italic;
  color: var(--plan-scope-hint);
}
</style>
