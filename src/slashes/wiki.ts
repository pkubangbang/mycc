/**
 * /wiki command - Manage knowledge base WAL files and domains
 *
 * Usage:
 *   /wiki                      - Show today's WAL file
 *   /wiki edit [date]          - Open WAL file for editing (YYYY-MM-DD)
 *   /wiki rebuild              - Rebuild vector store from all WAL files
 *   /wiki delete <hash>        - Delete document from vector store by hash
 *   /wiki domains              - List all domains
 *   /wiki domains add <name> <description>  - Add domain
 *   /wiki domains remove <name>             - Remove domain
 */

import type { SlashCommand, WikiModule, WALEntry, WikiDomain } from '../types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import { getWikiLogsDir, getWikiDomainsFile, ensureDirs } from '../config.js';
import { openEditor } from '../utils/open-editor.js';

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export const wikiCommand: SlashCommand = {
  name: 'wiki',
  description: 'Manage knowledge base (/wiki [edit|rebuild|domains])',
  handler: async (context) => {
    const args = context.args.slice(1); // First arg is 'wiki'

    if (args[0] === 'edit') {
      // Edit WAL file
      const date = args[1] || formatDate(new Date());
      await handleEdit(context.ctx.wiki, date);
    } else if (args[0] === 'rebuild') {
      // Rebuild vector store
      await handleRebuild(context.ctx.wiki);
    } else if (args[0] === 'delete') {
      // Delete document by hash
      await handleDelete(context.ctx.wiki, args[1]);
    } else if (args[0] === 'domains') {
      // Domain management
      await handleDomains(context.ctx.wiki, args.slice(1));
    } else {
      // Show today's WAL
      const today = formatDate(new Date());
      await handleShow(context.ctx.wiki, today);
    }
  },
};

async function handleShow(wiki: WikiModule, date: string): Promise<void> {
  const entries = await wiki.getWAL(date);

  if (entries.length === 0) {
    console.log(chalk.yellow(`No WAL entries for ${date}`));
    return;
  }

  console.log(chalk.cyan(`\n=== WAL for ${date} ===\n`));
  console.log(wiki.formatWAL(entries));
}

