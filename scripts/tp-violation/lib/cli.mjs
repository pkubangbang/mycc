/**
 * tp-violation / lib/cli — shared bootstrap for the two provider legs.
 *
 * Owns the pieces that are identical whether we are talking to DeepSeek or
 * Ollama:
 *   - `HERE` / `REPO` path anchors
 *   - `registerTsx()` — Node must be told how to load `.ts` before any import
 *   - `loadFacade()` — lazy import of the real Triologue facade
 *   - the facade-driven phase 1 (producer-order matrix) and phase 3 (wire cases)
 *   - `createInconclusive()` — a tiny counter both legs share
 *
 * The provider-specific bits (which expectation field to grade against, which
 * HTTP status is "expected") live in `deepseek.mjs` and `ollama.mjs`.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..', '..', '..');

/** Read one `--name=value` CLI flag. */
export const flag = (n) => process.argv.slice(2).find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
/** True iff a bare `--name` flag is present. */
export const has = (n) => process.argv.slice(2).includes(`--${n}`);

export const OFFLINE = has('mock');
/** Only run the exhaustive sequence matrix (skip the facade phases). */
export const ONLY_SEQ = has('sequences');
/** Print every row, not just the mismatches/interesting ones. */
export const VERBOSE = has('verbose');

/**
 * Register the tsx ESM loader. The facade (and its provider layer) are
 * TypeScript; Node must be told how to load a `.ts` module before ANY dynamic
 * import of one. Registration has to happen at the top of the entry module so
 * it is in force for every import below it.
 */
export async function registerTsx() {
  const { register } = await import('tsx/esm/api');
  register();
}

/** Lazily import the real Triologue facade (never a hand-mock). */
export async function loadFacade() {
  return import(pathToFileURL(join(REPO, 'src/loop/triologue.ts')).href);
}

/** A shared error counter — non-zero means the run is INCONCLUSIVE. */
export function createInconclusive() {
  let n = 0;
  return { bump: () => ++n, get: () => n };
}

/**
 * Phase 1 — drive the REAL facade through every producer order that can
 * interleave with tool calls, and judge the sequence it builds. Offline; no
 * provider needed (the facade is never hand-mocked).
 */
export function runMatrix(Triologue, isIllegal, MATRIX, describe) {
  console.log('── phase 1: producer-order matrix (real facade, offline) ──\n');
  const built = [];
  let breaches = 0;
  for (const c of MATRIX) {
    const t = new Triologue({ onMessage: () => {}, tokenThreshold: 50000, resultThreshold: 100000 });
    t.user('task');
    let threw = null;
    try { c.build(t); } catch (e) { threw = e; }
    if (threw) {
      console.log(`  [threw] ${c.name}\n          ${String(threw.message).slice(0, 100)}`);
      built.push({ c, msgs: null, illegal: false });
      continue;
    }
    const msgs = t.getMessages();
    const illegal = isIllegal(msgs);
    const ok = c.expect === 'legal' ? !illegal : illegal;
    if (!ok) breaches++;
    console.log(`  [${ok ? 'ok ' : 'BAD'}] ${c.name}`);
    console.log(`          ${describe(msgs)}${illegal ? '   ← ILLEGAL' : ''}`);
    built.push({ c, msgs, illegal });
  }
  return { built, breaches };
}

/** Phase 3 — the coarse hand-built wire cases (provider tolerance). */
export async function runWireCases(MOCK, post, isIllegal) {
  console.log('\n── phase 3: hand-built wire cases (provider tolerance) ──\n');
  const rows = [];
  for (const [label, msgs] of Object.entries(MOCK)) {
    process.stdout.write(`  ${label}... `);
    const r = await post(msgs);
    console.log(`${r.status}  ${r.detail.slice(0, 90)}`);
    rows.push({ label, ...r, illegal: isIllegal(msgs) });
  }
  return rows;
}
