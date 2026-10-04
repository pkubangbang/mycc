/**
 * typecheck-parallel.mjs — run all four tsc configs in parallel, fail fast if
 * any exits non-zero.
 *
 * Why: `npm test` chained the four typechecks with `&&` (fully sequential),
 * which on a cold cache pushed the full `pnpm test` past the 60s tool timeout.
 * The four configs are independent (no shared emit), so running them
 * concurrently cuts the typecheck wall-time to the slowest one. vitest still
 * runs AFTER this script (in package.json `test`), so a typecheck failure
 * short-circuits before vitest is spawned.
 *
 * Bins are invoked as `node <resolved JS entry>` rather than bare `tsc`/
 * `vue-tsc`: a bare spawn with `shell:true` on Windows hits cmd.exe, which does
 * not find the `.CMD` shims in node_modules/.bin the way npm's script runner
 * does, and `shell:true` with args also triggers Node's DEP0190 warning. The
 * JS entries (`typescript/bin/tsc`, `vue-tsc/bin/vue-tsc.js`) are resolved via
 * `createRequire` so they work under pnpm's isolated symlink layout too.
 *
 * Exit code is non-zero if ANY config fails; stdout/stderr from each is
 * prefixed with its label so a failure names the offending config.
 */
import { spawn } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tscBin = require.resolve('typescript/bin/tsc');
const vueTscBin = require.resolve('vue-tsc/bin/vue-tsc.js');

const configs = [
  ['main', tscBin, ['--noEmit']],
  ['test', tscBin, ['--noEmit', '-p', 'tsconfig.test.json']],
  ['scripts', tscBin, ['--noEmit', '-p', 'tsconfig.scripts.json']],
  ['web', vueTscBin, ['--noEmit', '-p', 'src/web/tsconfig.json']],
];

const runs = configs.map(([label, cmd, args]) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [cmd, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const prefix = `[${label}] `;
    const tag = (s) => s.split('\n').map((l) => (l ? prefix + l : l)).join('\n');
    child.stdout.on('data', (d) => process.stdout.write(tag(d.toString())));
    child.stderr.on('data', (d) => process.stderr.write(tag(d.toString())));
    child.on('exit', (code) => resolve({ label, code: code ?? 1 }));
    child.on('error', (err) => {
      process.stderr.write(`${prefix}${err.message}\n`);
      resolve({ label, code: 1 });
    });
  }),
);

const results = await Promise.all(runs);
const failed = results.filter((r) => r.code !== 0);
if (failed.length > 0) {
  process.stderr.write(`\ntypecheck failed: ${failed.map((r) => r.label).join(', ')}\n`);
  process.exit(1);
}