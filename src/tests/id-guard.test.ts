/**
 * id-guard.test.ts - Unit tests for the shared path-component guard.
 *
 * `src/utils/id-guard.ts` is loaded by BOTH consumers: `src/config.ts`
 * (guards getHeartbeatFile / getChannelFile) and the `mycc-compose` bin
 * (a thin .js shim that registers the tsx loader then imports the .ts lib
 * modules; guards the channel labels it materializes).
 *
 * These tests pin the boundary: what the guard MUST reject (traversal,
 * control characters, Windows-reserved characters, Windows-unsafe trailing
 * dot/space, Windows device names) and what it must keep accepting (ordinary
 * ids and labels).
 *
 * A note on the trailing-dot / device-name rules: they are DEFENSIVE. Testing
 * showed the classic Windows hazard does not reproduce through Node on every
 * platform/configuration, so these are not "exploit fixes" — they remove a
 * name that Windows may normalize differently, which costs nothing to reject.
 * See docs/mycc-compose-fix-round.md §5.
 */

import { describe, it, expect } from 'vitest';
import { isSafeId, sanitizeId } from '../utils/id-guard.js';

describe('isSafeId / sanitizeId: rejects traversal', () => {
  const traversal = [
    'x/../../identity',
    'x/../../heartbeat/abc',
    'a/b',
    'a\\b',
    '..',
    '...',
    'a..b',
  ];

  for (const id of traversal) {
    it(`rejects ${JSON.stringify(id)}`, () => {
      expect(isSafeId(id)).toBe(false);
      expect(() => sanitizeId(id, 'label')).toThrow(/Invalid label/);
    });
  }
});

describe('isSafeId / sanitizeId: rejects non-strings and empty', () => {
  for (const id of ['', null, undefined, 42, {}, [], true]) {
    it(`rejects ${JSON.stringify(id)}`, () => {
      expect(isSafeId(id)).toBe(false);
      expect(() => sanitizeId(id, 'label')).toThrow(/must be a non-empty string/);
    });
  }
});

describe('isSafeId / sanitizeId: rejects control characters', () => {
  for (const id of ['a\u0000b', 'a\nb', 'a\tb', 'a\rb']) {
    it(`rejects ${JSON.stringify(id)}`, () => {
      expect(isSafeId(id)).toBe(false);
      expect(() => sanitizeId(id, 'label')).toThrow(/control characters/);
    });
  }
});

describe('isSafeId / sanitizeId: rejects Windows-reserved filename characters', () => {
  // Not path separators, so a traversal-only check lets them through and `fs`
  // fails later with a confusing error instead of a clear validation message.
  for (const c of [':', '*', '?', '"', '<', '>', '|']) {
    it(`rejects a label containing ${JSON.stringify(c)}`, () => {
      const id = `a${c}b`;
      expect(isSafeId(id)).toBe(false);
      expect(() => sanitizeId(id, 'label')).toThrow(/illegal in a filename/);
    });
  }
});

describe('isSafeId / sanitizeId: rejects Windows-unsafe trailing dot/space', () => {
  // Windows strips a trailing dot or space at open time, so the name a caller
  // sees is not the name that lands on disk — a portability fragility.
  // NOTE: `task..` is rejected by the EARLIER `..` (traversal) rule, so it is
  // asserted there, not here; a single trailing dot reaches this rule.
  for (const id of ['task.', 'task ']) {
    it(`rejects ${JSON.stringify(id)} with the trailing-char rule`, () => {
      expect(isSafeId(id)).toBe(false);
      expect(() => sanitizeId(id, 'label')).toThrow(/must not end with a dot or a space/);
    });
  }

  it('rejects trailing-dot/dotdot variants (whichever rule catches them first)', () => {
    for (const id of ['task..', 'task  ']) {
      expect(isSafeId(id), id).toBe(false);
      expect(() => sanitizeId(id, 'label'), id).toThrow(/Invalid label/);
    }
  });
});

describe('isSafeId / sanitizeId: rejects Windows device names', () => {
  // `NUL`, `nul.txt`, `CON.foo` all resolve to devices on Windows, regardless
  // of extension or directory.
  const devices = [
    'NUL', 'nul', 'NUL.json', 'nul.txt',
    'CON', 'PRN', 'AUX',
    'COM1', 'COM9', 'LPT1', 'LPT9',
  ];

  for (const id of devices) {
    it(`rejects ${JSON.stringify(id)}`, () => {
      expect(isSafeId(id)).toBe(false);
      expect(() => sanitizeId(id, 'label')).toThrow(/reserved Windows device name/);
    });
  }

  it('does NOT reject a name that merely starts like a device', () => {
    // 'CONSOLE' and 'NULLIFY' are ordinary names — only the exact basename is
    // a device, so the check must not over-reject.
    for (const id of ['CONSOLE', 'NULLIFY', 'COM10', 'LPT10']) {
      expect(isSafeId(id), id).toBe(true);
    }
  });
});

describe('isSafeId / sanitizeId: rejects an over-long id', () => {
  // A 300-char label would pass a naive check and then fail LATE inside
  // materialize() with ENOENT — after the peers had already been launched.
  it('rejects an id longer than the filename-component cap', () => {
    const id = 'x'.repeat(300);
    expect(isSafeId(id)).toBe(false);
    expect(() => sanitizeId(id, 'label')).toThrow(/too long/);
  });

  it('accepts an id at the cap and rejects just past it', () => {
    expect(isSafeId('x'.repeat(200))).toBe(true);
    expect(isSafeId('x'.repeat(201))).toBe(false);
  });
});

describe('isSafeId / sanitizeId: accepts ordinary ids and labels', () => {
  const ok = [
    'task-1',
    'task-1.review_2',
    '11111111-2222-4333-8444-555555555555',
    'review',
    'my.group',
    'a_b-c.d',
  ];

  for (const id of ok) {
    it(`accepts ${JSON.stringify(id)}`, () => {
      expect(isSafeId(id)).toBe(true);
      expect(sanitizeId(id, 'label')).toBe(id); // returned unchanged
    });
  }
});
