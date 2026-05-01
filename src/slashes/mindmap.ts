/**
 * /mindmap command - Manage agent memory mindmap
 *
 * Usage:
 *   /mindmap compile [file] [output] - Compile markdown to mindmap JSON
 *   /mindmap get <path>              - Get node info by path
 *   /mindmap patch <path> <text>     - Update node text
 *   /mindmap validate                - Check mindmap validity
 */

import type { SlashCommand } from '../types.js';
import type { Node } from '../mindmap/types.js';
import {
  get_node,
  compile_mindmap,
  patch_mindmap,
  validate_mindmap,
  save_mindmap,
  load_mindmap,
  get_default_mindmap_path,
} from '../mindmap/index.js';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

export const mindmapCommand: SlashCommand = {
  name: 'mindmap',
  description: 'Manage agent memory mindmap (/mindmap compile|get|patch|validate)',
  handler: async (context) => {
    const query = context.query;

    // Parse command manually to handle paths with spaces
    // Format: /mindmap <subcommand> [args...]
    const match = query.match(/^\/mindmap\s+(\w+)\s*(.*)$/);
    if (!match) {
      showHelp();
      return;
    }

    const subCommand = match[1];
    const remaining = match[2].trim();

    if (subCommand === 'compile') {
      await handleCompile(context, remaining || undefined);
    } else if (subCommand === 'get') {
      await handleGet(context, remaining || undefined);
    } else if (subCommand === 'patch') {
      // Format: /mindmap patch <path> <text>
      // Path ends at first double-space or we need another way to separate
      // For simplicity, require path and text separated by double space
      const patchMatch = remaining.match(/^(\S+)\s+(.+)$/);
      if (patchMatch) {
        await handlePatch(context, patchMatch[1], patchMatch[2]);
      } else {
        console.log(chalk.red('Usage: /mindmap patch <path> <text>'));
        console.log(chalk.gray('  Note: For paths with spaces, use underscores instead'));
      }
    } else if (subCommand === 'validate') {
      await handleValidate(context);
    } else {
      showHelp();
    }
  },
};

async function handleCompile(context: { ctx: import('../types.js').AgentContext; args: string[] }, remaining: string | undefined): Promise<void> {
  // Parse: /mindmap compile [source.md] [output.json]
  const parts = (remaining || '').trim().split(/\s+/).filter(Boolean);

  const sourceFile = parts[0] || 'CLAUDE.md';
  const outputFile = parts[1] || undefined;  // undefined = default .mycc/mindmap.json

  const workDir = context.ctx.core.getWorkDir();
  const fullPath = path.resolve(workDir, sourceFile);

  if (!fs.existsSync(fullPath)) {
    console.log(chalk.red(`File not found: ${sourceFile}`));
    return;
  }

  try {
    console.log(chalk.cyan(`Compiling ${sourceFile}...`));
    const mindmap = await compile_mindmap(sourceFile, workDir, outputFile);

    const outPath = outputFile || '.mycc/mindmap.json';
    console.log(chalk.green(`\n✓ Compiled: ${countNodes(mindmap.root)} nodes`));
    console.log(chalk.gray(`  Source: ${sourceFile}`));
    console.log(chalk.gray(`  Output: ${outPath}`));
    console.log(chalk.gray(`  Hash: ${mindmap.hash}`));
  } catch (err) {
    console.log(chalk.red(`Error: ${(err as Error).message}`));
  }
}

async function handleGet(context: { ctx: import('../types.js').AgentContext; args: string[] }, nodePath: string | undefined): Promise<void> {
  // Load mindmap if not already loaded
  let mindmap = context.ctx.core.getMindmap();
  if (!mindmap) {
    const workDir = context.ctx.core.getWorkDir();
    const mindmapPath = get_default_mindmap_path(workDir);
    if (!fs.existsSync(mindmapPath)) {
      console.log(chalk.yellow('No mindmap found. Use /mindmap compile <file> first.'));
      return;
    }
    mindmap = load_mindmap(mindmapPath);
    context.ctx.core.setMindmap(mindmap);
  }

  if (!nodePath) {
    // Show root if no path specified
    printNode(mindmap.root, 0);
    return;
  }

  // Try exact match first, then try replacing underscores with spaces
  let node = get_node(mindmap, nodePath);
  if (!node) {
    // Try replacing underscores with spaces for paths like /CLAUDE_md/Setup/Unit_Test
    const pathWithSpaces = nodePath.replace(/_/g, ' ');
    node = get_node(mindmap, pathWithSpaces);
  }

  if (!node) {
    console.log(chalk.red(`Node not found: ${nodePath}`));
    console.log(chalk.gray('  Tip: Use underscores for spaces in paths (e.g., /path/Unit_Test)'));
    return;
  }

  printNodeDetails(node);
}

