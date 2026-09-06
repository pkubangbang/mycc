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
 * Regex source: ONE or TWO fullwidth vlines per side of "DSML".
 * Providers differ: DeepSeek emits the double-vline form
 * (<｜｜DSML｜｜tagname>) while some Ollama-hosted models (e.g. GLM) emit the
 * single-vline form (<｜DSML｜tagname>). The {1,2} quantifier must stay
 * OUTSIDE escapeRegex (which escapes braces), so the vline char is escaped
 * alone and the quantifier is appended as raw regex source.
 */
const VLINE_Q = `${escapeRegex(FW_VLINE)}{1,2}`;
const FW_DSML_OPEN_RE = `<${VLINE_Q}DSML${VLINE_Q}`;
const FW_DSML_CLOSE_RE = `</${VLINE_Q}DSML${VLINE_Q}`;

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
 * into the text content stream. These use fullwidth vertical lines (U+FF5C):
 *   <||DSML||tagname>...</||DSML||tagname>
 * where "||" is rendered as two fullwidth vertical bars (U+FF5C).
 */
export function stripInternalMarkup(content: string): string {
  let result = content;

  if (result.includes(FW_VLINE)) {
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
