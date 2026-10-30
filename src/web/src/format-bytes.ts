/**
 * format-bytes.ts - human-readable byte size ("1.2 MB")
 *
 * Extracted from ChatInput.vue when the attachment queue became its own
 * module: the size guard (queue) and the manager's file list both need it.
 */

/** Format a byte count as a human-readable size string (e.g. "1.2 MB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
