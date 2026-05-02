/**
 * magic-bytes.ts - Simple file type detection using magic bytes
 *
 * A lightweight alternative to magic-bytes.js for detecting common binary formats.
 * Only includes the most common file types needed for text/binary detection.
 */

export interface FileInfo {
  typename: string;
  mime?: string;
  extension?: string;
}

/**
 * Magic byte signatures for common binary formats
 * Format: [byte sequence, typename, mime, extension]
 * Note: RIFF-based formats (WebP, WAV) handled separately due to shared prefix
 */
const SIGNATURES: Array<[number[], string, string, string]> = [
  // Images
  [[0x89, 0x50, 0x4E, 0x47], 'png', 'image/png', '.png'],
  [[0xFF, 0xD8, 0xFF], 'jpeg', 'image/jpeg', '.jpg'],
  [[0x47, 0x49, 0x46, 0x38], 'gif', 'image/gif', '.gif'],
  [[0x42, 0x4D], 'bmp', 'image/bmp', '.bmp'],
  [[0x00, 0x00, 0x01, 0x00], 'ico', 'image/x-icon', '.ico'],

  // Archives
  [[0x50, 0x4B, 0x03, 0x04], 'zip', 'application/zip', '.zip'],
  [[0x50, 0x4B, 0x05, 0x06], 'zip', 'application/zip', '.zip'], // Empty zip
  [[0x1F, 0x8B], 'gzip', 'application/gzip', '.gz'],
  [[0x52, 0x61, 0x72, 0x21], 'rar', 'application/x-rar', '.rar'],
  [[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C], '7z', 'application/x-7z-compressed', '.7z'],

  // Documents
  [[0x25, 0x50, 0x44, 0x46], 'pdf', 'application/pdf', '.pdf'], // %PDF

  // Audio/Video
  [[0xFF, 0xFB], 'mp3', 'audio/mpeg', '.mp3'],
  [[0x49, 0x44, 0x33], 'mp3', 'audio/mpeg', '.mp3'], // ID3
  [[0x1A, 0x45, 0xDF, 0xA3], 'mkv', 'video/x-matroska', '.mkv'],
  [[0x4F, 0x67, 0x67, 0x53], 'ogg', 'audio/ogg', '.ogg'],
  [[0x46, 0x4C, 0x56], 'flv', 'video/x-flv', '.flv'],

  // Executables
  [[0x4D, 0x5A], 'exe', 'application/octet-stream', '.exe'], // MZ
  [[0x7F, 0x45, 0x4C, 0x46], 'elf', 'application/octet-stream', '.elf'], // ELF
  [[0xCA, 0xFE, 0xBA, 0xBE], 'macho', 'application/octet-stream', '.dylib'],

  // Database
  [[0x53, 0x51, 0x4C, 0x69], 'sqlite', 'application/x-sqlite3', '.sqlite'], // SQLi
];

/**
 * Detect file type from magic bytes
 * Returns file info if a known signature is matched
 */
export function filetypeinfo(buffer: Uint8Array): FileInfo[] {
  // Handle empty buffer
  if (!buffer || buffer.length === 0) {
    return [];
  }

  const arr = buffer instanceof Buffer ? new Uint8Array(buffer) : buffer;

  // Special check for RIFF-based formats (WebP and WAV share RIFF prefix)
  if (arr.length > 11 && arr[0] === 0x52 && arr[1] === 0x49 && arr[2] === 0x46 && arr[3] === 0x46) {
    // Check bytes 8-11 for WEBP or WAVE
    if (arr[8] === 0x57 && arr[9] === 0x45 && arr[10] === 0x42 && arr[11] === 0x50) {
      return [{ typename: 'webp', mime: 'image/webp', extension: '.webp' }];
    }
    if (arr[8] === 0x57 && arr[9] === 0x41 && arr[10] === 0x56 && arr[11] === 0x45) {
      return [{ typename: 'wav', mime: 'audio/wav', extension: '.wav' }];
    }
  }

  // Check standard signatures
  for (const [signature, typename, mime, extension] of SIGNATURES) {
    if (matchesSignature(arr, signature)) {
      return [{ typename, mime, extension }];
    }
  }

  // Special check for MP4 (ftyp box at offset 4)
  if (arr.length > 8 && arr[4] === 0x66 && arr[5] === 0x74 && arr[6] === 0x79 && arr[7] === 0x70) {
    return [{ typename: 'mp4', mime: 'video/mp4', extension: '.mp4' }];
  }

  // Special check for tar (ustar at offset 257)
  if (arr.length > 262 && arr[257] === 0x75 && arr[258] === 0x73 && arr[259] === 0x74 && arr[260] === 0x61 && arr[261] === 0x72) {
    return [{ typename: 'tar', mime: 'application/x-tar', extension: '.tar' }];
  }

  return [];
}

/**
 * Check if buffer starts with a signature
 */
function matchesSignature(buffer: Uint8Array, signature: number[]): boolean {
  if (buffer.length < signature.length) {
    return false;
  }
  for (let i = 0; i < signature.length; i++) {
    if (buffer[i] !== signature[i]) {
      return false;
    }
  }
  return true;
}