/**
 * /config command - show the EFFECTIVE configuration with provenance
 *
 * Answers "which layer won?" (row lead-013). The four merge layers
 * (user .env → project .env → system env → CLI) are flattened into
 * `process.env` at boot, so without this the only way to attribute a value is
 * to read the .env files by hand.
 */

import chalk from 'chalk';
import type { SlashCommand } from '../types.js';
import { describeEffectiveConfig } from '../config.js';

export const configCommand: SlashCommand = {
  name: 'config',
  description: 'Show the effective configuration and which layer supplied each value',
  handler: (context) => {
    // Optional filter: `/config TOKEN_THRESHOLD OLLAMA_MODEL`.
    const keys = context.args.slice(1).map(a => a.toUpperCase()).filter(Boolean);
    const entries = describeEffectiveConfig(keys.length > 0 ? keys : undefined);
    if (entries.length === 0) {
      console.log(chalk.gray('No known configuration keys matched.'));
      return;
    }
    console.log(chalk.cyan('Effective configuration (value — source):'));
    for (const e of entries) {
      const source = e.source === 'cli'
        ? chalk.green(e.source)
        : e.source === 'default'
          ? chalk.gray(e.source)
          : chalk.yellow(e.source);
      console.log(`  ${chalk.bold(e.key.padEnd(26))} ${e.value.padEnd(24)} ${source}`);
    }
    console.log(chalk.gray('\nLayers (lowest → highest): user .env → project .env → system env → CLI flags.'));
  },
};
