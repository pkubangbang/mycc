#!/usr/bin/env node
/**
 * Repo formatter — the single owner of "which files are formatted".
 *
 * Why a script instead of a glob in package.json: `pnpm format` and
 * `pnpm format:check` must agree with each other EXACTLY, and the scope has to
 * live in one place. Two hand-maintained globs (one per script) drift apart the
 * moment a directory is added, and then a file is "formatted" by a run nobody
 * gates. Deriving the list from `git ls-files` also guarantees the one property
 * globs get wrong: build output, `node_modules`, `.mycc` and untracked scratch
 * files can never be reformatted, because git never reports them.
 *
 * A plain `.js` (not `.mjs`) on purpose: `eslint.config.mjs` lints `**\/*.js`
 * with Node globals, so this script is itself linted and formatted by the very
 * gates it drives.
 *
 * Scope
 *   IN   `src/**`               code + text assets (see CODE_EXT / ASSET_EXT)
 *        `scripts/**`           plain-node entry shims and the compose helper
 *        `eslint-rules/**`      the local eslint plugin sources
 *        root-level config      the flat config, tsconfigs, package.json
 *   OUT  `src/tests/**`         eslint ignores tests; formatting them would
 *                               churn fixtures for a gate that never sees them
 *        `src/web/dist/**`      build output
 *        `dist/**`              build output
 *        `**\/*.md`              docs are authored prose — they are formatted
 *                               by hand. `proseWrap: preserve` keeps paragraphs
 *                               intact, but code fences and tables still get
 *                               rewritten, and changelog prose reads worse
 *                               after a machine has reflowed it.
 *        `**\/*.sh`             shell; `.gitattributes` `text eol=lf` is the
 *                               real guard there
 *        anything gitignored     see above — `git ls-files` is the filter
 *
 * Usage
 *   node scripts/format.js            check only (default) — exit 1 on drift
 *   node scripts/format.js --write    rewrite in place
 *   node scripts/format.js --check    same as the default, explicit
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');

/** prettier's bin, resolved once. Spawned with `node` — no shell, no `npx`. */
const PRETTIER_BIN = path.join(ROOT, 'node_modules', 'prettier', 'bin', 'prettier.cjs');

/**
 * Windows caps a whole command line at 32767 chars; 350+ paths in one
 * `execFileSync` blows past it with an opaque E2BIG. Chunk the file list so the
 * argv stays comfortably under the cap on every platform, and so a failure
 * names the chunk it happened in instead of the whole repo.
 */
const MAX_ARGV_CHARS = 12000;
const MAX_FILES_PER_BATCH = 120;

/** Extensions prettier formats when they appear under an in-scope directory. */
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.vue']);
/** Text assets that have no eslint story but must still agree on layout. */
const ASSET_EXT = new Set(['.css', '.scss', '.html', '.json', '.yml', '.yaml']);

/** Directory prefixes whose full contents are in scope. */
const IN_SCOPE_DIRS = ['scripts/', 'eslint-rules/'];
/** Paths excluded even when their parent directory is in scope. */
const EXCLUDED_PREFIXES = ['src/tests/', 'src/web/dist/', 'dist/', 'src/tests/fixtures/'];

/** Root-level config files (the flat config, tsconfigs, package.json). */
const ROOT_FILE = /^[^/]+\.(mjs|js|cjs|json|ts)$/;

/**
 * Files to hand to prettier, repo-relative with forward slashes.
 * `git ls-files -z` gives tracked files only — gitignored output and
 * untracked scratch files are excluded by construction.
 */
function collectFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  const tracked = out.split('\0').filter(Boolean);
  return tracked.filter(file => {
    const ext = path.extname(file).toLowerCase();
    if (!CODE_EXT.has(ext) && !ASSET_EXT.has(ext)) return false;
    if (EXCLUDED_PREFIXES.some(p => file.startsWith(p))) return false;
    if (file.startsWith('src/') || IN_SCOPE_DIRS.some(d => file.startsWith(d))) return true;
    return ROOT_FILE.test(file);
  });
}

/** Split files into chunks that keep each pretty command line short. */
function chunkByArgv(files) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const file of files) {
    // +3 accounts for the separating space and worst-case quoting.
    if (current.length > 0 && (size + file.length + 3 > MAX_ARGV_CHARS || current.length >= MAX_FILES_PER_BATCH)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += file.length + 3;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const files = collectFiles();

  if (files.length === 0) {
    console.error('[format] no in-scope files found — is this a git checkout?');
    process.exit(1);
  }

  if (!existsSync(PRETTIER_BIN)) {
    console.error(`[format] prettier not found at ${PRETTIER_BIN} — run \`pnpm install\``);
    process.exit(1);
  }

  const missing = files.filter(f => !existsSync(path.join(ROOT, f)));
  if (missing.length > 0) {
    // A tracked-but-deleted file is normal mid-refactor; prettier would error.
    for (const f of missing) console.error(`[format] skipping deleted file ${f}`);
  }
  const present = files.filter(f => !missing.includes(f));

  const mode = write ? '--write' : '--check';
  let failed = 0;
  for (const chunk of chunkByArgv(present)) {
    try {
      execFileSync(process.execPath, [PRETTIER_BIN, mode, '--log-level', 'warn', ...chunk], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
    } catch (error) {
      // Never swallow the reason: prettier exits non-zero for BOTH "needs
      // formatting" and a real parse error, and a bare "failed" once cost a
      // debugging round trip. Surface its output, then classify below.
      failed += 1;
      if (error.stdout) process.stderr.write(error.stdout);
      if (error.stderr) process.stderr.write(error.stderr);
      console.error(
        `[format] prettier ${mode} exited ${error.status ?? '?'}` +
          (error.signal ? ` (signal ${error.signal})` : '') +
          ` on a batch of ${chunk.length} file(s)`,
      );
    }
  }

  if (failed > 0) {
    if (write) {
      console.error(`[format] ${failed} batch(es) failed — see the errors above.`);
      process.exit(1);
    }
    console.error(
      `\n[format] ${present.length} file(s) checked, ${failed} batch(es) reported drift.` +
        '\n[format] Run `pnpm format` to rewrite them, then re-run this check.',
    );
    process.exit(1);
  }

  console.log(`[format] ${write ? 'formatted' : 'checked'} ${present.length} file(s) — OK`);
}

main();
