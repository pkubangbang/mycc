/**
 * letter-box.ts - Display text in a pseudo parenthesis-style box
 */

import chalk from 'chalk';

/**
 * Get current timestamp in HH:MM:SS format
 */
function getTimestamp(): string {
  const now = new Date();
  return now.toTimeString().slice(0, 8);
}

/**
 * Fullwidth vertical line (U+FF5C) used in DeepSeek DSML tags.
 * DeepSeek emits markup like: <\uff5c\uff5cDSML\uff5c\uff5ctagname>...</\uff5c\uff5cDSML\uff5c\uff5ctagname>
 * The "||" in rendered display is actually two U+FF5C characters.
 */
const FW_VLINE = '\uff5c';

/**
 * Regex source: ONE or TWO pipe characters per side of "DSML".
 *
 * The pipe may be an ASCII vertical bar (`|`) OR the fullwidth vertical line
 * (U+FF5C, rendered `｜`). DeepSeek's real wire format uses ASCII pipes
 * (<||DSML||tagname>), while some Ollama-hosted models (e.g. GLM) emit the
 * fullwidth form (<｜DSML｜tagname>) and others double it (<｜｜DSML｜｜tagname>).
 * A per-side class accepts either glyph, and the {1,2} quantifier accepts the
 * single or double form. The class is raw regex source (the vline is escaped
 * alone, the `|` alternation and {1,2} applied outside escapeRegex, which
 * would otherwise escape the braces).
 */
const PIPE_Q = `[\\|${escapeRegex(FW_VLINE)}]{1,2}`;
const FW_DSML_OPEN_RE = `<${PIPE_Q}DSML${PIPE_Q}`;
const FW_DSML_CLOSE_RE = `</${PIPE_Q}DSML${PIPE_Q}`;

/**
 * Escape special regex characters in a string for use in RegExp constructor.
 */
function escapeRegex(str: string): string {
  return str.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * Strip internal markup tags from content before display.
 *
 * DeepSeek sometimes emits DSML (DeepSeek Markup Language) tags directly
 * into the text content stream:
 *   <||DSML||tagname>...</||DSML||tagname>
 * The pipe glyph may be an ASCII vertical bar (`|`, the real wire form) or the
 * fullwidth vertical line (U+FF5C, `｜`) — the matcher accepts either, single
 * or doubled, on each side of the tag name.
 */
export function stripInternalMarkup(content: string): string {
  let result = content;

  // Fast-path gate: both forms share the literal "DSML" tag name. Gating on
  // that (NOT on the fullwidth vline) is what lets the ASCII-pipe form enter
  // the regexes below — previously the gate missed it entirely and the raw
  // markup leaked through to both the mid-loop briefs and the letter-box.
  if (result.includes('DSML')) {
    // Strip full DSML paired tags: <||DSML||tagname>...</||DSML||tagname>
    // (opening tag may carry attributes, e.g. <||DSML||parameter name="m">)
    const fullTagRe = new RegExp(
      `${FW_DSML_OPEN_RE  }(\\w+)(?:\\s[^>]*)?>[\\s\\S]*?${  FW_DSML_CLOSE_RE  }\\1>`,
      'g'
    );
    result = result.replace(fullTagRe, '');

    // Strip self-closing DSML tags: <||DSML||tagname />
    const selfCloseRe = new RegExp(
      `${FW_DSML_OPEN_RE  }(\\w+)(?:\\s[^>]*)?\\s*/\\s*>`,
      'g'
    );
    result = result.replace(selfCloseRe, '');

    // Strip opening-only DSML tags: <||DSML||tagname> (with or without attrs)
    const openTagRe = new RegExp(`${FW_DSML_OPEN_RE  }(\\w+)(?:\\s[^>]*)?>`, 'g');
    result = result.replace(openTagRe, '');

    // Strip closing-only DSML tags: </||DSML||tagname>
    const closeTagRe = new RegExp(`${FW_DSML_CLOSE_RE  }(\\w+)>`, 'g');
    result = result.replace(closeTagRe, '');
  }

  // Clean up extra blank lines left by tag removal (more than 2 consecutive newlines)
  result = result.replace(/\n{3,}/g, '\n\n');
  return result.trim();
}

/**
 * Optional callback mirroring the stripped (markup-removed) letter-box
 * content to the web UI (serve mode). Set via setResultCallback(); pass
 * null to clear (on serve exit).
 */
let resultCallback: ((content: string) => void) | null = null;

export function setResultCallback(cb: ((content: string) => void) | null): void {
  resultCallback = cb;
}

/**
 * Display text in a pseudo parenthesis-style box with readable green color.
 * Internal markup tags (e.g. DeepSeek DSML) are stripped before display.
 */
export function displayLetterBox(content: string): void {
  const borderColor = chalk.hex('#22c55e'); // Bright green (Tailwind green-500)
  const textColor = chalk.hex('#16a34a'); // Slightly darker green for text (Tailwind green-600)

  const timestamp = getTimestamp();
  const headerText = ` ${timestamp} `;
  const boxWidth = 80;

  const totalEquals = boxWidth - 1 - headerText.length;
  const leftEquals = Math.floor(totalEquals / 2);
  const rightEquals = totalEquals - leftEquals;

  const stripped = stripInternalMarkup(content);

  // If stripping leaves nothing meaningful, show a friendly fallback
  if (!stripped || stripped.trim().length === 0) {
    const fallback = chalk.dim('(no displayable content — internal markup was stripped)');
    process.stdout.write(`\n${borderColor(`.${'='.repeat(leftEquals)}${headerText}${'='.repeat(rightEquals)}.`)}\n`);
    process.stdout.write(`${fallback}\n`);
    process.stdout.write(`${borderColor(`'${'='.repeat(boxWidth - 2)}'`)}\n`);
    if (resultCallback) {
      resultCallback('(no displayable content — internal markup was stripped)');
    }
    return;
  }

  process.stdout.write(`\n${borderColor(`.${'='.repeat(leftEquals)}${headerText}${'='.repeat(rightEquals)}.`)}\n`);
  process.stdout.write(`${textColor(stripped)}\n`);
  process.stdout.write(`${borderColor(`'${'='.repeat(boxWidth - 2)}'`)}\n`);
  if (resultCallback) {
    resultCallback(stripped);
  }
}
