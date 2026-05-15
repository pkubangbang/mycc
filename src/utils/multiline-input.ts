/**
 * multiline-input.ts - Multi-line editing support via popup temp file
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import { openEditor } from './open-editor.js';
import { agentIO } from '../loop/agent-io.js';

/**
 * Generate multiline input temp file content with HTML comment instructions
 * Returns the content and the line number where user content starts
 */
function generateMultilineFile(initialContent: string): { content: string; userContentLine: number } {
  const lines: string[] = [
    '<!--',
    'MULTI-LINE INPUT',
    '================',
    '',
    'Edit this file to compose your multi-line prompt.',
    'The content after this comment block will be submitted.',
    'Save an empty file to cancel.',
    '',
    'Initial input:',
    initialContent,
    '-->',
    '',
    initialContent, // Pre-fill user's initial content
  ];

  // Join lines to get final content
  const content = lines.join('\n');

  // Calculate the actual line number of the last line in the final content
  // This accounts for any newlines in the initialContent
  const allLines = content.split('\n');
  const userContentLine = allLines.length;

  return { content, userContentLine };
}

/**
 * Extract user input from multiline file (strip HTML comments)
 * Returns null if content is empty (user cancelled)
 */
function extractContent(fileContent: string): string | null {
  const content = fileContent.replace(/<!--[\s\S]*?-->/g, '').trim();
  return content || null;
}

/**
 * Write multiline input to temp file and return path
 */
function writeMultilineFile(content: string): string {
  const tempDir = path.join(os.tmpdir(), 'mycc');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const filePath = path.join(tempDir, `input-${timestamp}.md`);
  fs.writeFileSync(filePath, content, 'utf-8');

  return filePath;
}

/**
 * Open editor for multi-line input
 *
 * @param initialContent - The content typed before the trailing backslash
 * @returns Object with action ('submit' or 'reload') and the file content.
 *          'submit' means the user pressed Enter — proceed with the content.
 *          'reload' means the user typed 'r' + Enter — show content on p0 without submitting.
 *          Empty content in 'submit' means the user cancelled.
 */
export async function openMultilineEditor(initialContent: string): Promise<{ action: 'submit' | 'reload', content: string }> {
  // Generate and write temp file
  const { content: fileContent, userContentLine } = generateMultilineFile(initialContent);
  const filePath = writeMultilineFile(fileContent);

  try {
    // Open in editor with cursor at the bottom (user content line)
    openEditor([`${filePath}:${userContentLine}`]);
    console.log(chalk.gray('Opening editor for multi-line input...'));
  } catch (err) {
    console.log(chalk.yellow(`Please edit the file manually: ${filePath}`));
    if (err instanceof Error) {
      console.log(chalk.yellow(err.message));
    }
  }

  // Wait for user — loop allows 'r' + Enter to reload content without submitting
  let answer: string;
  do {
    answer = await agentIO.ask(chalk.cyan('Press Enter to submit (r to return) > '), true);

    if (answer.trim().toLowerCase() === 'r') {
      // User wants to reload: read current file content, return as reload action
      const currentContent = fs.readFileSync(filePath, 'utf-8');
      const reloaded = extractContent(currentContent);

      // Cleanup temp file
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Ignore cleanup errors
      }

      return { action: 'reload', content: reloaded ?? '' };
    }
  } while (answer.trim().toLowerCase() !== '');

  // User pressed Enter: read final content and submit

  // Read and extract content
  const editedContent = fs.readFileSync(filePath, 'utf-8');
  const result = extractContent(editedContent);

  // Cleanup temp file
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore cleanup errors
  }

  return { action: 'submit', content: result ?? '' };
}