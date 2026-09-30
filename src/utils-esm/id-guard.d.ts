/** Type declarations for the plain-JS ./id-guard.js (see arg-canonical.d.ts). */

/** True when `id` is safe to interpolate as one path component. */
export function isSafeId(id: unknown): boolean;

/**
 * Validate `id` as a single safe path component, throwing a descriptive Error
 * otherwise. `label` names the field for the message.
 */
export function sanitizeId(id: unknown, label: string): string;
