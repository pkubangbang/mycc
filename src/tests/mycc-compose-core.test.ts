/**
 * mycc-compose-core.test.ts - merged spec / shim-parse / channels / peers suites.
 *
 * Consolidation of four root-level mycc-compose suites that share one subject
 * (the compose SPEC + the pure channel-file data layer + launcher identity
 * resolution) and are exercised without any command pipeline:
 *
 *   - mycc-compose-spec.test.ts        validateSpec / loadSpec / updateSpecFile /
 *                                      validatePeerName + the launcher flag table.
 *   - mycc-compose-shim-parse.test.ts  parseCmdShim through the launchPeer
 *                                      spawnImpl seam (win32 `%_prog%` shims).
 *   - mycc-compose-channels.test.ts    channel-file materializer (build / read /
 *                                      atomic write / remove / status).
 *   - mycc-compose-peers.test.ts       peer identity + liveness (stopPeer,
 *                                      launchPeer, repairIdentity, peerArgv).
 *
 * Each source suite is preserved VERBATIM inside its own scoped `describe()`
 * block: the suite-local `beforeEach`/`afterEach` (temp dirs, MYCC_* env
 * overrides, module resets) stay scoped to that block, so the four suites never
 * observe each other's store root. Test bodies, names and assertions are
 * unchanged - only the file boundary moved.
 *
 * Shared fixtures:
 *   - `hook` is the single hoisted injection point for the wrapped `fs`
 *     module: the channels suite injects rename failures / post-rename
 *     corruption, the peers suite injects a concurrent register() into
 *     repairIdentity's read -> write window. Both wrappers delegate to the real
 *     `fs` and are inert unless the owning suite arms them (every suite's
 *     beforeEach disarms all four callbacks).
 *   - `fs.renameSync` / `fs.readFileSync` are WRAPPED (never replaced) so the
 *     real filesystem semantics stay in force.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type SpawnOptions, type ChildProcess } from 'child_process';
import {
  validateSpec,
  loadSpec,
  updateSpecFile,
  validatePeerName,
} from '../../scripts/mycc-compose/lib/spec.js';
import { parseArgString, formatLaunchArgs, LAUNCHER_FLAGS } from '../../src/utils/arg-canonical.js';

/**
 * Injection points for the wrapped `fs` primitives (real calls still run).
 * Every suite's beforeEach resets all four, so a callback armed by one suite
 * can never leak into a test of another.
 */