async function handleEdit(wiki: WikiModule, date: string): Promise<void> {
  ensureDirs();
  const walDir = getWikiLogsDir();
  const walPath = path.join(walDir, `${date}.wal`);

  // Create file if it doesn't exist
  if (!fs.existsSync(walPath)) {
    fs.writeFileSync(walPath, '', 'utf-8');
  }

  // Get current entries
  const entries = await wiki.getWAL(date);
  const asciiContent = wiki.formatWAL(entries);

  // Write to temp file
  const tempFile = path.join(os.tmpdir(), `wiki-${date}-${Date.now()}.txt`);
  fs.writeFileSync(tempFile, asciiContent, 'utf-8');

  console.log(chalk.gray(`Opening ${date}.wal for editing...`));

  try {
    // Open editor using the utility (handles both terminal and GUI editors)
    await openEditor([tempFile]);

    // Read back edited content
    const editedContent = fs.readFileSync(tempFile, 'utf-8');

    // Parse and validate
    const newEntries = wiki.parseWAL(editedContent);

    // Write back to WAL file as JSON lines
    const jsonLines = newEntries.map((e: WALEntry) => JSON.stringify(e)).join('\n');
    fs.writeFileSync(walPath, `${jsonLines  }\n`, 'utf-8');

    console.log(chalk.green(`WAL updated: ${newEntries.length} entries`));
  } finally {
    // Clean up temp file
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}

async function handleRebuild(wiki: WikiModule): Promise<void> {
  console.log(chalk.cyan('\nRebuilding vector store from WAL files...\n'));

  const result = await wiki.rebuild();

  if (result.success) {
    console.log(chalk.green(`\nRebuild complete: ${result.documentsProcessed} documents processed`));

    if (result.errors.length > 0) {
      console.log(chalk.yellow('\nErrors:'));
      for (const error of result.errors) {
        console.log(chalk.yellow(`  - ${error}`));
      }
    }
  } else {
    console.log(chalk.red('\nRebuild failed:'));
    for (const error of result.errors) {
      console.log(chalk.red(`  - ${error}`));
    }
  }
}

async function handleDelete(wiki: WikiModule, hash: string | undefined): Promise<void> {
  if (!hash) {
    console.log(chalk.red('Usage: /wiki delete <hash>'));
    console.log(chalk.gray('Use /wiki to view WAL entries and find the hash.'));
    return;
  }

  // Validate hash format (16 hex characters)
  if (!/^[a-f0-9]{16}$/.test(hash)) {
    console.log(chalk.red(`Invalid hash format: ${hash}`));
    console.log(chalk.gray('Hash must be 16 hexadecimal characters (e.g., a1b2c3d4e5f67890)'));
    return;
  }

  const deleted = await wiki.delete(hash);

  if (deleted) {
    console.log(chalk.green(`\nDocument ${hash} deleted successfully.`));
    console.log(chalk.gray('The deletion has been marked in the original WAL file.'));
  } else {
    console.log(chalk.yellow(`\nDocument ${hash} not found.`));
  }
}

async function handleDomains(wiki: WikiModule, args: string[]): Promise<void> {
  const subCommand = args[0];

  if (subCommand === 'add') {
    const name = args[1];
    const description = args.slice(2).join(' ') || '';

    if (!name) {
      console.log(chalk.red('Usage: /wiki domains add <name> [description]'));
      return;
    }

    await addDomain(name, description);
  } else if (subCommand === 'remove') {
    const name = args[1];

    if (!name) {
      console.log(chalk.red('Usage: /wiki domains remove <name>'));
      return;
    }

    await removeDomain(name);
  } else {
    // List domains
    await listDomains(wiki);
  }
}

async function listDomains(wiki: WikiModule): Promise<void> {
  const domains = await wiki.listDomains();

  if (domains.length === 0) {
    console.log(chalk.yellow('\nNo domains registered.'));
    console.log(chalk.gray('Use /wiki domains add <name> [description] to add a domain.'));
    return;
  }

  console.log(chalk.cyan('\n=== Registered Domains ===\n'));
  for (const domain of domains) {
    console.log(chalk.white(`  ${domain.domain_name}`));
    if (domain.description) {
      console.log(chalk.gray(`    ${domain.description}`));
    }
    console.log(chalk.gray(`    Created: ${domain.created_at}`));
    console.log(chalk.gray(`    Project: ${domain.project_folder}`));
    console.log();
  }
}

async function addDomain(name: string, description: string): Promise<void> {
  ensureDirs();
  const domainsFile = getWikiDomainsFile();

  // Load existing domains
  let domains: WikiDomain[] = [];
  if (fs.existsSync(domainsFile)) {
    try {
      domains = JSON.parse(fs.readFileSync(domainsFile, 'utf-8'));
    } catch {
      domains = [];
    }
  }

  // Check if domain already exists
  if (domains.find(d => d.domain_name === name)) {
    console.log(chalk.yellow(`Domain "${name}" already exists.`));
    return;
  }

  // Add new domain
  domains.push({
    domain_name: name,
    description,
    created_at: new Date().toISOString(),
    project_folder: process.cwd(),
  });

  // Save
  fs.writeFileSync(domainsFile, JSON.stringify(domains, null, 2), 'utf-8');
  console.log(chalk.green(`Domain "${name}" added.`));
}

async function removeDomain(name: string): Promise<void> {
  ensureDirs();
  const domainsFile = getWikiDomainsFile();

  // Load existing domains
  let domains: WikiDomain[] = [];
  if (fs.existsSync(domainsFile)) {
    try {
      domains = JSON.parse(fs.readFileSync(domainsFile, 'utf-8'));
    } catch {
      domains = [];
    }
  }

  // Find and remove domain
  const index = domains.findIndex(d => d.domain_name === name);
  if (index === -1) {
    console.log(chalk.yellow(`Domain "${name}" not found.`));
    return;
  }

  domains.splice(index, 1);

  // Save
  fs.writeFileSync(domainsFile, JSON.stringify(domains, null, 2), 'utf-8');
  console.log(chalk.green(`Domain "${name}" removed.`));
}