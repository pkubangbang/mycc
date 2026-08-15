#!/usr/bin/env node
/**
 * mycc-pretty-print — Pretty-print files for terminal display
 *
 * Thin CLI dispatcher: parses --type and --help, then delegates to the
 * formatter module matching the type. Each formatter exports a
 * `format(filePath)` function that reads the file and returns the formatted
 * text (printed to stdout).
 *
 * Exposed as the `mycc-pretty-print` bin by the parent mycc package
 * (see package.json `bin`). After `npm link` (or a global install of mycc),
 * invoke from any directory:
 *
 *   mycc-pretty-print --type=crossroad <path>
 *
 * To add a new formatter:
 *   1. Create a sibling module (e.g. diagram-md.js) exporting `format(filePath)`.
 *   2. Register it in the FORMATTERS map below.
 *   3. Add a line to the --help TYPES section.
 *
 * Run directly during development:
 *   node scripts/pretty-print/pretty-print.js --type=crossroad <path>
 */

import { format as formatCrossroad } from './crossroad.js';

/**
 * Registry of type → formatter function.
 * Each formatter reads the file and returns formatted text for stdout.
 */
const FORMATTERS = {
  crossroad: formatCrossroad,
};

const HELP = `mycc-pretty-print — Pretty-print files for terminal display

Usage:
  mycc-pretty-print --type=<type> <path>

Types:
  crossroad    Merge prefix + continuation from a crossroad record JSON

Examples:
  mycc-pretty-print --type=crossroad .mycc/sessions/abc/crossroad-1700000000000.json`;

/**
 * Parse argv into { type, help, path }.
 * Recognizes --type=<value>, --help (or -h), and a trailing positional path.
 * Unknown flags are ignored (forward-compatibility).
 */
function parseArgs(argv) {
  let type;
  let help = false;
  let path;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg.startsWith('--type=')) {
      type = arg.slice('--type='.length);
    } else if (!arg.startsWith('-')) {
      // First non-flag argument is the file path
      if (!path) path = arg;
    }
  }

  return { type, help, path };
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (!args.type) {
    console.error('Error: --type is required. Run with --help for usage.');
    process.exit(1);
  }

  const formatter = FORMATTERS[args.type];
  if (!formatter) {
    console.error(
      `Error: unknown type "${args.type}". Available types: ${Object.keys(FORMATTERS).join(', ')}`
    );
    process.exit(1);
  }

  if (!args.path) {
    console.error('Error: a file path is required. Run with --help for usage.');
    process.exit(1);
  }

  try {
    const output = formatter(args.path);
    process.stdout.write(output);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();