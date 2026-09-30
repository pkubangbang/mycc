/**
 * id-guard.js - the single implementation of the "is this id safe to
 * interpolate into a discovery path?" guard.
 *
 * Written as plain ESM `.js` (with a sibling `.d.ts`) for the same reason as
 * `arg-canonical.js`: it is loaded by BOTH sides of the compose feature.
 *
 *   1. `src/config.ts`        - loaded by tsx/TypeScript (type-checked against
 *                               the sibling `.d.ts`), where it guards
 *                               getHeartbeatFile() / getChannelFile().
 *   2. `scripts/mycc-compose/` - the zero-dependency `bin` CLI run by plain
 *                               `node`, which CANNOT load .ts. It guards the
 *                               channel labels it materializes.
 *
 * Why this matters (the defect that motivated the extraction): the compose CLI
 * built channel filenames with `path.join(CHANNELS_DIR, `${sid}-${label}.json`)`
 * and a `label` validated only as "non-empty string". A label such as
 * `x/../../identity` therefore escaped the channels directory and overwrote the
 * machine-wide `identity.json`; `x/../../heartbeat/<sid>` clobbered a peer's
 * heartbeat. The guard already existed here in `config.ts` but never reached the
 * compose path, because it was a private function of a `.ts` module the plain
 * `node` CLI cannot import. Extracting it is the fix: one implementation, both
 * consumers.
 */

/**
 * Characters that are illegal in a Windows filename component. They are not
 * path separators, so the traversal check below would let them through, but
 * `fs` rejects them at open time — which surfaces as a confusing late crash
 * instead of a clear validation error.
 */
const WINDOWS_RESERVED = [':', '*', '?', '"', '<', '>', '|'];

/**
 * Windows device names. `NUL.json`, `COM1`, `CON` … are NOT ordinary files on
 * Windows: the OS resolves them to devices regardless of extension or path, so
 * a write "into the channels directory" can vanish into a device instead.
 *
 * NOTE ON SCOPE: this check is DEFENSIVE. It was added after testing showed the
 * hazard does not reproduce through Node on the machine this was developed on
 * (`NUL.json` wrote and listed normally). It is kept because rejection is free
 * and the behaviour is platform- and configuration-dependent — do not read this
 * as an exploit fix. See docs/mycc-compose-fix-round.md §5.
 */
const WINDOWS_DEVICE_NAMES = [
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
];

/**
 * Longest id accepted as a filename component. Most filesystems cap a single
 * component at 255 bytes; the guard's caller appends `.json` and prefixes a
 * `<sid>-`, so being generous here still leaves headroom while turning a
 * would-be late `ENOENT` (after peers have already been launched) into an
 * upfront validation error.
 */
const MAX_ID_LENGTH = 200;

/** True when the trailing character is one Windows strips at open time. */
function hasWindowsUnsafeTrailing(id) {
  const last = id[id.length - 1];
  return last === '.' || last === ' ';
}

/**
 * True when the basename (before the FIRST dot) is a Windows device name.
 * `NUL`, `nul.txt`, and `CON.foo` are all devices on Windows.
 */
function isWindowsDeviceName(id) {
  const base = id.split('.')[0];
  return WINDOWS_DEVICE_NAMES.includes(base.toUpperCase());
}

/**
 * True when `id` is safe to interpolate as ONE path component under a
 * discovery directory: non-empty, no path separators, no parent-directory
 * sequence, no control characters, no Windows-reserved filename chars, no
 * Windows-unsafe trailing dot/space, not a Windows device name, and short
 * enough to be a filename component.
 *
 * @param {unknown} id
 * @returns {boolean}
 */
export function isSafeId(id) {
  if (typeof id !== 'string' || id === '') return false;
  if (id.includes('/') || id.includes('\\') || id.includes('..')) return false;
  // Control characters (avoid a regex char class for eslint's no-control-regex).
  if ([...id].some((c) => c.codePointAt(0) < 0x20)) return false;
  if (WINDOWS_RESERVED.some((c) => id.includes(c))) return false;
  if (hasWindowsUnsafeTrailing(id)) return false;
  if (isWindowsDeviceName(id)) return false;
  if (id.length > MAX_ID_LENGTH) return false;
  return true;
}

/**
 * Validate `id` as a single safe path component, throwing a descriptive Error
 * otherwise. `label` names the field for the error message (e.g. 'sessionId',
 * 'channel label'); callers fail loudly rather than silently writing outside
 * the sandbox.
 *
 * @param {unknown} id
 * @param {string} label
 * @returns {string} the id, unchanged, when safe
 */
export function sanitizeId(id, label) {
  if (typeof id !== 'string' || id === '') {
    throw new Error(`Invalid ${label}: must be a non-empty string`);
  }
  if (id.includes('/') || id.includes('\\') || id.includes('..')) {
    throw new Error(
      `Invalid ${label}: contains path separators or "..": ${JSON.stringify(id)}`,
    );
  }
  if ([...id].some((c) => c.codePointAt(0) < 0x20)) {
    throw new Error(
      `Invalid ${label}: contains control characters: ${JSON.stringify(id)}`,
    );
  }
  const reserved = WINDOWS_RESERVED.filter((c) => id.includes(c));
  if (reserved.length > 0) {
    throw new Error(
      `Invalid ${label}: contains characters illegal in a filename ` +
      `(${reserved.join(' ')}): ${JSON.stringify(id)}`,
    );
  }
  if (hasWindowsUnsafeTrailing(id)) {
    throw new Error(
      `Invalid ${label}: must not end with a dot or a space (Windows strips it, ` +
      `so the name is not stable across platforms): ${JSON.stringify(id)}`,
    );
  }
  if (isWindowsDeviceName(id)) {
    throw new Error(
      `Invalid ${label}: is a reserved Windows device name: ${JSON.stringify(id)}`,
    );
  }
  if (id.length > MAX_ID_LENGTH) {
    throw new Error(
      `Invalid ${label}: too long (${id.length} > ${MAX_ID_LENGTH} chars); it would ` +
      `fail late with ENOENT as a filename component: ${JSON.stringify(id.slice(0, 40))}…`,
    );
  }
  return id;
}