const hook = vi.hoisted(() => ({
  /** channels: return true to abort a rename (leaves the tmp file behind). */
  failRename: null as null | ((dst: string) => boolean),
  /** channels: runs AFTER a real rename - corrupts the destination. */
  afterRename: null as null | ((dst: string) => void),
  /** peers: runs BEFORE a real rename - injects a concurrent registration. */
  onRename: null as null | ((dst: string) => void),
  /** peers: runs AFTER a real identity.json read. */
  onIdentityRead: null as null | (() => void),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const renameSync = (...args: Parameters<typeof actual.renameSync>) => {
    const dst = String(args[1]);
    hook.onRename?.(dst);
    if (hook.failRename?.(dst)) throw new Error('injected rename failure');
    const result = actual.renameSync(...args);
    hook.afterRename?.(dst);
    return result;
  };
  const readFileSync = (...args: Parameters<typeof actual.readFileSync>) => {
    const result = actual.readFileSync(...args);
    // Fire AFTER the real read so a test can simulate a concurrent writer that
    // landed between this read and the caller's next write.
    if (hook.onIdentityRead && String(args[0]).endsWith('identity.json')) hook.onIdentityRead();
    return result;
  };
  return { ...actual, renameSync, readFileSync, default: { ...actual, renameSync, readFileSync } };
});

// ==========================================================================
// merged from mycc-compose-spec.test.ts
// ==========================================================================
describe('compose spec + launcher flag table' + ' (merged from mycc-compose-spec.test.ts)', () => {
  /**
   * A workdir that is absolute ON THIS HOST. validateSpec checks with Node's
   * path.isAbsolute(), which is platform-native — a hardcoded `C:/Proj/mycc`
   * is rejected on POSIX (and a `/proj/mycc` rejected on Windows). The fixture
   * must therefore be derived, not written down, or the whole suite becomes
   * green-on-one-OS-only and silently dead everywhere else.
   */
  const FIXTURE_WORKDIR = process.platform === 'win32' ? 'C:/Proj/mycc' : '/proj/mycc';

  /** A minimal VALID spec; spread + override per test. */
  function baseSpec(overrides: Record<string, unknown> = {}) {
    return {
      group: 'smoke',
      peers: [
        { name: 'leader', workdir: FIXTURE_WORKDIR, args: '--auto --skip-healthcheck' },
      ],
      channels: [],
      ...overrides,
    };
  }

  /**
   * Valid single-peer builder for peer-field tests.
   * (Named `mkPeer`, not `peer()`: a top-level helper shadowing vitest's
   * TestContext `ctx` parameter would be a foot-gun in any test that needs `ctx`.)
   */
  function mkPeer(overrides: Record<string, unknown> = {}) {
    return {
      name: 'p',
      workdir: FIXTURE_WORKDIR,
      args: '--auto',
      ...overrides,
    };
  }

  describe('validateSpec: accepts and normalizes a valid spec', () => {
    it('returns peers with resolved defaults and parsedArgs', () => {
      const out = validateSpec(baseSpec());
      expect(out.group).toBe('smoke');
      expect(out.peers).toHaveLength(1);
      const p = out.peers[0];
      expect(p.renew).toBe('onMismatch'); // default applied
      expect(p.identityName).toBe('smoke:leader'); // stable identity is group-qualified
      expect(p.parsedArgs.auto).toBe(true); // parsed through the shared table
      // `sessionId` is NOT a normalized field any more (specs never author one).
      expect('sessionId' in p).toBe(false);
    });

    it('keeps renew, and parses channels', () => {
      const out = validateSpec(
        baseSpec({
          peers: [
            mkPeer({ name: 'a', renew: 'always' }),
            mkPeer({ name: 'b' }),
          ],
          channels: [{ from: 'a', to: 'b', label: 'review', prompt: 'hi {{to}}' }],
        }),
      );
      expect(out.peers[0].renew).toBe('always');
      expect(out.channels[0]).toEqual({ from: 'a', to: 'b', label: 'review', prompt: 'hi {{to}}' });
    });

    it('does not mutate its input', () => {
      const spec = baseSpec({ peers: [mkPeer({ renew: undefined })] });
      const snapshot = JSON.stringify(spec);
      validateSpec(spec);
      expect(JSON.stringify(spec)).toBe(snapshot);
    });
  });

  describe('validateSpec: rejects malformed specs', () => {
    const rejects = (spec: unknown, re: RegExp) => {
      expect(() => validateSpec(spec)).toThrow(re);
    };

    it('group', () => {
      rejects(baseSpec({ group: '' }), /group must be a non-empty string/);
      rejects(baseSpec({ group: 42 }), /group must be a non-empty string/);
    });

    it('peers array', () => {
      rejects(baseSpec({ peers: [] }), /peers must be a non-empty array/);
      rejects(baseSpec({ peers: 'nope' }), /peers must be a non-empty array/);
    });

    it('channels array', () => {
      rejects(baseSpec({ channels: {} }), /channels must be an array/);
    });

    it('peer object shape + name + duplicate name', () => {
      rejects(baseSpec({ peers: [null] }), /peers\[0\] must be an object/);
      rejects(baseSpec({ peers: [mkPeer({ name: '' })] }), /name must be a non-empty string/);
      rejects(
        baseSpec({ peers: [mkPeer({ name: 'dup' }), mkPeer({ name: 'dup' })] }),
        /duplicate peer name: "dup"/,
      );
    });

    it('workdir must be a non-empty ABSOLUTE path', () => {
      rejects(baseSpec({ peers: [mkPeer({ workdir: '' })] }), /workdir must be a non-empty absolute path/);
      rejects(baseSpec({ peers: [mkPeer({ workdir: 'relative/dir' })] }), /workdir must be absolute/);
    });

    it('args must be a string', () => {
      rejects(baseSpec({ peers: [mkPeer({ args: ['--auto'] })] }), /args must be a string/);
    });

    it('args MUST include --auto or --daemon', () => {
      rejects(baseSpec({ peers: [mkPeer({ args: '--skip-healthcheck' })] }), /MUST include --auto or --daemon/);
      // ...but either of them is accepted. BARE `--daemon` is a supported
      // runtime shape (shouldDaemon() keys off presence; getDaemonSkill() then
      // returns undefined → passive auto daemon), so it MUST validate.
      expect(() => validateSpec(baseSpec({ peers: [mkPeer({ args: '--daemon skill-manager' })] }))).not.toThrow();
      expect(() => validateSpec(baseSpec({ peers: [mkPeer({ args: '--daemon' })] }))).not.toThrow();
      // The EMPTY-VALUE spelling `--daemon=` is the wrong one: it renders to
      // spawn as no daemon flag at all, so it is rejected explicitly.
      rejects(baseSpec({ peers: [mkPeer({ args: '--daemon=' })] }), /--daemon= \(empty value\)/);
    });

    // v5 no-tolerance rule: peer identity is `--name <group>:<peer>`, injected by
    // the launcher; session ids are minted fresh per run and resolved from
    // identity.json. A `sessionId` field (even a well-formed UUID, or null) is a
    // HARD validation error — no warn-and-strip, no backward compat.
    it('rejects peers[].sessionId outright (any value, including null and a valid UUID)', () => {
      const rejectsSid = (sessionId: unknown) =>
        expect(() => validateSpec(baseSpec({ peers: [mkPeer({ sessionId })] }))).toThrow(
          /sessionId is no longer supported/,
        );
      rejectsSid(null);
      rejectsSid('11111111-2222-4333-8444-555555555555');
      rejectsSid('not-a-uuid');
      rejectsSid(123);
      // Sanity: the same peer WITHOUT a sessionId validates fine.
      expect(() => validateSpec(baseSpec({ peers: [mkPeer({})] }))).not.toThrow();
    });

    it('renew must be "always" or "onMismatch"', () => {
      rejects(baseSpec({ peers: [mkPeer({ renew: 'sometimes' })] }), /renew must be "always" or "onMismatch"/);
    });

    it('channel endpoints must name declared peers, and differ', () => {
      const peers = [mkPeer({ name: 'a' }), mkPeer({ name: 'b' })];
      rejects(baseSpec({ peers, channels: [{ from: 'ghost', to: 'b', label: 'x', prompt: '' }] }), /\.from must name a declared peer/);
      rejects(baseSpec({ peers, channels: [{ from: 'a', to: 'ghost', label: 'x', prompt: '' }] }), /\.to must name a declared peer/);
      rejects(baseSpec({ peers, channels: [{ from: 'a', to: 'a', label: 'x', prompt: '' }] }), /from and \.to must differ/);
    });

    it('channel label + prompt', () => {
      const peers = [mkPeer({ name: 'a' }), mkPeer({ name: 'b' })];
      rejects(baseSpec({ peers, channels: [{ from: 'a', to: 'b', label: '', prompt: '' }] }), /label must be a non-empty string/);
      rejects(baseSpec({ peers, channels: [{ from: 'a', to: 'b', label: 'x', prompt: 5 }] }), /prompt must be a string/);
    });

    it('rejects duplicate channel labels', () => {
      const peers = [mkPeer({ name: 'a' }), mkPeer({ name: 'b' })];
      rejects(
        baseSpec({
          peers,
          channels: [
            { from: 'a', to: 'b', label: 'dup', prompt: '' },
            { from: 'a', to: 'b', label: 'dup', prompt: '' },
          ],
        }),
        /duplicate channel label: "dup"/,
      );
    });

    // Windows filesystems are case-insensitive: `L` and `l` would land on ONE
    // file, the second silently overwriting the first while status reported both
    // present. Same for NFC-vs-NFD spellings of an accent.
    it('rejects duplicate channel labels that differ only by case or Unicode form', () => {
      const peers = [mkPeer({ name: 'a' }), mkPeer({ name: 'b' })];
      const twoLabels = (l1: string, l2: string) =>
        baseSpec({
          peers,
          channels: [
            { from: 'a', to: 'b', label: l1, prompt: '' },
            { from: 'a', to: 'b', label: l2, prompt: '' },
          ],
        });
      rejects(twoLabels('L', 'l'), /duplicate channel label/);
      // 'é' as one code point (NFC) vs 'e' + combining acute (NFD).
      rejects(twoLabels('\u00e9', 'e\u0301'), /duplicate channel label/);
      expect(() => validateSpec(twoLabels('review', 'followup'))).not.toThrow();
    });

    // B-SEC-1: the label becomes a FILENAME component (`<sid>-<label>.json`).
    // An unsanitized label escaped the channels dir and overwrote a machine-wide
    // file (`identity.json`, a peer's `heartbeat/<sid>`).
    it('rejects a channel label that is unsafe as a filename component', () => {
      const peers = [mkPeer({ name: 'a' }), mkPeer({ name: 'b' })];
      const withLabel = (label: string) =>
        baseSpec({ peers, channels: [{ from: 'a', to: 'b', label, prompt: '' }] });
      rejects(withLabel('x/../../identity'), /Invalid channels\[0\]\.label/);
      rejects(withLabel('x/../../heartbeat/abc'), /Invalid channels\[0\]\.label/);
      rejects(withLabel('a\\b'), /Invalid channels\[0\]\.label/);
      rejects(withLabel('..'), /Invalid channels\[0\]\.label/);
      rejects(withLabel('a:b'), /Invalid channels\[0\]\.label/); // Windows-reserved
      rejects(withLabel('a*b'), /Invalid channels\[0\]\.label/);
      rejects(withLabel('a?b'), /Invalid channels\[0\]\.label/);
      rejects(withLabel('a"b'), /Invalid channels\[0\]\.label/);
      rejects(withLabel('a<b'), /Invalid channels\[0\]\.label/);
      rejects(withLabel('a>b'), /Invalid channels\[0\]\.label/);
      rejects(withLabel('a|b'), /Invalid channels\[0\]\.label/);
      rejects(withLabel('a\u0000b'), /Invalid channels\[0\]\.label/); // control char
      // A normal label still passes.
      expect(() => validateSpec(withLabel('task-1.review_2'))).not.toThrow();
    });

    it('rejects a non-object channel entry', () => {
      const peers = [mkPeer({ name: 'a' }), mkPeer({ name: 'b' })];
      rejects(baseSpec({ peers, channels: [null] }), /channels\[0\] must be an object/);
      rejects(baseSpec({ peers, channels: ['x'] }), /channels\[0\] must be an object/);
    });

    it('rejects a channel label that is only whitespace', () => {
      const peers = [mkPeer({ name: 'a' }), mkPeer({ name: 'b' })];
      rejects(
        baseSpec({ peers, channels: [{ from: 'a', to: 'b', label: '   ', prompt: '' }] }),
        /label must be a non-empty string/,
      );
    });

    it('rejects duplicate peer names that differ only by case', () => {
      rejects(
        baseSpec({ peers: [mkPeer({ name: 'Leader' }), mkPeer({ name: 'leader' })] }),
        /duplicate peer name/,
      );
    });

    // REGRESSION: names are deduped case-folded, so the membership lookup for
    // channels[].from/.to must fold the SAME way. When it did not, a peer named
    // "Leader" referenced as ".from": "Leader" validated as declared yet threw
    // "must name a declared peer" — breaking check/up/sync/down for any spec that
    // capitalized a peer name. (Found by the adversarial verification pass.)
    it('resolves a channel endpoint whose case matches the declared peer name', () => {
      const peers = [mkPeer({ name: 'Leader' }), mkPeer({ name: 'Critic' })];
      expect(() =>
        validateSpec(
          baseSpec({
            peers,
            channels: [{ from: 'Leader', to: 'Critic', label: 'L', prompt: '' }],
          }),
        ),
      ).not.toThrow();
    });

    it('rejects from/to that differ only by case (they are the same peer)', () => {
      rejects(
        baseSpec({
          peers: [mkPeer({ name: 'Leader' }), mkPeer({ name: 'Critic' })],
          channels: [{ from: 'Leader', to: 'leader', label: 'L', prompt: '' }],
        }),
        /from and \.to must differ/,
      );
    });

    // A-M4 (updated for the --name model): the launcher injects `--name
    // <group>:<peer>` itself, so an AUTHORED `--name` in a peer's args is
    // rejected by the LAUNCHER_FLAGS loop (it would double the flag and drift the
    // peer's identity from the launcher's).
    it('rejects --name (the launcher-managed flag) authored in peers[].args', () => {
      rejects(
        baseSpec({ peers: [mkPeer({ args: '--auto --name proj:alpha' })] }),
        /must not set --name/,
      );
      // Bare, value-less `--name` is rejected too — by the earlier STRING-flag
      // "without a value" rule, which runs BEFORE the launcher-flag loop, so the
      // message names the missing value rather than launcher injection.
      rejects(
        baseSpec({ peers: [mkPeer({ args: '--auto --name' })] }),
        /has --name without a value/,
      );
      expect(() => validateSpec(baseSpec({ peers: [mkPeer({ args: '--auto' })] }))).not.toThrow();
    });

    // `--session-id` is REMOVED from mycc entirely and is no longer in
    // STRING_FLAGS, so the LAUNCHER_FLAGS loop does NOT catch it (it reaches
    // parsedArgs as an auto-detected key). An explicit check rejects it with a
    // clear never-supported message — silent-unknown is unacceptable.
    it('rejects the removed --session-id authored in peers[].args', () => {
      const sid = '11111111-2222-4333-8444-555555555555';
      rejects(
        baseSpec({ peers: [mkPeer({ args: `--auto --session-id ${sid}` })] }),
        /--session-id.*no longer supported/,
      );
      // Bare form is caught too (it still reaches parsedArgs as a key).
      rejects(
        baseSpec({ peers: [mkPeer({ args: '--auto --session-id' })] }),
        /--session-id.*no longer supported/,
      );
      // `--session-id=<sid>` is likewise rejected.
      rejects(
        baseSpec({ peers: [mkPeer({ args: `--auto --session-id=${sid}` })] }),
        /--session-id.*no longer supported/,
      );
    });

    // B-M1: `--daemon` is a STRING_FLAG with no default; bare use must parse to
    // `true` (not ''), so the rendered argv round-trips as plain `--daemon`.
    // CONTRACT (owner ruling): bare `--daemon` is CORRECT and validates;
    // `--daemon=` (empty value) is WRONG and is rejected; a flag-looking value
    // (`--daemon=--auto`) is rejected too — it used to collapse to a bare daemon
    // and silently drop the skill name (M2).
    it('parses a bare string-flag as true, not empty string', () => {
      expect(parseArgString('--daemon').daemon).toBe(true);
      expect(parseArgString('--daemon skill-manager').daemon).toBe('skill-manager');
      expect(() => validateSpec(baseSpec({ peers: [mkPeer({ args: '--daemon' })] }))).not.toThrow();
      expect(() => validateSpec(baseSpec({ peers: [mkPeer({ args: '--daemon=' })] }))).toThrow(
        /--daemon= \(empty value\)/,
      );
      expect(() => validateSpec(baseSpec({ peers: [mkPeer({ args: '--daemon=--auto' })] }))).toThrow(
        /--daemon with a flag-looking value/,
      );
      // ...while ANY other bare string flag stays rejected (permanent mismatch).
      expect(() => validateSpec(baseSpec({ peers: [mkPeer({ args: '--auto --editor' })] }))).toThrow(
        /has --editor without a value/,
      );
    });
  });

  describe('validateSpec: peers[].remotes validation', () => {
    const rejects = (spec: unknown, re: RegExp) => {
      expect(() => validateSpec(spec)).toThrow(re);
    };

    it('normalizes a valid remotes list onto the returned peer', () => {
      const out = validateSpec(
        baseSpec({
          peers: [mkPeer({ remotes: ['http://192.168.1.20:3191', 'https://peer.example:443'] })],
        }),
      );
      expect(out.peers[0].remotes).toEqual(['http://192.168.1.20:3191', 'https://peer.example:443']);
    });

    it('treats absent / null / empty remotes as "no remotes" (undefined)', () => {
      expect(validateSpec(baseSpec({ peers: [mkPeer({})] })).peers[0].remotes).toBeUndefined();
      expect(validateSpec(baseSpec({ peers: [mkPeer({ remotes: null })] })).peers[0].remotes).toBeUndefined();
      expect(validateSpec(baseSpec({ peers: [mkPeer({ remotes: [] })] })).peers[0].remotes).toBeUndefined();
    });

    it('rejects a non-array remotes', () => {
      rejects(baseSpec({ peers: [mkPeer({ remotes: 'http://x:1' })] }), /remotes must be an array of URL strings/);
      rejects(baseSpec({ peers: [mkPeer({ remotes: 42 })] }), /remotes must be an array of URL strings/);
    });

    it('rejects a non-string / empty entry', () => {
      rejects(baseSpec({ peers: [mkPeer({ remotes: [123] })] }), /remotes\[0\] must be a non-empty URL string/);
      rejects(baseSpec({ peers: [mkPeer({ remotes: ['  '] })] }), /remotes\[0\] must be a non-empty URL string/);
    });

    it('rejects unsupported remote URL suffixes', () => {
      rejects(baseSpec({ peers: [mkPeer({ remotes: ['not a url'] })] }), /is not a valid URL|host:port endpoint/);
      rejects(baseSpec({ peers: [mkPeer({ remotes: ['http://host:3191/path'] })] }), /host:port endpoint/);
      rejects(baseSpec({ peers: [mkPeer({ remotes: ['http://host:3191?x=1'] })] }), /host:port endpoint/);
      rejects(baseSpec({ peers: [mkPeer({ remotes: ['http://host:3191#frag'] })] }), /host:port endpoint/);
      // REGRESSION: trailing slashes are a legal way to spell the same
      // host:port endpoint (remoteUrlKey / parseWireTarget strip them) and must
      // NOT trip the suffix guard — including the doubled form.
      expect(() =>
        validateSpec(baseSpec({ peers: [mkPeer({ remotes: ['http://h:3191/'] })] })),
      ).not.toThrow();
      expect(() =>
        validateSpec(baseSpec({ peers: [mkPeer({ remotes: ['http://h:3191//'] })] })),
      ).not.toThrow();
    });

    it('rejects a non-http(s) scheme', () => {
      rejects(baseSpec({ peers: [mkPeer({ remotes: ['ftp://host:21'] })] }), /must use http or https/);
      rejects(baseSpec({ peers: [mkPeer({ remotes: ['ws://host:3191'] })] }), /must use http or https/);
    });

    it('rejects an empty host', () => {
      rejects(baseSpec({ peers: [mkPeer({ remotes: ['http:///path'] })] }), /must have a non-empty host/);
    });

    it('rejects a URL with no port (runtime parseWireTarget requires host:port)', () => {
      // The runtime wire target is `host:port`; parseWireTarget returns null for a
      // portless target, so `http://host` would validate here and then silently
      // fail to connect. Pin the validator to the SAME grammar as the runtime.
      rejects(baseSpec({ peers: [mkPeer({ remotes: ['http://host'] })] }), /explicit numeric port/);
      rejects(baseSpec({ peers: [mkPeer({ remotes: ['host'] })] }), /explicit numeric port/);
      rejects(baseSpec({ peers: [mkPeer({ remotes: ['https://peer.example'] })] }), /explicit numeric port/);
      // A trailing slash does NOT supply a port — still rejected.
      rejects(baseSpec({ peers: [mkPeer({ remotes: ['http://host/'] })] }), /explicit numeric port/);
      // With a port it is accepted, trailing slash and all.
      expect(() => validateSpec(baseSpec({ peers: [mkPeer({ remotes: ['http://host:3191/'] })] }))).not.toThrow();
      expect(() => validateSpec(baseSpec({ peers: [mkPeer({ remotes: ['h:3191'] })] }))).not.toThrow();
    });

    it('rejects a duplicate URL within one peer (case/slash-insensitive)', () => {
      rejects(
        baseSpec({ peers: [mkPeer({ remotes: ['http://H:3191', 'http://h:3191/'] })] }),
        /duplicate URL/,
      );
    });

    it('rejects a self-dial: loopback host + port == this peer\'s --serve port', () => {
      rejects(
        baseSpec({ peers: [mkPeer({ args: '--auto --serve 3191', remotes: ['http://127.0.0.1:3191'] })] }),
        /self-dial/,
      );
      rejects(
        baseSpec({ peers: [mkPeer({ args: '--auto --serve 3191', remotes: ['http://localhost:3191'] })] }),
        /self-dial/,
      );
      rejects(
        baseSpec({ peers: [mkPeer({ args: '--auto --serve 3191', remotes: ['http://[::1]:3191'] })] }),
        /self-dial/,
      );
      // Same host, DIFFERENT port is NOT a self-dial.
      expect(() =>
        validateSpec(baseSpec({ peers: [mkPeer({ args: '--auto --serve 3191', remotes: ['http://127.0.0.1:4000'] })] })),
      ).not.toThrow();
      // Non-loopback host is NOT caught here (connectPeer's same-store filter is the backstop).
      expect(() =>
        validateSpec(baseSpec({ peers: [mkPeer({ args: '--auto --serve 3191', remotes: ['http://192.168.1.20:3191'] })] })),
      ).not.toThrow();
    });

    it('rejects a mutual dial: the same URL declared by two different peers', () => {
      const peers = [
        mkPeer({ name: 'a', args: '--auto', remotes: ['http://192.168.1.20:3191'] }),
        mkPeer({ name: 'b', args: '--auto', remotes: ['http://192.168.1.20:3191'] }),
      ];
      rejects(baseSpec({ peers }), /mutual dial rejected/);
      // The same URL with different case/slash still counts as the same endpoint.
      rejects(
        baseSpec({
          peers: [
            mkPeer({ name: 'a', args: '--auto', remotes: ['http://H:3191'] }),
            mkPeer({ name: 'b', args: '--auto', remotes: ['http://h:3191/'] }),
          ],
        }),
        /mutual dial rejected/,
      );
      // DIFFERENT URLs across peers is fine (two distinct outbound edges).
      expect(() =>
        validateSpec(
          baseSpec({
            peers: [
              mkPeer({ name: 'a', args: '--auto', remotes: ['http://one:3191'] }),
              mkPeer({ name: 'b', args: '--auto', remotes: ['http://two:3191'] }),
            ],
          }),
        ),
      ).not.toThrow();
    });

    it('folds schemes when comparing endpoint identity (host:port, not scheme://host:port)', () => {
      // The runtime wire registry keys on host:port and IGNORES the scheme, so
      // http://h:3191 and https://h:3191 (and bare h:3191) are the SAME endpoint.
      // The spec's duplicate/mutual-dial validation must use the same notion, or
      // two peers "dialing different endpoints" would collide at runtime.
      rejects(
        baseSpec({ peers: [mkPeer({ remotes: ['http://h:3191', 'https://h:3191'] })] }),
        /duplicate URL/,
      );
      rejects(
        baseSpec({ peers: [mkPeer({ remotes: ['http://h:3191', 'h:3191'] })] }),
        /duplicate URL/,
      );
      // Mutual-dial across schemes is caught: two peers, same host:port, one http
      // and one https → the same runtime endpoint.
      rejects(
        baseSpec({
          peers: [
            mkPeer({ name: 'a', args: '--auto', remotes: ['http://h:3191'] }),
            mkPeer({ name: 'b', args: '--auto', remotes: ['https://h:3191'] }),
          ],
        }),
        /mutual dial rejected/,
      );
      // DIFFERENT ports stay distinct even with opposite schemes.
      expect(() =>
        validateSpec(baseSpec({ peers: [mkPeer({ remotes: ['http://h:3191', 'https://h:3192'] })] })),
      ).not.toThrow();
    });
  });

  describe('validatePeerName: <group>:<peer> identity parsing', () => {
    it('splits a valid name on the FIRST colon', () => {
      expect(validatePeerName('proj:alpha-worker')).toEqual({ group: 'proj', peer: 'alpha-worker' });
      // Dots, underscores, hyphens, digits are all legal id characters.
      expect(validatePeerName('a.b_c-1:x9')).toEqual({ group: 'a.b_c-1', peer: 'x9' });
    });

    it('rejects a name with no colon', () => {
      expect(() => validatePeerName('projalpha')).toThrow(/must be "<group>:<peer>" \(missing ":"\)/);
    });

    it('rejects an empty group or peer part', () => {
      expect(() => validatePeerName(':alpha')).toThrow(/non-empty group AND peer/);
      expect(() => validatePeerName('proj:')).toThrow(/non-empty group AND peer/);
      expect(() => validatePeerName(':')).toThrow(/non-empty group AND peer/);
    });

    it('rejects whitespace in either part', () => {
      expect(() => validatePeerName('pro j:alpha')).toThrow(/must not contain whitespace/);
      expect(() => validatePeerName('proj:al pha')).toThrow(/must not contain whitespace/);
      expect(() => validatePeerName('proj:\talpha')).toThrow(/must not contain whitespace/);
    });

    it('rejects a part that is unsafe as an id component', () => {
      // The second colon is Windows-reserved → the peer part fails isSafeId.
      expect(() => validatePeerName('proj:al:pha')).toThrow(/Invalid/);
      // Path separators / traversal.
      expect(() => validatePeerName('proj:..')).toThrow(/Invalid/);
      expect(() => validatePeerName('proj:a/b')).toThrow(/Invalid/);
      expect(() => validatePeerName('proj:a\\b')).toThrow(/Invalid/);
      // Windows-reserved chars inside a part.
      expect(() => validatePeerName('proj:a*b')).toThrow(/Invalid/);
      expect(() => validatePeerName('proj:a?b')).toThrow(/Invalid/);
      // A control character.
      expect(() => validatePeerName('proj:a\u0000b')).toThrow(/Invalid/);
    });

    it('rejects a trailing dot or space in a part', () => {
      expect(() => validatePeerName('proj.:alpha')).toThrow(/Invalid/);
      expect(() => validatePeerName('proj:alpha.')).toThrow(/Invalid/);
    });

    it('rejects a part longer than 200 chars', () => {
      const long = 'x'.repeat(201);
      expect(() => validatePeerName(`${long}:alpha`)).toThrow(/Invalid/);
      expect(() => validatePeerName(`proj:${long}`)).toThrow(/Invalid/);
      // 200 exactly is fine.
      const ok = 'x'.repeat(200);
      expect(validatePeerName(`${ok}:alpha`)).toEqual({ group: ok, peer: 'alpha' });
    });

    it('rejects a non-string / empty name', () => {
      expect(() => validatePeerName('')).toThrow(/non-empty string/);
      // runtime guard against a non-string caller (the param is typed unknown).
      expect(() => validatePeerName(42)).toThrow(/non-empty string/);
    });
  });

  describe('launcher flag table: --name round-trip', () => {
    it('parses --name as a value-taking string and renders it back', () => {
      const parsed = parseArgString('--auto --name proj:alpha');
      expect(parsed.name).toBe('proj:alpha');
      // formatLaunchArgs renders the flag for the published args string.
      const rendered = formatLaunchArgs(parsed);
      expect(rendered).toContain('--name proj:alpha');
    });

    it('lists exactly --name as the launcher-managed flag (session-id removed)', () => {
      expect(LAUNCHER_FLAGS).toEqual(['name']);
      expect(LAUNCHER_FLAGS).not.toContain('session-id');
    });
  });

  describe('loadSpec: I/O + JSON error paths', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-compose-spec-'));

    it('throws when the file is missing', () => {
      expect(() => loadSpec(path.join(tmp, 'nope.json'))).toThrow(/spec file not found/);
    });

    it('throws on invalid JSON', () => {
      const f = path.join(tmp, 'bad.json');
      fs.writeFileSync(f, '{ not json');
      expect(() => loadSpec(f)).toThrow(/is not valid JSON/);
    });

    it('throws on a non-object top level', () => {
      const f = path.join(tmp, 'arr.json');
      fs.writeFileSync(f, '[]');
      expect(() => loadSpec(f)).toThrow(/spec must be a JSON object/);
    });

    it('returns the parsed object for a well-formed file', () => {
      const f = path.join(tmp, 'ok.json');
      fs.writeFileSync(f, JSON.stringify(baseSpec()));
      expect(loadSpec(f)).toMatchObject({ group: 'smoke' });
    });
  });

  describe('updateSpecFile: in-place, atomic, field-preserving write-back', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-compose-update-'));

    /** Write a raw spec (with fields the validator does not model) and return its path. */
    const writeRaw = (name: string, obj: unknown) => {
      const f = path.join(tmp, name);
      fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf-8');
      return f;
    };

    it('applies the mutation, preserves unknown fields, and reindents to 2 spaces', () => {
      const f = writeRaw('a.json', {
        group: 'smoke',
        futureField: { keep: ['me'] },
        peers: [{ name: 'a', mintedNote: 'before' }],
      });
      updateSpecFile(f, (raw) => {
        (raw.peers as Array<Record<string, unknown>>)[0].mintedNote = 'after';
      });
      const after = JSON.parse(fs.readFileSync(f, 'utf-8')) as { peers: Array<Record<string, unknown>>; futureField: unknown };
      expect(after.peers[0].mintedNote).toBe('after');
      expect(after.futureField).toEqual({ keep: ['me'] }); // not modelled, must survive
      // Stable 2-space indent + trailing newline.
      expect(fs.readFileSync(f, 'utf-8')).toContain('\n  "group": "smoke"');
      expect(fs.readFileSync(f, 'utf-8').endsWith('\n')).toBe(true);
    });

    it('leaves no temp file behind on success', () => {
      const f = writeRaw('b.json', baseSpec());
      updateSpecFile(f, (raw) => {
        raw.group = 'renamed';
      });
      const leftovers = fs.readdirSync(tmp).filter((n) => n.includes('.mycc-compose.'));
      expect(leftovers).toEqual([]);
    });

    it('does not truncate the spec when the mutation throws', () => {
      const f = writeRaw('c.json', baseSpec());
      const before = fs.readFileSync(f, 'utf-8');
      expect(() =>
        updateSpecFile(f, () => {
          throw new Error('boom');
        }),
      ).toThrow(/boom/);
      // The write happens AFTER mutate(), so the original must be byte-identical.
      expect(fs.readFileSync(f, 'utf-8')).toBe(before);
    });
  });
});