async function handlePatch(context: { ctx: import('../types.js').AgentContext; args: string[] }, nodePath: string | undefined, text: string | undefined): Promise<void> {
  if (!nodePath || !text) {
    console.log(chalk.red('Usage: /mindmap patch <path> <text>'));
    console.log(chalk.gray('  Update a node\'s text and regenerate summaries'));
    return;
  }

  // Load mindmap if not already loaded
  let mindmap = context.ctx.core.getMindmap();
  if (!mindmap) {
    const workDir = context.ctx.core.getWorkDir();
    const mindmapPath = get_default_mindmap_path(workDir);
    if (!fs.existsSync(mindmapPath)) {
      console.log(chalk.yellow('No mindmap found. Use /mindmap compile <file> first.'));
      return;
    }
    mindmap = load_mindmap(mindmapPath);
    context.ctx.core.setMindmap(mindmap);
  }

  try {
    // Try exact match first, then try replacing underscores with spaces
    let node = await patch_mindmap(mindmap, nodePath, text);
    if (!node) {
      const pathWithSpaces = nodePath.replace(/_/g, ' ');
      node = await patch_mindmap(mindmap, pathWithSpaces, text);
    }

    if (!node) {
      console.log(chalk.red(`Node not found: ${nodePath}`));
      return;
    }
    save_mindmap(mindmap);
    console.log(chalk.green(`\n✓ Updated node: ${nodePath}`));
    console.log(chalk.gray(`  New summary: ${node.summary.slice(0, 100)}...`));
  } catch (err) {
    console.log(chalk.red(`Error: ${(err as Error).message}`));
  }
}

async function handleValidate(context: { ctx: import('../types.js').AgentContext }): Promise<void> {
  // Load mindmap if not already loaded
  let mindmap = context.ctx.core.getMindmap();
  if (!mindmap) {
    const workDir = context.ctx.core.getWorkDir();
    const mindmapPath = get_default_mindmap_path(workDir);
    if (!fs.existsSync(mindmapPath)) {
      console.log(chalk.yellow('No mindmap found. Use /mindmap compile <file> first.'));
      return;
    }
    mindmap = load_mindmap(mindmapPath);
    context.ctx.core.setMindmap(mindmap);
  }

  // Find the source markdown file
  const workDir = context.ctx.core.getWorkDir();
  const claudeMd = path.join(workDir, 'CLAUDE.md');

  if (!fs.existsSync(claudeMd)) {
    console.log(chalk.yellow('\n⚠ Cannot validate: CLAUDE.md not found'));
    return;
  }

  const valid = validate_mindmap(mindmap, claudeMd);
  if (valid) {
    console.log(chalk.green('\n✓ Mindmap is valid'));
  } else {
    console.log(chalk.yellow('\n⚠ Mindmap validation failed'));
    console.log(chalk.gray('  The source markdown may have changed. Re-run /mindmap compile'));
  }
}

function showHelp(): void {
  console.log(chalk.cyan('\n/mindmap - Manage agent memory mindmap\n'));
  console.log('Usage:');
  console.log(chalk.white('  /mindmap compile [file] [output]') + chalk.gray(' - Compile markdown to mindmap'));
  console.log(chalk.white('  /mindmap get <path>') + chalk.gray('           - Get node info'));
  console.log(chalk.white('  /mindmap patch <path> <text>') + chalk.gray('   - Update node text'));
  console.log(chalk.white('  /mindmap validate') + chalk.gray('                 - Check mindmap validity'));
  console.log();
  console.log(chalk.gray('Examples:'));
  console.log(chalk.gray('  /mindmap compile                  # CLAUDE.md → .mycc/mindmap.json'));
  console.log(chalk.gray('  /mindmap compile README.md        # README.md → .mycc/mindmap.json'));
  console.log(chalk.gray('  /mindmap compile PLAN.md plan.json # PLAN.md → plan.json'));
  console.log();
  console.log(chalk.gray('Note: Use underscores for spaces in paths (e.g., /CLAUDE_md/Setup/Unit_Test)'));
}

function printNode(node: Node, indent: number): void {
  const prefix = '  '.repeat(indent);
  const levelIcon = node.level === 0 ? '📦' : node.level === 1 ? '📁' : '📄';

  console.log(`${prefix}${levelIcon} ${chalk.cyan(node.title)}`);
  console.log(`${prefix}  ${chalk.gray(node.summary.slice(0, 80))}${node.summary.length > 80 ? '...' : ''}`);

  for (const child of node.children) {
    printNode(child, indent + 1);
  }
}

function printNodeDetails(node: Node): void {
  console.log(chalk.cyan(`\n=== ${node.title} ===\n`));
  console.log(chalk.white('Path:'), chalk.yellow(node.id));
  console.log(chalk.white('Level:'), node.level);
  console.log();

  console.log(chalk.white('Summary:'));
  console.log(chalk.gray(node.summary));
  console.log();

  console.log(chalk.white('Text:'));
  console.log(chalk.gray(node.text.slice(0, 500)) + (node.text.length > 500 ? '...' : ''));
  console.log();

  if (node.children.length > 0) {
    console.log(chalk.white('Children:'));
    for (const child of node.children) {
      console.log(chalk.gray(`  - ${child.title}`));
    }
  }

  if (node.links.length > 0) {
    console.log(chalk.white('Links:'));
    for (const link of node.links) {
      const target = link.node_id || link.file_path || link.url;
      console.log(chalk.gray(`  → ${link.target_type}: ${target}`));
    }
  }
}

function countNodes(node: Node): number {
  let count = 1;
  for (const child of node.children) {
    count += countNodes(child);
  }
  return count;
}