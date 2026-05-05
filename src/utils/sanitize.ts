/**
 * sanitize.ts - String sanitization utilities
 */

/**
 * Convert a title to a safe identifier for use in node IDs
 * - Converts spaces and slashes to dashes
 * - Removes special characters but preserves Unicode letters (CJK, etc.), numbers, and dots
 * - Collapses multiple dashes
 * - Removes leading/trailing dashes
 *
 * @param title - The title to sanitize
 * @returns Safe identifier string (lowercase, dash-separated, dots preserved)
 */
export function safeNodeId(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s/]+/g, '-')           // Convert spaces and slashes to dashes
    .replace(/[^\p{L}\p{N}_.-]/gu, '') // Remove special chars but keep letters/numbers/dashes/underscores/dots
    .replace(/-+/g, '-')                // Collapse multiple dashes
    .replace(/^-|-$/g, '');             // Remove leading/trailing dashes
}