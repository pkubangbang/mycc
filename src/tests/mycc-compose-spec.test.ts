/**
 * mycc-compose-spec.test.ts - Unit tests for the mycc-compose spec validator.
 *
 * scripts/mycc-compose/lib/spec.ts is a TypeScript module imported via tsx
 * (the `./spec.js` specifier resolves to `spec.ts`). validateSpec() is the
 * contract `mycc-compose check` enforces; these tests pin every rejection rule
 * so a future edit cannot silently loosen it (e.g. drop the --auto/--daemon
 * guard, which would let cleanupEmptySessions() GC a re-pinned session dir).
 *
 * Tested surface:
 *   - validateSpec(): normalizes defaults + parsedArgs; throws on each fault.
 *   - loadSpec(): I/O + JSON error paths (missing file, bad JSON, non-object).
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateSpec, loadSpec, updateSpecFile } from '../../scripts/mycc-compose/lib/spec.js';
import { parseArgString } from '../../src/utils/arg-canonical.js';

/** A minimal VALID spec; spread + override per test. */
function baseSpec(overrides: Record<string, unknown> = {}) {
  return {
    group: 'smoke',
    peers: [
      { name: 'leader', workdir: 'C:/Proj/mycc', args: '--auto --skip-healthcheck', sessionId: null },
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
    workdir: 'C:/Proj/mycc',
    args: '--auto',
    sessionId: null,
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
    expect(p.sessionId).toBeNull();
    expect(p.parsedArgs.auto).toBe(true); // parsed through the shared table
  });

  it('keeps an explicit sessionId and renew, and parses channels', () => {
    const sid = '11111111-2222-4333-8444-555555555555';
    const out = validateSpec(
      baseSpec({
        peers: [
          mkPeer({ name: 'a', sessionId: sid, renew: 'always' }),
          mkPeer({ name: 'b' }),
        ],
        channels: [{ from: 'a', to: 'b', label: 'review', prompt: 'hi {{to}}' }],
      }),
    );
    expect(out.peers[0].sessionId).toBe(sid);
    expect(out.peers[0].renew).toBe('always');
    expect(out.channels[0]).toEqual({ from: 'a', to: 'b', label: 'review', prompt: 'hi {{to}}' });
  });

  it('does not mutate its input', () => {
    const spec = baseSpec({ peers: [mkPeer({ renew: undefined, sessionId: undefined })] });
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
    // ...but either of them is accepted.
    expect(() => validateSpec(baseSpec({ peers: [mkPeer({ args: '--daemon skill-manager' })] }))).not.toThrow();
    rejects(baseSpec({ peers: [mkPeer({ args: '--daemon' })] }), /must use --daemon <skill>/);
  });

  it('sessionId must be null or a UUID', () => {
    rejects(baseSpec({ peers: [mkPeer({ sessionId: 'not-a-uuid' })] }), /sessionId must be null or a UUID/);
    rejects(baseSpec({ peers: [mkPeer({ sessionId: 123 })] }), /sessionId must be null or a UUID/);
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

  // A-M4: the launcher injects `--session-id <sid>` itself. An authored one
  // produces a DOUBLED flag -> minimist collects an array -> getPinnedSessionId()
  // returns null -> the peer mints a random id while the launcher polls the
  // spec's sid -> 30s timeout plus an orphan process.
  it('rejects LAUNCHER_FLAGS authored in peers[].args', () => {
    const sid = '11111111-2222-4333-8444-555555555555';
    rejects(
      baseSpec({ peers: [mkPeer({ args: `--auto --session-id ${sid}` })] }),
      /must not set --session-id/,
    );
    // Bare, value-less form is caught too (it still reaches parsedArgs as a key).
    rejects(
      baseSpec({ peers: [mkPeer({ args: '--auto --session-id' })] }),
      /must not set --session-id/,
    );
    expect(() => validateSpec(baseSpec({ peers: [mkPeer({ args: '--auto' })] }))).not.toThrow();
  });

  // B-M1: `--daemon` is a STRING_FLAG with no default; bare use must parse to
  // `true` (not ''), so the rendered argv round-trips as plain `--daemon`.
  // The SPEC layer still rejects bare `--daemon` (schema mandates
  // `--daemon <skill>`); that is asserted in the "args MUST include" test
  // above. What we pin HERE is the parser contract the spec relies on: the
  // bare flag reaches parsedArgs as `true` (which is exactly why the spec's
  // `parsedArgs.daemon === true` guard can fire).
  it('parses a bare string-flag as true, not empty string', () => {
    expect(parseArgString('--daemon').daemon).toBe(true);
    expect(parseArgString('--daemon skill-manager').daemon).toBe('skill-manager');
    // Migrated from the old "bare --daemon is accepted" contract: the spec now
    // REJECTS it (schema requires a skill), while the raw parser still yields
    // `true` — pin both halves so a future loosening of either is a failure.
    expect(() => validateSpec(baseSpec({ peers: [mkPeer({ args: '--daemon' })] }))).toThrow(
      /must use --daemon <skill>/,
    );
    // `--daemon=` parses to '' and renders to spawn as NO daemon flag — a
    // functionally bare daemon that must be rejected the same way.
    expect(() => validateSpec(baseSpec({ peers: [mkPeer({ args: '--daemon=' })] }))).toThrow(
      /must use --daemon <skill>/,
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
      peers: [{ name: 'a', sessionId: null }],
    });
    updateSpecFile(f, (raw) => {
      (raw.peers as Array<Record<string, unknown>>)[0].sessionId = '11111111-2222-4333-8444-555555555555';
    });
    const after = JSON.parse(fs.readFileSync(f, 'utf-8')) as { peers: Array<Record<string, unknown>>; futureField: unknown };
    expect(after.peers[0].sessionId).toBe('11111111-2222-4333-8444-555555555555');
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
