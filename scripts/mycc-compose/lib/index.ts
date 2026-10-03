/**
 * index.ts — umbrella module re-exporting the CLI helpers + subcommands.
 *
 * The thin .js bin shim (mycc-compose.js) registers the tsx ESM loader then
 * dynamically imports THIS file alone — so the .js↔.ts boundary is a single
 * import. Adding a new subcommand only requires editing this file, not the .js.
 */

// CLI helpers used by the shim's router
export { HELP, dieUsage, dieError, out, warn, parseCliArgs } from './cli.js';
export type { CliArgs } from './cli.js';

// Subcommands — each in its own module
export { cmdCheck } from './cmd-check.js';
export { cmdUp } from './cmd-up.js';
export { cmdDown } from './cmd-down.js';
export { cmdStatus } from './cmd-status.js';