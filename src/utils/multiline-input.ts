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
 */
function generateMultilineFile(initialContent: string): string {
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

  return lines.join('\n');
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
 * @returns The edited content, or null if cancelled (empty file)
 */
export async function openMultilineEditor(initialContent: string): Promise<string | null> {
  // Generate and write temp file
  const fileContent = generateMultilineFile(initialContent);
  const filePath = writeMultilineFile(fileContent);

  try {
    // Open in editor
    openEditor([filePath]);
    console.log(chalk.gray('Opening editor for multi-line input...'));
  } catch (err) {
    console.log(chalk.yellow(`Please edit the file manually: ${filePath}`));
    if (err instanceof Error) {
      console.log(chalk.yellow(err.message));
    }
  }

  // Wait for user to finish editing
  await agentIO.ask(chalk.cyan('Press Enter when done editing > '));

  // Read and extract content
  const editedContent = fs.readFileSync(filePath, 'utf-8');
  const result = extractContent(editedContent);

  // Cleanup temp file
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore cleanup errors
  }

  return result;
}