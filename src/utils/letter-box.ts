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
 * Display text in a pseudo parenthesis-style box with readable green color.
 * Outputs content exactly as-is, preserving all whitespace.
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

  process.stdout.write(`\n${borderColor(`.${'='.repeat(leftEquals)}${headerText}${'='.repeat(rightEquals)}.`)}\n`);
  process.stdout.write(`${textColor(content)}\n`);
  process.stdout.write(`${borderColor(`'${'='.repeat(boxWidth - 2)}'`)}\n`);
}