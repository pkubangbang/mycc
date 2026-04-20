/**
 * /domain command - List all wiki domains
 *
 * Usage:
 *   /domain         - List all registered domains
 *   /domain add <name> - Add a new domain (prompts for description)
 */

import type { SlashCommand, WikiDomain } from '../types.js';
import * as fs from 'fs';
import chalk from 'chalk';
import { getWikiDomainsFile, ensureDirs } from '../config.js';

export const domainCommand: SlashCommand = {
  name: 'domain',
  description: 'List wiki domains',
  handler: async (context) => {
    const args = context.args.slice(1); // First arg is 'domain'

    if (args[0] === 'add') {
      const name = args[1];
      if (!name) {
        console.log(chalk.red('Usage: /domain add <name>'));
        return;
      }
      // Bind question to core context to preserve 'this'
      await handleAdd(context.ctx.core.question.bind(context.ctx.core), name);
    } else {
      await handleList();
    }
  },
};

async function handleList(): Promise<void> {
  ensureDirs();
  const domainsFile = getWikiDomainsFile();

  // Create file if it doesn't exist
  if (!fs.existsSync(domainsFile)) {
    fs.writeFileSync(domainsFile, '[]', 'utf-8');
    console.log(chalk.yellow('\nNo domains registered.'));
    console.log(chalk.gray('Use /domain add <name> to add a domain.'));
    return;
  }

  // Load domains
  let domains: WikiDomain[] = [];
  try {
    domains = JSON.parse(fs.readFileSync(domainsFile, 'utf-8'));
  } catch {
    domains = [];
  }

  if (domains.length === 0) {
    console.log(chalk.yellow('\nNo domains registered.'));
    console.log(chalk.gray('Use /domain add <name> to add a domain.'));
    return;
  }

  // Display domains
  console.log(chalk.cyan('\n=== Registered Domains ===\n'));
  for (const domain of domains) {
    console.log(chalk.white(`  ${domain.domain_name}`));
    if (domain.description) {
      console.log(chalk.gray(`    ${domain.description}`));
    }
  }
  console.log();
}

async function handleAdd(question: (query: string, asker: string) => Promise<string>, name: string): Promise<void> {
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

  // Prompt for description
  const description = await question(
    `Add a description for "${name}" (optional, press Enter to skip): `,
    'domain'
  );

  // Add new domain
  domains.push({
    domain_name: name,
    description: description.trim(),
    created_at: new Date().toISOString(),
    project_folder: process.cwd(),
  });

  // Save
  fs.writeFileSync(domainsFile, JSON.stringify(domains, null, 2), 'utf-8');
  console.log(chalk.green(`\nDomain "${name}" added.`));
}