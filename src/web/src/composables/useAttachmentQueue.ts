/**
 * useAttachmentQueue.ts - the ONE place that turns browser Files into the
 * `state.pendingFiles` upload queue.
 *
 * Owns: per-file size guard (against the server-configured MB cap), the
 * folder-rejection test, base64 encoding, clipboard-paste extraction, and the
 * two error messages (超限 / 文件夹拒绝). The shell owns the drag-and-drop
 * BINDINGS (the whole composer is the drop target, so they cannot live in a
 * child) and the hidden <input type=file> element — both call `addFiles()`.
 *
 * Design notes
 *  • `getMaxMb` / `getPending` / `setPending` are getters/setters rather than
 *    a `state: ChatState` blob: the composable never sees the 30-field store,
 *    so it can be unit-tested with three tiny stubs.
 *  • `files` is the composable's local mirror of pendingFiles. It is written
 *    on every mutation AND re-synced from `getPending()` whenever the queue
 *    is read after an external replacement (see `syncFromPending`), so a
 *    /history replay that clears pendingFiles cannot leave stale chips.
 */

import { ref, watch } from 'vue';
import type { FileInfo } from '../types';
import { formatBytes } from '../format-bytes';

export interface AttachmentQueueOptions {
  /** Live per-file cap in MB (from `state.maxUploadMb`, default 50). */
  getMaxMb: () => number;
  /** Current authoritative queue (`state.pendingFiles`). */
  getPending: () => FileInfo[];
  /** Write the queue back (`state.pendingFiles = next`). */
  setPending: (next: FileInfo[]) => void;
}

/** Auto-clear delay for a transient upload error banner. */
const ERROR_TTL_MS = 4000;

/**
 * True when a dropped/picked FileList entry is a directory rather than a
 * file. Browsers expose a dropped folder as a File with `type === ''` and
 * `size === 0`, which yields nothing useful when read. `webkitGetAsEntry`
 * (when available) gives a definitive answer — a dropped directory is a
 * FileSystemDirectoryEntry. The size/type fallback can also match a genuine
 * 0-byte file, but that only happens when webkitGetAsEntry is unavailable
 * (rare in modern browsers) and a 0-byte upload is useless anyway.
 */
export function isDirectoryEntry(rawFiles: FileList, index: number): boolean {
  const file = rawFiles[index];
  type FileWithEntry = File & { webkitGetAsEntry?: () => unknown };
  const item = (rawFiles as FileList & { item?(i: number): FileWithEntry }).item?.(index) as
    | FileWithEntry
    | undefined;
  const entry = item?.webkitGetAsEntry?.();
  if (entry && typeof entry === 'object' && (entry as { isDirectory?: boolean }).isDirectory) {
    return true;
  }
  return file.type === '' && file.size === 0;
}

/**
 * Extract FILE items from a clipboard event, synthesising a filename for
 * image blobs (screenshots carry no original name: the browser hands over a
 * placeholder like `image.png` or a bare UUID). Returns the named Files, or
 * an empty array when the clipboard held only text.
 */
export function filesFromClipboard(event: ClipboardEvent): File[] {
  const items = event.clipboardData?.items;
  if (!items) return [];
  const out: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    // kind:'file' covers copied image blobs (image/png …) and files copied in
    // the OS file manager (which expose their real name). kind:'string' is
    // plain text — the textarea handles it natively.
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file) continue;
    let name = file.name;
    if (!name || name.startsWith('image.') || /^[0-9a-f]{8}-/i.test(name)) {
      const sub = file.type.split('/')[1] || 'bin';
      name = `image-${Date.now()}.${sub}`;
    }
    // Wrap so the synthesised name is the one carried into the queue (the
    // original File may hold a browser-generated placeholder name).
    out.push(new File([file], name, { type: file.type }));
  }
  return out;
}

export function useAttachmentQueue(opts: AttachmentQueueOptions) {
  /** Local mirror of the pending queue (reactive, what the UI renders). */
  const files = ref<FileInfo[]>([...opts.getPending()]);
  /** Transient error banner text ('' = hidden). */
  const uploadError = ref('');
  let errorTimer: ReturnType<typeof setTimeout> | null = null;

  function flashError(message: string): void {
    uploadError.value = message;
    if (errorTimer) clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      uploadError.value = '';
      errorTimer = null;
    }, ERROR_TTL_MS);
  }

  /** Publish the local mirror to the store. */
  function commit(next: FileInfo[]): void {
    files.value = next;
    opts.setPending(next);
  }

  /** Adopt an external queue replacement (e.g. /history clearing pendingFiles). */
  function syncFromPending(): void {
    const pending = opts.getPending();
    if (pending !== files.value) files.value = pending;
  }

  /**
   * Process a single File: size guard → FileReader → base64 → queue.
   * Shared by drag/drop, the file picker, and clipboard paste.
   */
  function processFile(file: File): void {
    const maxMb = opts.getMaxMb();
    const maxBytes = maxMb * 1024 * 1024;
    // Size guard (client-side; the server re-checks for defence in depth).
    if (file.size > maxBytes) {
      flashError(`「${file.name}」(${formatBytes(file.size)})超过 ${maxMb}MB 上传限制，已跳过`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1] || '';
      const info: FileInfo = {
        filename: file.name,
        data: base64,
        mimeType: file.type || 'application/octet-stream',
      };
      commit([...files.value, info]);
    };
    reader.readAsDataURL(file);
  }

  /**
   * Route a FileList (from a picker change event or a drop) into the queue,
   * rejecting directories with one short banner.
   */
  function addFiles(rawFiles: FileList): void {
    let rejectedFolder = false;
    for (let i = 0; i < rawFiles.length; i++) {
      if (isDirectoryEntry(rawFiles, i)) {
        rejectedFolder = true;
        continue;
      }
      processFile(rawFiles[i]);
    }
    if (rejectedFolder) flashError('不支持文件夹上传，请添加文件');
  }

  /** Route clipboard FILE items into the queue. Returns true when consumed. */
  function onPaste(event: ClipboardEvent): boolean {
    const pasted = filesFromClipboard(event);
    for (const file of pasted) processFile(file);
    return pasted.length > 0;
  }

  /** Drop one pending file by index. */
  function removeFile(index: number): void {
    const next = [...files.value];
    next.splice(index, 1);
    commit(next);
    // An emptied queue must also clear any stale error banner from a prior
    // rejected drop, otherwise the shell shows "文件夹不支持" over no files.
    if (next.length === 0) uploadError.value = '';
  }

  /** Clear the queue (used after a successful send). */
  function clearFiles(): void {
    commit([]);
  }

  // Keep the mirror in step with external replacements.
  watch(
    () => opts.getPending(),
    (pending) => {
      if (pending !== files.value) files.value = pending;
    },
  );

  return {
    files,
    uploadError,
    addFiles,
    onPaste,
    removeFile,
    clearFiles,
    syncFromPending,
  };
}
