/**
 * steering-boundary.test.ts - A6 import-boundary guard + A2 lifecycle unit tests
 *
 * Gate A6 (plan §8): no `src/loop/**` STEERING consumer may import
 * `src/serve/serve-registry.ts` — loop steering reads/drains must go through
 * the loop-homed manager (`getSteeringManager()`), never hub steering methods.
 * Hub steering methods would side-effect-instantiate a ServeHub in non-serve
 * runs (Δ3 pitfall) and invert the serve→loop dependency direction.
 *
 * The plan's allowlist covers non-steering lifecycle wiring: a handful of
 * loop files legitimately import `getServeHub` for OTHER duties (serve
 * start/stop wiring, output mirroring, ESC wake/display gate, and the
 * steering-adjacent non-steering side effects the loop keeps riding the hub
 * for: the steer-flush broadcast at drain sites and file uploads). The guard
 * therefore enforces the RULE, not a blanket ban:
 *
 *   1. NO src/loop file may reference hub STEERING members
 *      (resolveSteering/pushSteer — the hub's surviving steering surface;
 *      the old drainSteering/getSteeringNotes facades were DELETED in the
 *      same change-set after they lost their last production callers).
 *   2. Imports of serve-registry from src/loop/** outside the explicit
 *      allowlist are a failure (any NEW loop→serve coupling must either join
 *      the reviewed allowlist or go through the manager).
 *
 * The serve-queue module deletion (§4) is also pinned here: no src/serve file
 * may reference the removed `steering-queue` module (it must stay deleted,
 * not shimmed).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_LOOP_DIR = path.resolve(__dirname, '..', '..', '..', 'src', 'loop');
const SRC_SERVE_DIR = path.resolve(__dirname, '..', '..', '..', 'src', 'serve');

/** Files in src/loop/** allowed to import serve-registry (plan §8 A6). */
const SERVE_REGISTRY_ALLOWLIST = new Set([
  // Serve lifecycle wiring: start/stop/restart + output mirroring.
  'agent-repl.ts',
  'serve-wiring.ts',
  'signal-handlers.ts',
  // ESC wrap-up wake/display gate (onWrapUpSettled + isRunning letterbox).
  'esc-wrap-up.ts',
  // Loop states keep the hub ONLY for non-steering duties (steer-flush
  // broadcast at drain sites, file-upload drain, isRunning multiline gate —
  // plan §6 "both already import getServeHub() for other duties").
  'states/collect.ts',
  'states/prompt.ts',
  // Output mirroring / prompt abort plumbing (pre-existing, non-steering).
  'agent-io.ts',
]);

/** Hub STEERING members loop code must never call (A6 + Δ3).
 * resolveSteering/pushSteer are the hub's SURVIVING steering surface (the WS
 * resolve path and the write point). drainSteering/getSteeringNotes were
 * deleted from the hub — loop code reads the manager directly, and a call to
 * the removed members would fail typecheck, so only the live members need
 * the runtime regex guard. */
const HUB_STEERING_MEMBERS = [
  'resolveSteering',
  'pushSteer',
] as const;

/** Recursively collect .ts files under dir. */
function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectTsFiles(full, acc);
    else if (entry.isFile() && entry.name.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

describe('A6 import boundary — loop steering reads go through the manager', () => {
  it('no src/loop file calls hub steering methods (resolveSteering/pushSteer)', () => {
    const files = collectTsFiles(SRC_LOOP_DIR);
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(SRC_LOOP_DIR, file).replaceAll('\\', '/');
      const text = fs.readFileSync(file, 'utf-8');
      for (const member of HUB_STEERING_MEMBERS) {
        // Match a member CALL (`.getSteeringNotes(`), not a doc-comment
        // mention (comments discuss the methods without a call-site dot).
        if (new RegExp(`\\.${member}\\s*\\(`).test(text)) {
          offenders.push(`${rel} → hub method .${member}()`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('serve-registry imports from src/loop/** are confined to the reviewed allowlist', () => {
    const files = collectTsFiles(SRC_LOOP_DIR);
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(SRC_LOOP_DIR, file).replaceAll('\\', '/');
      if (SERVE_REGISTRY_ALLOWLIST.has(rel)) continue;
      const text = fs.readFileSync(file, 'utf-8');
      if (text.includes('serve/serve-registry')) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no src/serve file references the deleted steering-queue module (not shimmed)', () => {
    const files = collectTsFiles(SRC_SERVE_DIR);
    const offenders = files
      .map((f) => ({ f, text: fs.readFileSync(f, 'utf-8') }))
      .filter(({ f, text }) => !f.endsWith('steering-queue.ts') && text.includes('steering-queue'));
    expect(offenders.map(({ f }) => path.basename(f))).toEqual([]);
  });

  it('src/serve/steering-queue.ts is deleted', () => {
    expect(fs.existsSync(path.join(SRC_SERVE_DIR, 'steering-queue.ts'))).toBe(false);
  });
});