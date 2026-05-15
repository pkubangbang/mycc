/**
 * letter-box.ts - Display text in a pseudo parenthesis-style box
 */

import chalk from 'chalk';

/**
 * Wrap text to a maximum width.
 * Lines within maxWidth are preserved exactly (all whitespace intact).
 * Lines exceeding maxWidth are wrapped at word boundaries.
 */
function wrapText(text: string, maxWidth: number): string[] {
  const result: string[] = [];
  const paragraphs = text.split('\n');

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxWidth) {
      // Short enough — preserve exactly, including all whitespace
      result.push(paragraph);
    } else {
      // Too long — wrap at word boundaries with leading indent preserved
      const indentMatch = paragraph.match(/^(\s+)/);
      const indent = indentMatch ? indentMatch[1] : '';
      const content = indentMatch ? paragraph.slice(indent.length) : paragraph;

      const words = content.split(/\s+/).filter(w => w.length > 0);
      let currentLine = indent;

      for (const word of words) {
        const potentialLine = currentLine === indent ? indent + word : `${currentLine} ${word}`;

        if (potentialLine.length <= maxWidth) {
          currentLine = potentialLine;
        } else {
          if (currentLine !== indent) {
            result.push(currentLine);
          }
          currentLine = indent + word;
        }
      }

      if (currentLine && currentLine !== indent) {
        result.push(currentLine);
      }
    }
  }

  return result;
}

/**
 * Get current timestamp in HH:MM:SS format
 */
function getTimestamp(): string {
  const now = new Date();
  return now.toTimeString().slice(0, 8);
}

/**
 * Display text in a pseudo parenthesis-style box with readable green color.
 * Uses raw process.stdout.write to preserve all whitespace exactly.
 * @param content - The text content to display
 * @param maxWidth - Maximum width for the box (default: 76 for typical terminals)
 */
export function displayLetterBox(content: string, maxWidth = 76): void {
  // Use bright green that's readable in both light and dark mode
  const borderColor = chalk.hex('#22c55e'); // Bright green (Tailwind green-500)
  const textColor = chalk.hex('#16a34a'); // Slightly darker green for text (Tailwind green-600)

  // Wrap content to fit inside the box
  const innerWidth = maxWidth - 4;
  const lines = wrapText(content, innerWidth);

  // Get timestamp for the header
  const timestamp = getTimestamp();
  const headerText = ` ${timestamp} `;

  // Fixed width for the box (use maxWidth or at least 40)
  const boxWidth = Math.max(maxWidth, 40);

  // Calculate equal signs on each side of timestamp
  const totalEquals = boxWidth - 1 - headerText.length; // -1 for '.' at start
  const leftEquals = Math.floor(totalEquals / 2);
  const rightEquals = totalEquals - leftEquals;

  // Build entire output as a single string to preserve whitespace
  const output: string[] = [];

  output.push(`\n${borderColor(`.${'='.repeat(leftEquals)}${headerText}${'='.repeat(rightEquals)}.`)}`);

  // Content lines (no side borders, just text, preserve all whitespace)
  for (const line of lines) {
    output.push(`  ${textColor(line)}`);
  }

  // Bottom border with single quote
  output.push(`${borderColor(`'${'='.repeat(boxWidth - 2)}'`)}\n`);

  process.stdout.write(output.join('\n'));
}