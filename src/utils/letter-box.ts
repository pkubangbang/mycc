/**
 * letter-box.ts - Display text in a pseudo parenthesis-style box
 */

import chalk from 'chalk';

/**
 * Wrap text to a maximum width, preserving word boundaries
 */
function wrapText(text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  const paragraphs = text.split('\n');

  for (const paragraph of paragraphs) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }

    const words = paragraph.split(/\s+/);
    let currentLine = '';

    for (const word of words) {
      if (currentLine === '') {
        currentLine = word;
      } else if (currentLine.length + 1 + word.length <= maxWidth) {
        currentLine += ` ${  word}`;
      } else {
        lines.push(currentLine);
        currentLine = word;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }
  }

  return lines;
}

/**
 * Get current timestamp in HH:MM:SS format
 */
function getTimestamp(): string {
  const now = new Date();
  return now.toTimeString().slice(0, 8);
}

/**
 * Display text in a pseudo parenthesis-style box with readable green color
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

  // Top border with pseudo parenthesis style and timestamp
  console.log();
  console.log(borderColor(`.${  '='.repeat(leftEquals)  }${headerText  }${'='.repeat(rightEquals)  }.`));
  console.log();

  // Content lines (no side borders, just text)
  for (const line of lines) {
    console.log(`  ${  textColor(line)}`);
  }

  // Bottom border with single quote
  console.log();
  console.log(borderColor(`'${  '='.repeat(boxWidth - 2)  }'`));
  console.log();
}