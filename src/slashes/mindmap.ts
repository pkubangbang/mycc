/**
 * /mindmap command - Manage agent memory mindmap
 *
 * Usage:
 *   /mindmap compile <file> - Compile markdown to mindmap JSON
 *   /mindmap get <path>     - Get node info by path
 *   /mindmap patch <path> <text> - Update node text
 *   /mindmap validate       - Check mindmap validity
 */

import type { SlashCommand } from '../types.js';
import type { Node } from '../mindmap/types.js';
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

export const mindmapCommand: SlashCommand = {
  name: 'mindmap',
  description: 'Manage agent memory mindmap (/mindmap compile|get|patch|validate)',
  handler: async (context) => {
    const args = context.args.slice(1); // First arg is 'mindmap'
    const subCommand = args[0];

    if (subCommand === 'compile') {
      await handleCompile(context, args[1]);
    } else if (subCommand === 'get') {
      await handleGet(context, args[1]);
    } else if (subCommand === 'patch') {
      await handlePatch(context, args[1], args.slice(2).join(' '));
    } else if (subCommand === 'validate') {
      await handleValidate(context);
    } else {
      showHelp();
    }
  },
};

async function handleCompile(context: { ctx: import('../types.js').AgentContext; args: string[] }, filePath: string | undefined): Promise<void> {
  if (!filePath) {
    console.log(chalk.red('Usage: /mindmap compile <file>'));
    console.log(chalk.gray('  Compile a markdown file to mindmap JSON'));
    return;
  }

  const workDir = context.ctx.core.getWorkDir();
  const fullPath = path.resolve(workDir, filePath);
  
  if (!fs.existsSync(fullPath)) {
    console.log(chalk.red(`File not found: ${fullPath}`));
    return;
  }

  try {
    const mindmap = await context.ctx.mindmap.compile(filePath);
    console.log(chalk.green(`\n✓ Compiled mindmap: ${countNodes(mindmap.root)} nodes`));
    console.log(chalk.gray(`  Source: ${filePath}`));
    console.log(chalk.gray(`  Hash: ${mindmap.hash}`));
    console.log(chalk.gray(`  Saved to: .mycc/mindmap.json`));
  } catch (err) {
    console.log(chalk.red(`Error: ${(err as Error).message}`));
  }
}

async function handleGet(context: { ctx: import('../types.js').AgentContext; args: string[] }, nodePath: string | undefined): Promise<void> {
  // Load mindmap if not loaded
  await context.ctx.mindmap.load();

  const mindmap = context.ctx.mindmap.getMindmap();
  if (!mindmap) {
    console.log(chalk.yellow('No mindmap loaded. Use /mindmap compile <file> first.'));
    return;
  }

  if (!nodePath) {
    // Show root if no path specified
    printNode(mindmap.root, 0);
    return;
  }

  const node = context.ctx.mindmap.getNode(nodePath);
  if (!node) {
    console.log(chalk.red(`Node not found: ${nodePath}`));
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

  // Load mindmap if not loaded
  await context.ctx.mindmap.load();

  try {
    const node = await context.ctx.mindmap.patch(nodePath, text);
    if (!node) {
      console.log(chalk.red(`Node not found: ${nodePath}`));
      return;
    }
    console.log(chalk.green(`\n✓ Updated node: ${nodePath}`));
    console.log(chalk.gray(`  New summary: ${node.summary.slice(0, 100)}...`));
  } catch (err) {
    console.log(chalk.red(`Error: ${(err as Error).message}`));
  }
}

async function handleValidate(context: { ctx: import('../types.js').AgentContext }): Promise<void> {
  // Load mindmap if not loaded
  await context.ctx.mindmap.load();

  const valid = await context.ctx.mindmap.validate();
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
  console.log(chalk.white('  /mindmap compile <file>') + chalk.gray('  - Compile markdown to mindmap JSON'));
  console.log(chalk.white('  /mindmap get <path>') + chalk.gray('     - Get node info (e.g., /skill/example)'));
  console.log(chalk.white('  /mindmap patch <path> <text>') + chalk.gray(' - Update node text'));
  console.log(chalk.white('  /mindmap validate') + chalk.gray('       - Check mindmap validity'));
  console.log();
  console.log(chalk.gray('The mindmap is loaded from .mycc/mindmap.json at startup.'));
  console.log(chalk.gray('Use /mindmap compile CLAUDE.md to create from project context.'));
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
