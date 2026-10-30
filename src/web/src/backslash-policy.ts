/**
 * backslash-policy.ts - chooses how a chat message's backslashes render.
 *
 * THE BUG
 * -------
 * markdown-it implements CommonMark backslash escapes: `\` before ASCII
 * punctuation is a markdown ESCAPE and is removed from the output. Agent
 * messages routinely quote file paths, so a bubble shows
 *
 *     read C:\Proj\mycc\.mycc\mindmap.json
 *
 * as `C:\Proj\mycc.mycc\mindmap.json` — a plausible but wrong path. Only the
 * `\.` segment breaks: `\P`, `\m`, `\j` survive because those characters are
 * not escapable punctuation, which is why the symptom "looks like only the
 * dot" is lost.
 *
 * WHY NOT JUST DISABLE THE `escape` RULE EVERYWHERE
 * -------------------------------------------------
 * markdown-it has no `escape` option; the native switch is the inline ruler
 * (`md.inline.ruler.disable('escape')`). Applied globally it fixes paths but
 * costs every prose bubble its markdown escapes — and worse, `\*x\*` then
 * renders as `\<em>x\</em>` rather than a literal `\*x\*`, because removing
 * the rule stops consuming the backslash but does not disable the `*`'s
 * meaning.
 *
 * THE POINT-BY-POINT FIX
 * ----------------------
 * Paths only appear in TOOL messages — `core.brief(level, tool, message, …)`
 * puts the raw path in `content` and the tool name in `label`. Agent prose
 * (type 'result') and user text are authored markdown and keep stock
 * markdown-it. For path-bearing tool messages we swap in a second instance
 * whose `escape` rule treats every backslash as literal.
 *
 * The policy is a pure function of the wire message fields (type + label), so
 * it is testable without a DOM and identical in MessageItem.vue (inline
 * bubbles) and TeammateDrawer.vue (teammate timeline).
 */

/** The slice of a wire message the policy reads. */
export interface BackslashPolicyInput {
  type: string;
  label?: string;
}

/**
 * Tool labels whose brief `content` is (or embeds) an operating-system path:
 * the file tools, plus the shell tools whose command text is full of both
 * Windows and POSIX paths (`bash`/`bg_*` render as command cards and never go
 * through markdown, but their error/warn variants do).
 *
 * Deliberately a NAMED LIST, not "all labels": a labeled log from e.g.
 * `wiki_put` or `recall` carries prose we want rendered as markdown, and a
 * catch-all would silently give up escapes there for no benefit. Adding a
 * tool that starts emitting paths is a one-line change here.
 */
export const PATH_TOOL_LABELS: ReadonlySet<string> = new Set([
  'read',
  'read_read',
  'read_picture',
  'write',
  'edit',
  'grep',
  'glob',
  'bash',
  'bash_display',
  'bg_create',
  'bg_await',
  'bg_print',
  'bg_remove',
]);

/**
 * `'verbatim'` = backslashes are literal (path-safe renderer);
 * `'markdown'` = stock markdown-it (escapes apply).
 *
 * Only messages that actually go through markdown are consulted, so the
 * type check is intentionally permissive: `result`/`user` are authored prose
 * and keep escapes; a log/warn/error whose label names a path tool is
 * path-safe.
 */
export function backslashPolicy(msg: BackslashPolicyInput): 'verbatim' | 'markdown' {
  if (msg.type === 'result' || msg.type === 'user') return 'markdown';
  if (msg.label && PATH_TOOL_LABELS.has(msg.label)) return 'verbatim';
  return 'markdown';
}