// ==========================================================================
// merged from mycc-compose-shim-parse.test.ts
// ==========================================================================
describe('parseCmdShim via the launchPeer seam' + ' (merged from mycc-compose-shim-parse.test.ts)', () => {
  let tempDir = '';
  let binDir = '';

  /** Fresh lifecycle + discovery module instances AFTER the env is set. */
  type Lifecycle = typeof import('../../scripts/mycc-compose/lib/peers-lifecycle.js');
  let lifecycle: Lifecycle | null = null;
  async function loadLifecycle(): Promise<Lifecycle> {
    vi.resetModules();
    lifecycle = (await import('../../scripts/mycc-compose/lib/peers-lifecycle.js')) as Lifecycle;
    return lifecycle;
  }

  /** The peer fixture: a durable name, daemonless launch args. No sessionId —
   * the peer mints its own on boot and the launcher resolves it by NAME; a
   * pre-set one is no longer required (or meaningful). */
  function peerFixture() {
    return {
      name: 'shim-peer',
      workdir: tempDir,
      args: '--auto --skip-healthcheck',
      renew: 'onMismatch' as const,
      parsedArgs: { _: [], 'auto': true, 'skip-healthcheck': true } as Record<string, unknown>,
    } as const;
  }

  /**
   * Write a REAL npm-cmd-shim-shaped launcher at <binDir>/mycc.cmd with the
   * %_prog% indirection, as `npm install -g` renders it. `bundleNode` decides
   * whether the bundled <binDir>\node.exe exists (IF-EXIST true) or not (npm's
   * ELSE semantics: bare `node`).
   */
  function writeNpmShimShape(opts: { bundleNode: boolean }): void {
    fs.mkdirSync(binDir, { recursive: true });
    const entry = path.join(binDir, 'mycc.js');
    fs.writeFileSync(entry, 'setTimeout(function(){},600000);');
    if (opts.bundleNode) {
      // A fixture file, not a real exe — existence is all the resolver checks.
      fs.writeFileSync(path.join(binDir, 'node.exe'), 'fixture');
    }
    fs.writeFileSync(
      path.join(binDir, 'mycc.cmd'),
      '@echo off\r\n' +
        'SETLOCAL ENABLEDELAYEDEXPANSION\r\n' +
        'IF EXIST "%dp0%\\node.exe" (\r\n' +
        '  SET "_prog=%dp0%\\node.exe"\r\n' +
        ') ELSE (\r\n' +
        '  SET "_prog=node"\r\n' +
        ')\r\n' +
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\mycc.js" %*\r\n',
    );
  }

  /**
   * A spawnImpl that CAPTURES (command,args) instead of really spawning. The
   * captured process exits at once, so launchPeer never sees a beat and rejects
   * at the (test-shortened) timeout; the assertion happens on the capture.
   */
  function capturingSpawn(): {
    seen: Array<{ command: string; args: string[] }>;
    impl: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  } {
    const seen: Array<{ command: string; args: string[] }> = [];
    const impl = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
      seen.push({ command, args: [...args] });
      void options;
      return spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    };
    return { seen, impl };
  }

  /** Drive launchPeer with the capturing seam; the timeout rejection is expected. */
  async function captureLaunchShape(timeoutMs: number): Promise<Array<{ command: string; args: string[] }>> {
    const { seen, impl } = capturingSpawn();
    const { launchPeer } = await loadLifecycle();
    await launchPeer(peerFixture() as unknown as Parameters<typeof launchPeer>[0], {
      spawnImpl: impl,
      timeoutMs,
    }).then(
      () => { /* not expected: the seam child never beats */ },
      () => { /* expected timeout rejection */ },
    );
    return seen;
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-shim-'));
    binDir = path.join(tempDir, 'bin');
    fs.mkdirSync(path.join(tempDir, 'discovery', 'heartbeat'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'discovery'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'discovery', 'identity.json'), '{}');
    process.env.MYCC_DISCOVERY_DIR = path.join(tempDir, 'discovery');
    process.env.MYCC_ROOT = tempDir; // resolveMyccLauncher → <tempDir>/bin/mycc.cmd
    writeLaunchBaseFixture();
  });

  /** The baseline fixture shim resolveMyccLauncher finds; per-test writers
   * overwrite it. Without a pre-seeded shim, tests that never call a writer
   * would leave launchPeer's `?? 'mycc'` fallback in place. */
  function writeLaunchBaseFixture(): void {
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      path.join(binDir, 'mycc.cmd'),
      '@echo off\r\nREM placeholder, replaced per test\r\n',
    );
  }

  afterEach(() => {
    delete process.env.MYCC_DISCOVERY_DIR;
    delete process.env.MYCC_ROOT;
    vi.restoreAllMocks();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const isWin = process.platform === 'win32';

  // Platform-gated suites. `describe.runIf` (not a `describe.skip` alias) is the
  // single gate: the skipped half shows up as SKIPPED, never as a silently
  // empty block, and a win32-only regression cannot hide behind a dead const.
  describe.runIf(isWin)('parseCmdShim: real npm _prog=%dp0% shape (P1-3, win32)', () => {
    it('bundled node.exe present → prog resolves to <shimDir>\\node.exe, no cmd /c wrap', async () => {
      writeNpmShimShape({ bundleNode: true });
      const seen = await captureLaunchShape(2_500);
      expect(seen).toHaveLength(1);
      expect(seen[0].command).toBe(path.join(binDir, 'node.exe'));
      expect(seen[0].args[0]).toBe(path.join(binDir, 'mycc.js'));
      expect(seen[0].command.toLowerCase()).not.toMatch(/cmd$/);
    });

    it('bundled node.exe absent → prog degrades to PATH `node`, no cmd /c wrap', async () => {
      writeNpmShimShape({ bundleNode: false });
      const seen = await captureLaunchShape(2_500);
      expect(seen).toHaveLength(1);
      expect(seen[0].command).toBe('node');
      expect(seen[0].args[0]).toBe(path.join(binDir, 'mycc.js'));
    });

    it('unparsable shim shape → keeps the documented cmd /c fallback', async () => {
      // A shape the parser deliberately does not recognize (no quoted .js exec).
      fs.writeFileSync(
        path.join(binDir, 'mycc.cmd'),
        '@echo off\r\nmy-cli.exe %*\r\n',
      );
      const seen = await captureLaunchShape(2_500);
      expect(seen).toHaveLength(1);
      expect(seen[0].command).toBe('cmd');
      expect(seen[0].args[0]).toBe('/c');
      expect(seen[0].args[1]).toBe(path.join(binDir, 'mycc.cmd'));
    });

    it('spawned argv is the launcher real argv: prog + target + --name <peer> + args', async () => {
      writeNpmShimShape({ bundleNode: true });
      const seen = await captureLaunchShape(2_500);
      expect(seen[0].args.slice(0, 3)).toEqual([path.join(binDir, 'mycc.js'), '--name', 'shim-peer']);
      expect(seen[0].args).toContain('--auto');
      expect(seen[0].args.join(' ')).not.toContain('%');
    });
  });

  describe.runIf(!isWin)('parseCmdShim gating (POSIX)', () => {
    it('a .cmd launcher is not parsed outside win32 — the shim path reaches the seam as-is', async () => {
      // On POSIX resolveMyccLauncher only probes the extensionless name, so the
      // .cmd path never occurs; pin the gate by asserting the extensionless
      // fixture is used (spawn of the real file, no cmd /c wrap).
      fs.mkdirSync(binDir, { recursive: true });
      const shim = path.join(binDir, 'mycc');
      const entry = path.join(binDir, 'mycc.js');
      fs.writeFileSync(entry, 'setTimeout(function(){},600000);');
      fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`);
      fs.chmodSync(shim, 0o755);
      const seen = await captureLaunchShape(2_500);
      expect(seen[0].command).toBe(shim);
      expect(seen[0].command.toLowerCase()).not.toMatch(/cmd\.exe$/);
    });
  });
});

// ==========================================================================
// merged from mycc-compose-channels.test.ts
// ==========================================================================
describe('channel-file data layer' + ' (merged from mycc-compose-channels.test.ts)', () => {
  /** Injection points for the fs.renameSync wrapper (real rename still runs). */
  const SID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
  const SID_B = 'bbbbbbbb-2222-4222-8222-222222222222';
  const SID_C = 'cccccccc-3333-4333-8333-333333333333'; // a FOREIGN peer, never in the spec

  let tempDir = '';
  let channelsDir = '';

  function channelsFile(sid: string, label: string): string {
    return path.join(channelsDir, `${sid}-${label}.json`);
  }

  /** A fresh channels.js bound to the per-test MYCC_DISCOVERY_DIR. */
  async function loadChannels() {
    vi.resetModules();
    return import('../../scripts/mycc-compose/lib/channels.js');
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-channels-'));
    channelsDir = path.join(tempDir, 'discovery', 'channels');
    process.env.MYCC_DISCOVERY_DIR = path.join(tempDir, 'discovery');
    hook.failRename = null;
    hook.afterRename = null;
  });

  afterEach(() => {
    delete process.env.MYCC_DISCOVERY_DIR;
    vi.restoreAllMocks();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  /** Two peers, one directed channel. */
  function spec(): {
    group: string;
    peers: Array<{ name: string; identityName: string; sessionId: string | null }>;
    channels: Array<{ from: string; to: string; label: string; prompt: string }>;
  } {
    return {
      group: 'grp',
      peers: [
        { name: 'a', identityName: 'grp:a', sessionId: SID_A },
        { name: 'b', identityName: 'grp:b', sessionId: SID_B },
      ],
      channels: [{ from: 'a', to: 'b', label: 'review', prompt: 'Peer is {{to}}.' }],
    };
  }

  // ---------------------------------------------------------------------------
  // fillTemplate
  // ---------------------------------------------------------------------------

  describe('fillTemplate', () => {
    it('substitutes {{from}} {{to}} {{peer}} {{label}}', async () => {
      const { fillTemplate } = await loadChannels();
      const out = fillTemplate('{{from}} -> {{to}} (peer {{peer}}, label {{label}})', {
        from: 'a',
        to: 'b',
        peer: 'b',
        label: 'review',
      });
      expect(out).toBe('a -> b (peer b, label review)');
    });

    it('tolerates whitespace inside the braces', async () => {
      const { fillTemplate } = await loadChannels();
      expect(fillTemplate('x{{ to }}y', { to: 'b' })).toBe('xby');
    });

    it('leaves an unknown placeholder verbatim', async () => {
      const { fillTemplate } = await loadChannels();
      expect(fillTemplate('keep {{nope}}', { to: 'b' })).toBe('keep {{nope}}');
    });
  });

  // ---------------------------------------------------------------------------
  // withReplyContract
  // ---------------------------------------------------------------------------

  describe('withReplyContract', () => {
    it('appends the reciprocal contract when the prompt has no mail_to(', async () => {
      const { withReplyContract } = await loadChannels();
      const out = withReplyContract('Do the thing.', SID_B, 'review');
      expect(out.startsWith('Do the thing.')).toBe(true);
      expect(out).toContain(`mail_to(name="${SID_B}/lead"`);
      expect(out).toContain('title="review:<subject>"');
      expect(out).toContain('Do NOT reply with prose');
    });

    it('does not append when the author already wrote a mail_to instruction', async () => {
      const { withReplyContract } = await loadChannels();
      const prompt = `Reply via mail_to(name="{{to}}/lead").`;
      expect(withReplyContract(prompt, SID_B, 'review')).toBe(prompt);
    });
  });

  // ---------------------------------------------------------------------------
  // buildChannelFile — D-3: preserve the peer-owned lifecycle state
  // ---------------------------------------------------------------------------

  describe('buildChannelFile', () => {
    it('builds a fresh file with false booleans when nothing exists', async () => {
      const { buildChannelFile } = await loadChannels();
      const before = Date.now();
      const built = buildChannelFile({
        channelId: 'review',
        ownerSid: SID_A,
        peerSid: SID_B,
        title: 'grp-review',
        prompt: 'hi',
      });
      expect(built).toMatchObject({
        channelId: 'review',
        ownerSessionId: SID_A,
        peerSessionId: SID_B,
        title: 'grp-review',
        firstQuery: 'hi',
        joined: false,
        firstQuerySent: false,
      });
      expect(built.createdAt).toBeGreaterThanOrEqual(before);
      expect(built.createdAt).toBeLessThanOrEqual(Date.now());
    });

    it('omits ownerName/peerName when the caller supplies none (legacy shape)', async () => {
      const { buildChannelFile } = await loadChannels();
      const built = buildChannelFile({
        channelId: 'review',
        ownerSid: SID_A,
        peerSid: SID_B,
        title: 'grp-review',
        prompt: 'hi',
      });
      expect('ownerName' in built).toBe(false);
      expect('peerName' in built).toBe(false);
    });

    it('writes ownerName/peerName when supplied (R1 data-only ownership)', async () => {
      const { buildChannelFile } = await loadChannels();
      const built = buildChannelFile({
        channelId: 'review',
        ownerSid: SID_A,
        peerSid: SID_B,
        ownerName: 'grp:a',
        peerName: 'grp:b',
        title: 'grp-review',
        prompt: 'hi',
      });
      expect(built.ownerName).toBe('grp:a');
      expect(built.peerName).toBe('grp:b');
    });

    it('preserves joined/firstQuerySent/createdAt from an existing file (D-3)', async () => {
      const { buildChannelFile } = await loadChannels();
      const existing = { joined: true, firstQuerySent: true, createdAt: 12345 };
      const built = buildChannelFile({
        channelId: 'review',
        ownerSid: SID_A,
        peerSid: SID_B,
        title: 'grp-review',
        prompt: 'hi again',
        existing,
      });
      expect(built.joined).toBe(true);
      expect(built.firstQuerySent).toBe(true);
      expect(built.createdAt).toBe(12345);
      expect(built.firstQuery).toBe('hi again'); // prompt always refreshed
    });

    it('treats a non-true existing value as not-yet-joined', async () => {
      const { buildChannelFile } = await loadChannels();
      const built = buildChannelFile({
        channelId: 'review',
        ownerSid: SID_A,
        peerSid: SID_B,
        title: 't',
        prompt: 'p',
        existing: { joined: 'yes', firstQuerySent: 1, createdAt: 0 },
      });
      expect(built.joined).toBe(false);
      expect(built.firstQuerySent).toBe(false);
      expect(built.createdAt).toBe(0); // 0 is a valid preserved timestamp
    });
  });

  // ---------------------------------------------------------------------------
  // readChannelFile — D-6
  // ---------------------------------------------------------------------------

  describe('readChannelFile', () => {
    it('returns null for a missing file', async () => {
      const { readChannelFile } = await loadChannels();
      expect(readChannelFile(channelsFile(SID_A, 'nope'))).toBeNull();
    });

    it('returns null for malformed JSON', async () => {
      const { readChannelFile } = await loadChannels();
      fs.mkdirSync(channelsDir, { recursive: true });
      const f = channelsFile(SID_A, 'bad');
      fs.writeFileSync(f, '{ not json');
      expect(readChannelFile(f)).toBeNull();
    });

    it('returns null for a JSON scalar or null (non-object)', async () => {
      const { readChannelFile } = await loadChannels();
      fs.mkdirSync(channelsDir, { recursive: true });
      const scalar = channelsFile(SID_A, 'scalar');
      fs.writeFileSync(scalar, '"just a string"');
      expect(readChannelFile(scalar)).toBeNull();
      const nul = channelsFile(SID_A, 'null');
      fs.writeFileSync(nul, 'null');
      expect(readChannelFile(nul)).toBeNull();
    });

    it('returns the parsed object for a well-formed channel file', async () => {
      const { readChannelFile } = await loadChannels();
      fs.mkdirSync(channelsDir, { recursive: true });
      const f = channelsFile(SID_A, 'ok');
      fs.writeFileSync(f, JSON.stringify({ channelId: 'ok', joined: true }));
      expect(readChannelFile(f)).toMatchObject({ channelId: 'ok', joined: true });
    });
  });

  // ---------------------------------------------------------------------------
  // writeChannelFileAtomic
  // ---------------------------------------------------------------------------

  describe('writeChannelFileAtomic', () => {
    it('creates the channels dir, writes atomically and leaves no tmp file', async () => {
      const { writeChannelFileAtomic } = await loadChannels();
      const f = channelsFile(SID_A, 'review');
      fs.mkdirSync(path.dirname(channelsDir), { recursive: true }); // discovery/ exists, channels/ does NOT
      const data = { channelId: 'review', ownerSessionId: SID_A, peerSessionId: SID_B };
      writeChannelFileAtomic(f, data);
      expect(fs.existsSync(f)).toBe(true);
      expect(JSON.parse(fs.readFileSync(f, 'utf-8'))).toEqual(data);
      const leftovers = fs.readdirSync(channelsDir).filter((n) => n.endsWith('.tmp'));
      expect(leftovers).toEqual([]);
    });

    it('throws when the read-back peerSessionId does not match', async () => {
      const { writeChannelFileAtomic } = await loadChannels();
      const f = channelsFile(SID_A, 'review');
      hook.afterRename = (dst) => {
        if (dst !== f) return;
        const cur = JSON.parse(fs.readFileSync(f, 'utf-8'));
        cur.peerSessionId = 'tampered'; // simulate a clobbering rename collision
        fs.writeFileSync(f, JSON.stringify(cur));
      };
      expect(() =>
        writeChannelFileAtomic(f, { channelId: 'review', ownerSessionId: SID_A, peerSessionId: SID_B }),
      ).toThrow(/read-back mismatch/);
    });

    it('removes the tmp file when the rename fails', async () => {
      const { writeChannelFileAtomic } = await loadChannels();
      const f = channelsFile(SID_A, 'review');
      hook.failRename = (dst) => dst === f;
      const tmp = `${f}.mycc-compose.${process.pid}.tmp`;
      expect(() =>
        writeChannelFileAtomic(f, { channelId: 'review', ownerSessionId: SID_A, peerSessionId: SID_B }),
      ).toThrow(/injected rename failure/);
      expect(fs.existsSync(tmp)).toBe(false);
      expect(fs.existsSync(f)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // materializeChannels
  // ---------------------------------------------------------------------------

  describe('materializeChannels', () => {
    it('writes BOTH files of a pair with cross-filled peerSessionId', async () => {
      const { materializeChannels } = await loadChannels();
      const results = materializeChannels(spec());
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ label: 'review', ok: true, title: 'grp-review' });

      const a = JSON.parse(fs.readFileSync(channelsFile(SID_A, 'review'), 'utf-8'));
      const b = JSON.parse(fs.readFileSync(channelsFile(SID_B, 'review'), 'utf-8'));
      // ASYMMETRY: each side points at the OTHER.
      expect(a).toMatchObject({
        channelId: 'review',
        ownerSessionId: SID_A,
        peerSessionId: SID_B,
        title: 'grp-review',
        joined: false,
        firstQuerySent: false,
      });
      expect(b).toMatchObject({ ownerSessionId: SID_B, peerSessionId: SID_A });
      // R1: the durable NAME field lands on disk as a DATA-ONLY ownership pair
      // (ownerName = this side, peerName = the OTHER side) so Slice-4 cleanup can
      // attribute a file to a topology peer by name despite sid churn. The value
      // is the peer's `name` verbatim (here the fixture's bare 'a'/'b'; in
      // production it is `<group>:<peer>`).
      expect(a).toMatchObject({ ownerName: 'grp:a', peerName: 'grp:b' });
      expect(b).toMatchObject({ ownerName: 'grp:b', peerName: 'grp:a' });
    });

    it('fills the template per side (from/to swapped) and appends the contract', async () => {
      const { materializeChannels } = await loadChannels();
      materializeChannels(spec());
      const a = JSON.parse(fs.readFileSync(channelsFile(SID_A, 'review'), 'utf-8'));
      const b = JSON.parse(fs.readFileSync(channelsFile(SID_B, 'review'), 'utf-8'));
      expect(a.firstQuery).toContain('Peer is b.');
      expect(b.firstQuery).toContain('Peer is a.');
      // each side is told to reply to the OTHER sid
      expect(a.firstQuery).toContain(`${SID_B}/lead`);
      expect(b.firstQuery).toContain(`${SID_A}/lead`);
    });

    it('does not append the contract when the prompt already carries mail_to(', async () => {
      const { materializeChannels } = await loadChannels();
      const s = spec();
      s.channels[0].prompt = 'Reply via mail_to(name="{{to}}/lead").';
      materializeChannels(s);
      const a = JSON.parse(fs.readFileSync(channelsFile(SID_A, 'review'), 'utf-8'));
      expect(a.firstQuery).not.toContain('[Reply contract]');
      expect(a.firstQuery).toContain('mail_to(name="b/lead"');
    });

    it('preserves joined across a re-materialize (D-3 cron-sync case)', async () => {
      const { materializeChannels } = await loadChannels();
      materializeChannels(spec());
      const f = channelsFile(SID_A, 'review');
      const joined = JSON.parse(fs.readFileSync(f, 'utf-8'));
      joined.joined = true;
      joined.firstQuerySent = true;
      joined.createdAt = 999;
      fs.writeFileSync(f, JSON.stringify(joined, null, 2));

      materializeChannels(spec()); // a cron `sync` tick

      const after = JSON.parse(fs.readFileSync(f, 'utf-8'));
      expect(after.joined).toBe(true);
      expect(after.firstQuerySent).toBe(true);
      expect(after.createdAt).toBe(999);
    });

    it('reports endpoint-missing and writes nothing', async () => {
      const { materializeChannels } = await loadChannels();
      const s = spec();
      s.channels[0].to = 'ghost';
      const results = materializeChannels(s);
      expect(results).toEqual([{ label: 'review', ok: false, reason: 'endpoint-missing' }]);
      expect(fs.existsSync(channelsFile(SID_A, 'review'))).toBe(false);
      expect(fs.existsSync(channelsFile(SID_B, 'review'))).toBe(false);
    });

    it('reports endpoint-has-no-session for an unminted peer', async () => {
      const { materializeChannels } = await loadChannels();
      const s = spec();
      s.peers[1].sessionId = null;
      const results = materializeChannels(s);
      expect(results).toEqual([{ label: 'review', ok: false, reason: 'endpoint-has-no-session' }]);
      expect(fs.existsSync(channelsFile(SID_A, 'review'))).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // channelFileNames — the single source of truth for "the files this spec owns"
  // ---------------------------------------------------------------------------

  describe('channelFileNames', () => {
    it('returns both filenames per channel', async () => {
      const { channelFileNames } = await loadChannels();
      expect(channelFileNames(spec()).sort()).toEqual(
        [`${SID_A}-review.json`, `${SID_B}-review.json`].sort(),
      );
    });

    it('skips a peer with no session id (nothing was materialized for it)', async () => {
      const { channelFileNames } = await loadChannels();
      const s = spec();
      s.peers[1].sessionId = null;
      expect(channelFileNames(s)).toEqual([`${SID_A}-review.json`]);
    });

    it('returns an empty list for a peer-only group', async () => {
      const { channelFileNames } = await loadChannels();
      const s = spec();
      s.channels = [];
      expect(channelFileNames(s)).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // removeChannels — B-SEC-2: a FILENAME LIST, never a sid × label cross-product
  // ---------------------------------------------------------------------------

  describe('removeChannels (filename list, B-SEC-2)', () => {
    /** Materialize the spec, then plant a FOREIGN peer's file with the SAME label. */
    async function plantOwnedAndForeign() {
      const channels = await loadChannels();
      channels.materializeChannels(spec());
      const foreign = channelsFile(SID_C, 'review'); // peer C is NOT in the spec
      fs.writeFileSync(foreign, JSON.stringify({ channelId: 'review', ownerSessionId: SID_C }));
      return { channels, foreign };
    }

    it('deletes the OWNED files (positive control) and spares a foreign peer file', async () => {
      const { channels, foreign } = await plantOwnedAndForeign();
      const owned = channels.channelFileNames(spec());

      const removed = channels.removeChannels(owned);

      // Positive control FIRST: if deletion silently no-ops, this fails here.
      expect(removed.removed).toBe(2);
      expect(removed.failed).toEqual([]);
      expect(fs.existsSync(channelsFile(SID_A, 'review'))).toBe(false);
      expect(fs.existsSync(channelsFile(SID_B, 'review'))).toBe(false);
      // Regression (B-SEC-2): the foreign peer's same-label file must survive.
      expect(fs.existsSync(foreign)).toBe(true);
    });

    it('does not delete a foreign file when only the owned names are passed', async () => {
      const { channels, foreign } = await plantOwnedAndForeign();
      // Exactly what the CLI now does: removeChannels(channelFileNames(spec)).
      channels.removeChannels(channels.channelFileNames(spec()));
      const survivors = fs.readdirSync(channelsDir);
      expect(survivors).toEqual([`${SID_C}-review.json`]);
      expect(JSON.parse(fs.readFileSync(foreign, 'utf-8')).ownerSessionId).toBe(SID_C);
    });

    it('counts only files that existed', async () => {
      const { channels } = await plantOwnedAndForeign();
      channels.removeChannels([`${SID_A}-review.json`]); // delete one
      expect(channels.removeChannels(channels.channelFileNames(spec())).removed).toBe(1); // only B remains
    });

    it('returns { removed: 0, failed: [] } when the channels dir does not exist', async () => {
      const channels = await loadChannels();
      expect(channels.removeChannels([`${SID_A}-review.json`])).toEqual({ removed: 0, failed: [] });
    });

    it('reports an unlink FAILURE in `failed` instead of throwing (partial teardown evidence)', async () => {
      const { channels } = await plantOwnedAndForeign();
      // Plant a DIRECTORY where the owned file should be: rmSync without
      // `recursive` throws, which must land in `failed` and never escape.
      fs.rmSync(channelsFile(SID_A, 'review'));
      fs.mkdirSync(channelsFile(SID_A, 'review'), { recursive: true });
      const res = channels.removeChannels(channels.channelFileNames(spec()));
      expect(res.removed).toBe(1); // SID_B's file is really gone
      expect(res.failed).toEqual([`${SID_A}-review.json`]);
    });
  });

  // ---------------------------------------------------------------------------
  // channelStatus
  // ---------------------------------------------------------------------------

  describe('channelStatus', () => {
    it('reports bothFilesPresent=true once materialized', async () => {
      const { materializeChannels, channelStatus } = await loadChannels();
      materializeChannels(spec());
      expect(channelStatus(spec())).toEqual([
        { label: 'review', bothFilesPresent: true, attribution: 'present' },
      ]);
    });

    it('reports false when one side is missing', async () => {
      const { materializeChannels, channelStatus } = await loadChannels();
      materializeChannels(spec());
      fs.rmSync(channelsFile(SID_B, 'review'));
      expect(channelStatus(spec())).toEqual([
        { label: 'review', bothFilesPresent: false, attribution: 'absent' },
      ]);
    });

    it('reports false for an unminted peer (no file can exist yet)', async () => {
      const { channelStatus } = await loadChannels();
      const s = spec();
      s.peers[1].sessionId = null;
      expect(channelStatus(s)).toEqual([
        { label: 'review', bothFilesPresent: false, attribution: 'absent' },
      ]);
    });

    it('attributes by FILENAME (present) even for a pre-v3 file with no ownership names', async () => {
      const { channelStatus } = await loadChannels();
      fs.mkdirSync(channelsDir, { recursive: true });
      // Pre-v3 files carry no ownerName/peerName. Ownership is the FILENAME
      // `<sid>-<label>.json`, so content is irrelevant: both present → 'present'.
      fs.writeFileSync(channelsFile(SID_A, 'review'), JSON.stringify({
        channelId: 'review', ownerSessionId: SID_A, peerSessionId: SID_B,
      }));
      fs.writeFileSync(channelsFile(SID_B, 'review'), JSON.stringify({
        channelId: 'review', ownerSessionId: SID_B, peerSessionId: SID_A,
      }));
      expect(channelStatus(spec())).toEqual([
        { label: 'review', bothFilesPresent: true, attribution: 'present' },
      ]);
    });

    it('does NOT count a sibling file that merely matches by content name', async () => {
      const { channelStatus } = await loadChannels();
      fs.mkdirSync(channelsDir, { recursive: true });
      // A file whose CONTENT claims our names but whose filename carries a
      // foreign sid must not make the channel look present (AC-1/AC-5).
      fs.writeFileSync(channelsFile(SID_C, 'review'), JSON.stringify({
        channelId: 'review', ownerSessionId: SID_C, peerSessionId: SID_C,
        ownerName: 'grp:a', peerName: 'grp:b',
      }));
      expect(channelStatus(spec())).toEqual([
        { label: 'review', bothFilesPresent: false, attribution: 'absent' },
      ]);
    });
  });
});

// ==========================================================================
// merged from mycc-compose-peers.test.ts
// ==========================================================================
describe('peer identity + liveness' + ' (merged from mycc-compose-peers.test.ts)', () => {
  const SID_A = 'aaaaaaaa-1111-4111-8111-111111111111';
  const SID_B = 'bbbbbbbb-2222-4222-8222-222222222222';
  const SID_C = 'cccccccc-3333-4333-8333-333333333333';

  let tempDir = '';
  let hbDir = '';
  let identityFile = '';

  /** Fresh module instances bound to the per-test MYCC_DISCOVERY_DIR. */
  async function loadModules() {
    vi.resetModules();
    const discovery = await import('../../scripts/mycc-compose/lib/discovery.js');
    const peers = await import('../../scripts/mycc-compose/lib/peers.js');
    return { discovery, peers };
  }

  /** Start a long-lived `node -e` process (stands in for a live mycc instance). */
  function startLiveProcess(): { pid: number; kill: () => void } {
    const child = spawn(process.execPath, ['-e', 'setTimeout(function(){}, 600000)'], { stdio: 'ignore' });
    return { pid: child.pid as number, kill: () => child.kill() };
  }

  /** Start a long-lived process whose OWN argv carries the peer NAME, exactly
   * what a real peer launch looks like: spawnDetached resolves the launcher shim
   * to `node <entry.js>` BEFORE spawning, so a genuine peer process's command
   * line is `node …mycc.js --name <name> --auto …`. The script name still
   * contains "mycc" so the test proves the NAME ALONE (not the /mycc/i substring
   * the old rule relied on) establishes identity. */
  function startMyccShapedProcess(name: string): { pid: number; kill: () => void } {
    const script = path.join(tempDir, 'mycc-owner.js');
    fs.writeFileSync(script, 'setTimeout(function(){},600000);');
    const child = spawn(process.execPath, [script, '--name', name], { stdio: 'ignore' });
    return { pid: child.pid as number, kill: () => child.kill() };
  }

  /** Start a long-lived process whose command line looks like a mycc SCRIPT but
   * carries NO --name: the shape the /mycc/i substring rule used to wrongly
   * accept (and kill). */
  function startMyccLookalikeWithoutName(): { pid: number; kill: () => void } {
    const script = path.join(tempDir, 'mycc-lookalike.js');
    fs.writeFileSync(script, 'setTimeout(function(){},600000);');
    const child = spawn(process.execPath, [script], { stdio: 'ignore' });
    return { pid: child.pid as number, kill: () => child.kill() };
  }

  /** A pid that is provably dead (spawn a process that exits at once). */
  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const pid = child.pid as number;
    await new Promise((r) => child.on('exit', r));
    return pid;
  }

  /** True when `pid` is still alive (EPERM also counts as alive). */
  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException)?.code === 'EPERM';
    }
  }

  function writeIdentity(sid: string, extra: Record<string, unknown> = {}) {
    const map: Record<string, unknown> = {};
    if (fs.existsSync(identityFile)) Object.assign(map, JSON.parse(fs.readFileSync(identityFile, 'utf-8')));
    map[sid] = { sessionId: sid, workDir: tempDir, mailbox: 'mb', startedAt: Date.now(), ...extra };
    fs.writeFileSync(identityFile, JSON.stringify(map, null, 2));
  }

  function writeHeartbeat(sid: string, pid: number | undefined, when = Date.now()) {
    const data: Record<string, unknown> = { heartbeats: [when], briefs: [] };
    if (pid !== undefined) data.pid = pid;
    fs.writeFileSync(path.join(hbDir, `${sid}.json`), JSON.stringify(data));
  }

  function peer(name: string, sessionId: string, args = '--auto') {
    return { name, sessionId, workdir: tempDir, args, parsedArgs: { _: [], auto: true } };
  }

  /** A `spawn`-shaped impl that maps launchPeer's resolved launcher command onto
   * the fixture shim written by {@link setBin}, so the injected seam runs the
   * deterministic fixture instead of a real mycc. `launchPeer` resolves the
   * ABSOLUTE launcher (`<tempDir>/bin/mycc.cmd` on Windows via MYCC_ROOT,
   * `.../mycc` on POSIX) and — on Windows — CONVERTS a parsable `.cmd` shim to
   * its real argv (`node <entry.js> …`, parseCmdShim in peers-lifecycle.ts)
   * before calling the seam: a detached `cmd /c` wrap still pops a visible
   * Windows-Terminal console window. The seam therefore receives `node.exe`
   * on Windows and runs the fixture directly (hidden); the `command === shim`
   * checks remain for POSIX and for any future direct-shim call shape. */
  function fixtureSpawn(
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ReturnType<typeof spawn> {
    const shim = path.join(tempDir, 'bin', process.platform === 'win32' ? 'mycc.cmd' : 'mycc');
    if (command === shim || command === 'mycc') {
      if (process.platform === 'win32') {
        return spawn('cmd', ['/c', shim, ...args], options);
      }
      return spawn(shim, args as string[], options);
    }
    return spawn(command, args as string[], options);
  }

  /** Poll until `pred()` or the deadline; returns pred()'s last value. */
  async function waitFor(pred: () => boolean, timeoutMs = 3000, stepMs = 50): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, stepMs));
    }
    return pred();
  }

  /** Write a FIXTURE mycc shim under `<tempDir>/bin` and point MYCC_ROOT at it.
   *
   * `launchPeer` resolves an ABSOLUTE launcher via {@link resolveMyccLauncher},
   * whose first candidate is `$MYCC_ROOT/bin/mycc{.cmd,}`. Writing the fixture
   * there and setting MYCC_ROOT to the temp dir makes the fixture the absolute
   * launcher path the peer terminal would invoke — a deterministic script instead
   * of a real Lead. On Windows the shim is a `mycc.cmd` (the same form the npm
   * global install uses); on POSIX an executable `mycc` shell script.
   *
   * NOTE: `openTerminal` remains one-shot and creates no window under a
   * non-interactive console, so a test that must observe the beat POLL injects
   * the `spawnImpl` seam (see {@link fixtureSpawn}) instead. `setBin` is otherwise
   * only exercised by the tests that expect a TIMEOUT (no beat is ever produced). */
  function setBin(source: string): void {
    const binDir = path.join(tempDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const scriptFile = path.join(binDir, 'mycc-fixture.js');
    fs.writeFileSync(scriptFile, source);
    if (process.platform === 'win32') {
      fs.writeFileSync(
        path.join(binDir, 'mycc.cmd'),
        `@echo off\r\n"${process.execPath}" "${scriptFile}" %*\r\n`,
      );
    } else {
      const shim = path.join(binDir, 'mycc');
      fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${scriptFile}" "$@"\n`);
      fs.chmodSync(shim, 0o755);
    }
    process.env.MYCC_ROOT = tempDir;
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mycc-peers-'));
    hbDir = path.join(tempDir, 'discovery', 'heartbeat');
    identityFile = path.join(tempDir, 'discovery', 'identity.json');
    fs.mkdirSync(hbDir, { recursive: true });
    fs.writeFileSync(identityFile, '{}');
    process.env.MYCC_DISCOVERY_DIR = path.join(tempDir, 'discovery');
    delete process.env.MYCC_ROOT;
    hook.onRename = null;
  });

  afterEach(() => {
    delete process.env.MYCC_DISCOVERY_DIR;
    delete process.env.MYCC_ROOT;
    vi.restoreAllMocks();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  // ---------------------------------------------------------------------------
  // B-LAUNCH-2: stopPeer must not kill a recycled pid
  // ---------------------------------------------------------------------------

  describe('stopPeer: positive identity, never a recycled pid (B-LAUNCH-2)', () => {
    it('rejects a recycled PID during name resolution, not just during stop', async () => {
      const { discovery } = await loadModules();
      const owner = startMyccShapedProcess('grp:owner');
      writeIdentity(SID_A, { name: 'grp:owner', pid: owner.pid });
      writeHeartbeat(SID_A, owner.pid);
      // Simulate a stale heartbeat file whose recorded PID now belongs to a
      // process that started later. The embedded heartbeat remains fresh, so a
      // timestamp-only check would falsely accept this entry as live.
      const old = (Date.now() - 60_000) / 1000;
      fs.utimesSync(path.join(hbDir, `${SID_A}.json`), old, old);
      try {
        expect(discovery.isPeerRunning({ sessionId: SID_A, workdir: tempDir })).toBe(false);
        expect(discovery.resolveLivePeer({
          name: 'owner',
          identityName: 'grp:owner',
          workdir: tempDir,
        })).toBeNull();
        expect(discovery.isSessionHolderDead(SID_A)).toBe(true);
        expect(isAlive(owner.pid)).toBe(true);
      } finally {
        owner.kill();
      }
    });

    it('fails fast rather than ranking duplicate name/workdir entries', async () => {
      const { discovery } = await loadModules();
      writeIdentity(SID_A, { name: 'grp:duplicate', pid: process.pid });
      writeIdentity(SID_B, { name: 'grp:duplicate', pid: process.pid });

      expect(() => discovery.resolvePeerForStop({
        name: 'duplicate',
        identityName: 'grp:duplicate',
        workdir: tempDir,
      })).toThrow(/refusing to guess/);
    });

    it('refuses an unrelated live Node process (command line is not mycc)', async () => {
      const { peers } = await loadModules();
      const victim = startLiveProcess(); // `node -e setTimeout…`, never --name
      const beatAt = Date.now();
      writeHeartbeat(SID_A, victim.pid, beatAt);
      writeIdentity(SID_A);
      // Backdate the heartbeat file so the victim provably STARTED after the beat
      // that names it → it cannot be the process that wrote that beat (recycled).
      const old = (beatAt - 60_000) / 1000;
      fs.utimesSync(path.join(hbDir, `${SID_A}.json`), old, old);
      try {
        expect(peers.stopPeer(peer('victim', SID_A))).toBe('refused-recycled-pid');
        expect(isAlive(victim.pid)).toBe(true); // the innocent process survived
      } finally {
        victim.kill();
      }
    });

    it('refuses an unrelated Node process even without the recycle signal', async () => {
      const { peers } = await loadModules();
      const victim = startLiveProcess();
      writeHeartbeat(SID_A, victim.pid); // normal (fresh) heartbeat file
      writeIdentity(SID_A);
      try {
        // No recycle provable, but the command line is a plain `node -e` — not
        // mycc. The old check accepted it because it matched /node\.exe|mycc/i.
        expect(peers.stopPeer(peer('victim', SID_A))).toBe('refused-not-mycc');
        expect(isAlive(victim.pid)).toBe(true);
      } finally {
        victim.kill();
      }
    });

    it('refuses when the heartbeat file records no pid (cannot name an owner)', async () => {
      const { peers } = await loadModules();
      writeHeartbeat(SID_A, undefined);
      writeIdentity(SID_A);
      expect(peers.stopPeer(peer('legacy', SID_A))).toBe('refused-no-recorded-pid');
    });

    it('stops a named peer whose heartbeat timestamp is stale but whose process is still alive', async () => {
      const { peers, discovery } = await loadModules();
      const owner = startMyccShapedProcess('grp:owner');
      writeIdentity(SID_A, { name: 'grp:owner', pid: owner.pid });
      writeHeartbeat(SID_A, owner.pid, Date.now() - 120_000);
      try {
        expect(discovery.isSessionHolderDead(SID_A)).toBe(false);
        expect(peers.stopPeer({
          name: 'owner',
          identityName: 'grp:owner',
          sessionId: null,
          workdir: tempDir,
        })).toBe('stopped');
        expect(await waitFor(() => !isAlive(owner.pid), 3000)).toBe(true);
      } finally {
        owner.kill();
      }
    });

    it('does nothing for a session whose recorded pid is dead', async () => {
      const { peers } = await loadModules();
      writeHeartbeat(SID_A, await deadPid());
      writeIdentity(SID_A);
      expect(peers.stopPeer(peer('dead', SID_A))).toBe('already-stopped');
    });

    it('terminates a genuinely live owner (started before its own heartbeat file)', async () => {
      const { peers } = await loadModules();
      const owner = startMyccShapedProcess('grp:owner'); // argv carries --name grp:owner
      writeIdentity(SID_A);
      writeHeartbeat(SID_A, owner.pid); // file written after the process started
      expect(peers.stopPeer(peer('grp:owner', SID_A))).toBe('stopped');
      expect(await waitFor(() => !isAlive(owner.pid), 3000)).toBe(true);
    });

    it('refuses a mycc-named script WITHOUT the peer name in its argv', async () => {
      // THE P1-4 regression: the old /mycc/i substring OR-match treated any
      // cmdline merely containing "mycc" as a mycc instance. An unrelated
      // script whose PATH mentions mycc got SIGTERMed for a session it never
      // held. Identity is the exact `--name <name>` argv claim instead —
      // without it, stopPeer must REFUSE, not kill.
      const { peers } = await loadModules();
      const lookalike = startMyccLookalikeWithoutName();
      writeIdentity(SID_A);
      writeHeartbeat(SID_A, lookalike.pid); // fresh file, live pid, no recycle signal
      try {
        expect(peers.stopPeer(peer('grp:intruder', SID_A))).toBe('refused-not-mycc');
        expect(isAlive(lookalike.pid)).toBe(true); // the innocent process survived
      } finally {
        lookalike.kill();
      }
    });

    it('refuses a live process carrying a DIFFERENT peer name', async () => {
      // Exact identity cuts both ways: a mycc-shaped argv naming ANOTHER peer
      // must NOT authorize a kill for this peer. The old substring rule would
      // have matched it.
      const { peers } = await loadModules();
      const otherHolder = startMyccShapedProcess('grp:other');
      writeIdentity(SID_A);
      writeHeartbeat(SID_A, otherHolder.pid);
      try {
        expect(peers.stopPeer(peer('grp:wrong', SID_A))).toBe('refused-not-mycc');
        expect(isAlive(otherHolder.pid)).toBe(true);
      } finally {
        otherHolder.kill();
      }
    });

    it('refuses (never kills) when the command line cannot be read', async () => {
      // readProcessCommandLine → null (e.g. a just-exited pid): the only safe
      // answer is refusal. The old code ALSO returned false here, this pins it —
      // a fix that relaxed the null path to "assume our own" would silently
      // reintroduce recycled-pid kills.
      const { peers } = await loadModules();
      expect(peers.isMyccProcess(await deadPid(), 'grp:x')).toBe(false);
    });

    it('refuses when the pinned sid cannot be established at all', async () => {
      // No recorded pid either → the earlier 'refused-no-recorded-pid' branch
      // fires first; use a LIVE plain-node pid and a peer with NO sessionId so
      // the identity check itself must return false (unestablishable), not the
      // /mycc/i fallback.
      const { peers } = await loadModules();
      const victim = startLiveProcess();
      writeHeartbeat(SID_A, victim.pid);
      writeIdentity(SID_A);
      try {
        // a peer record without a session id cannot claim ANY process
        expect(peers.stopPeer(peer('sidless', ''))).toBe('no-session');
        expect(isAlive(victim.pid)).toBe(true);
      } finally {
        victim.kill();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // A-M1: launchPeer must not resolve from a stale heartbeat
  // ---------------------------------------------------------------------------

  describe('launchPeer: requires a NEW beat from the spawned child (A-M1)', () => {
    it('does NOT report success from a stale heartbeat while the child never beats', async () => {
      const { peers } = await loadModules();
      const pidFile = path.join(tempDir, 'child.pid');
      // Alive for ~1.5s, never writes a heartbeat → the pre-fix poll resolved
      // 'started' from the STALE fresh heartbeat below within ~500ms.
      setBin(
        `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
        'setTimeout(function(){}, 1500);',
      );
      writeHeartbeat(SID_A, await deadPid()); // fresh file, dead pid → not a live holder
      writeIdentity(SID_A);

      const pending = peers.launchPeer(peer('silent', SID_A), { spawnImpl: fixtureSpawn });
      // No beat ever arrives, so launchPeer must NOT resolve on the stale beat —
      // it stays pending until the launch timeout (kept pending, never awaited).
      let resolved = false;
      void pending.then(() => { resolved = true; }, () => { /* timeout rejection */ });
      expect(await waitFor(() => resolved, 1500)).toBe(false);
    });

    // Restored: the original version waited out the full LAUNCH_TIMEOUT_MS (30s)
    // and was skipped as too slow. `launchPeer` exposes a test-only
    // `opts.timeoutMs` that overrides the beat-poll deadline, so the SAME
    // timeout-path coverage runs in ~500ms. This matters because it pins the
    // distinction between a terminal opener exiting NORMALLY (never the peer's
    // death) and a peer that genuinely fails to beat — the failure must surface
    // as a launch TIMEOUT, not a spawn/exit error.
    it('treats a fast opener exit as normal and reports a timeout when no beat follows', async () => {
      const { peers } = await loadModules();
      // The terminal opener is ONE-SHOT: it creates the window and exits at once.
      // Its exit is therefore never the peer's death, so launchPeer must not
      // reject with an exit code — it polls for a beat and times out instead.
      setBin('process.exit(7);');
      writeIdentity(SID_A); // no heartbeat at all → no holder, spawn proceeds

      const err = await peers
        .launchPeer(peer('crash', SID_A), { spawnImpl: fixtureSpawn, timeoutMs: 700 })
        .then(() => null, (e: Error) => e);
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/did not come up within/);
    }, 5000);

    it('resolves once the child actually beats', async () => {
      const { peers } = await loadModules();
      // Writes a NEW beat + its own NAME-keyed identity entry a moment after
      // spawn, mimicking a real mycc instance registering + beating. A launched
      // peer mints its OWN sid on boot and registers by its durable `--name`, so
      // the launcher can only resolve it by NAME (resolveLivePeer) — the fixture
      // must therefore publish a name-matched, workdir-matched, live-pid entry
      // (as register() does) alongside its heartbeat. It registers under a FRESH
      // sid (SID_B ≠ the seeded SID_A) because `launchPeer` requires the resolved
      // sid to DIFFER from the pre-launch one: that proves the child we spawned
      // registered anew rather than us observing the stale twin. The write is
      // ASYNC (setTimeout 0) so a poll tick before the write cannot resolve.
      setBin(
        "const fs=require('fs'),p=require('path');" +
        "const d=process.env.MYCC_DISCOVERY_DIR;" +
        'setTimeout(function(){' +
        `fs.writeFileSync(p.join(d,'heartbeat','${SID_B}.json'),JSON.stringify({heartbeats:[Date.now()],briefs:[],pid:process.pid}));` +
        "const idFile=p.join(d,'identity.json');" +
        "const map=JSON.parse(fs.readFileSync(idFile,'utf-8'));" +
        `map['${SID_B}']={sessionId:'${SID_B}',workDir:${JSON.stringify(tempDir)},mailbox:'mb',startedAt:Date.now(),name:'boots'};` +
        'fs.writeFileSync(idFile,JSON.stringify(map,null,2));' +
        '},0);' +
        'setTimeout(function(){},600000);',
      );
      // The pre-launch phantom: the peer was 'known' under SID_A (the dead-twin
      // sid) with no live instance behind it, so the child's fresh SID_B is what
      // the differ-gate resolves to.
      writeIdentity(SID_A);

      // Budget: one node boot (~100-300ms) + a poll tick (LAUNCH_POLL_MS=500).
      // vitest's global testTimeout is 10s, which is ample; assert against a
      // SHORTER deadline so a hang fails urgently instead of burning 10s.
      //
      // The fixture is spawned DIRECTLY (spawnImpl seam), bypassing the terminal
      // opener: under a non-interactive console `cmd /c start` creates no window
      // and runs nothing, so the beat would never arrive. The seam isolates the
      // environment-dependent opener from the poll logic under test, and routes
      // the resolved absolute launcher path to the fixture shim (see fixtureSpawn).
      expect(await peers.launchPeer(peer('boots', SID_A), { spawnImpl: fixtureSpawn })).toBe('started');
    }, 5000);
  });

  // ---------------------------------------------------------------------------
  // A-M2 / D-5: repairIdentity must not clobber a concurrent register()
  // ---------------------------------------------------------------------------

  describe('repairIdentity: merge-retry preserves concurrent registrations (A-M2/D-5)', () => {
    it('does not repair a fresh-looking heartbeat whose PID was recycled', async () => {
      const { peers } = await loadModules();
      const unrelated = startLiveProcess();
      try {
        // No identity entry exists. The heartbeat payload still claims to be
        // fresh, but the filesystem timestamp predates this unrelated process,
        // proving it cannot be the process that wrote the heartbeat.
        writeHeartbeat(SID_B, unrelated.pid);
        const old = (Date.now() - 60_000) / 1000;
        fs.utimesSync(path.join(hbDir, `${SID_B}.json`), old, old);

        expect(peers.repairIdentity([peer('recycled', SID_B)])).toBe(0);
        expect(JSON.parse(fs.readFileSync(identityFile, 'utf-8'))[SID_B]).toBeUndefined();
      } finally {
        unrelated.kill();
      }
    });

    it('reconciles a registration that lands between its read and its write', async () => {
      const { peers } = await loadModules();
      const selfPid = process.pid;
      writeHeartbeat(SID_B, selfPid); // B needs repair (fresh beat + live pid, no entry)

      // Inject a concurrent register() into the read→write window: it lands
      // right AFTER repairIdentity's first identity.json read. The old single
      // read-merge-write then renamed its stale map over it and SID_A vanished.
      let injected = false;
      hook.onIdentityRead = () => {
        if (injected) return;
        injected = true;
        const cur = JSON.parse(fs.readFileSync(identityFile, 'utf-8'));
        cur[SID_A] = { sessionId: SID_A, workDir: tempDir, mailbox: 'mb', startedAt: Date.now() };
        fs.writeFileSync(identityFile, JSON.stringify(cur, null, 2));
      };

      const repaired = peers.repairIdentity([peer('B', SID_B)]);
      hook.onIdentityRead = null;
      hook.onRename = null;
      expect(injected).toBe(true);

      const map = JSON.parse(fs.readFileSync(identityFile, 'utf-8'));
      expect(repaired).toBe(1);
      expect(map[SID_B]).toBeDefined();
      expect(map[SID_A]).toBeDefined(); // the concurrent register survived
    });

    it('does NOT resurrect an entry for a cleanly-stopped peer (dead pid)', async () => {
      const { peers } = await loadModules();
      writeHeartbeat(SID_C, await deadPid()); // fresh file, process already gone
      fs.writeFileSync(identityFile, '{}'); // as after stop() → unregister()

      expect(peers.repairIdentity([peer('stopped', SID_C)])).toBe(0);
      expect(JSON.parse(fs.readFileSync(identityFile, 'utf-8'))[SID_C]).toBeUndefined();
    });

    it('is a NO-OP for a peer whose sid ALREADY has a live identity entry (BUG #2)', async () => {
      // Regression: repairIdentity used to enqueue every fresh+live peer and
      // then unconditionally overwrite its entry — so every `up` re-run on
      // already-registered peers clobbered startedAt/args/mailbox and printed
      // "reconstituted N" (non-idempotent). A present entry must never be touched.
      const { peers } = await loadModules();
      const owner = startLiveProcess();
      const originalStartedAt = 1790760216535;
      const originalArgs = '--auto --skip-healthcheck --debug-wire';
      const originalMailbox = 'C:/Proj/mycc/.mycc/sessions/original/unread-lead.jsonl';
      try {
        writeHeartbeat(SID_B, owner.pid); // fresh beat + LIVE pid → qualifies
        // Pre-existing entry with distinctive values repairIdentity must NOT touch.
        writeIdentity(SID_B, { startedAt: originalStartedAt, args: originalArgs, mailbox: originalMailbox });

        const repaired = peers.repairIdentity([peer('B', SID_B)]);
        expect(repaired).toBe(0); // nothing reconstituted — entry already present

        const entry = JSON.parse(fs.readFileSync(identityFile, 'utf-8'))[SID_B];
        expect(entry.startedAt).toBe(originalStartedAt); // NOT overwritten
        expect(entry.args).toBe(originalArgs);           // NOT overwritten
        expect(entry.mailbox).toBe(originalMailbox);     // NOT overwritten
      } finally {
        owner.kill();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // A-M4 / m3: argv for the spawned child
  // ---------------------------------------------------------------------------

  describe('peerArgv: spawn argv carries real secrets, no launcher flag (A-M4/m3)', () => {
    it('never passes the redaction placeholder as a real value', async () => {
      const { peers } = await loadModules();
      const rendered = peers.peerArgv({
        parsedArgs: { _: [], auto: true, 'ollama-api-key': 'sk-real', 'wire-token': 'tok-123' },
      });
      expect(rendered).not.toContain('***');
      expect(rendered).toContain('sk-real');
      expect(rendered).toContain('tok-123');
    });

    it('strips a spec-authored --name (the launcher supplies it)', async () => {
      const { peers } = await loadModules();
      const rendered = peers.peerArgv({ parsedArgs: { _: [], auto: true, name: 'grp:peer' } });
      expect(rendered).not.toContain('--name');
      expect(rendered).toEqual(['--auto']);
    });
  });
});
