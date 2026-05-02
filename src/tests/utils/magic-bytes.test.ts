import { describe, it, expect } from 'vitest';
import { filetypeinfo } from '../../utils/magic-bytes.js';

describe('magic-bytes', () => {
  describe('images', () => {
    it('should detect PNG', () => {
      const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      const result = filetypeinfo(png);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('png');
      expect(result[0].mime).toBe('image/png');
      expect(result[0].extension).toBe('.png');
    });

    it('should detect JPEG', () => {
      const jpeg = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
      const result = filetypeinfo(jpeg);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('jpeg');
      expect(result[0].mime).toBe('image/jpeg');
    });

    it('should detect GIF', () => {
      const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
      const result = filetypeinfo(gif);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('gif');
      expect(result[0].mime).toBe('image/gif');
    });

    it('should detect BMP', () => {
      const bmp = Buffer.from([0x42, 0x4D, 0x00, 0x00]);
      const result = filetypeinfo(bmp);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('bmp');
    });

    it('should detect ICO', () => {
      const ico = Buffer.from([0x00, 0x00, 0x01, 0x00]);
      const result = filetypeinfo(ico);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('ico');
    });

    it('should detect WebP (RIFF...WEBP)', () => {
      // RIFF header + size + WEBP signature
      const webp = Buffer.from([
        0x52, 0x49, 0x46, 0x46, // RIFF
        0x00, 0x00, 0x00, 0x00, // size placeholder
        0x57, 0x45, 0x42, 0x50, // WEBP
      ]);
      const result = filetypeinfo(webp);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('webp');
      expect(result[0].mime).toBe('image/webp');
    });
  });

  describe('audio', () => {
    it('should detect WAV (RIFF...WAVE)', () => {
      const wav = Buffer.from([
        0x52, 0x49, 0x46, 0x46, // RIFF
        0x00, 0x00, 0x00, 0x00, // size placeholder
        0x57, 0x41, 0x56, 0x45, // WAVE
      ]);
      const result = filetypeinfo(wav);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('wav');
      expect(result[0].mime).toBe('audio/wav');
    });

    it('should detect MP3 (frame sync)', () => {
      const mp3 = Buffer.from([0xFF, 0xFB, 0x90, 0x00]);
      const result = filetypeinfo(mp3);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('mp3');
    });

    it('should detect MP3 (ID3 tag)', () => {
      const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x04]);
      const result = filetypeinfo(mp3);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('mp3');
    });

    it('should detect OGG', () => {
      const ogg = Buffer.from([0x4F, 0x67, 0x67, 0x53]);
      const result = filetypeinfo(ogg);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('ogg');
    });

    it('should detect FLV', () => {
      const flv = Buffer.from([0x46, 0x4C, 0x56, 0x01]);
      const result = filetypeinfo(flv);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('flv');
    });
  });

  describe('video', () => {
    it('should detect MP4 (ftyp box)', () => {
      // ftyp box at offset 4
      const mp4 = Buffer.from([
        0x00, 0x00, 0x00, 0x20, // box size
        0x66, 0x74, 0x79, 0x70, // ftyp
        0x69, 0x73, 0x6F, 0x6D, // isom brand
      ]);
      const result = filetypeinfo(mp4);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('mp4');
    });

    it('should detect MKV', () => {
      const mkv = Buffer.from([0x1A, 0x45, 0xDF, 0xA3]);
      const result = filetypeinfo(mkv);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('mkv');
    });
  });

  describe('archives', () => {
    it('should detect ZIP', () => {
      const zip = Buffer.from([0x50, 0x4B, 0x03, 0x04]);
      const result = filetypeinfo(zip);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('zip');
    });

    it('should detect empty ZIP', () => {
      const emptyZip = Buffer.from([0x50, 0x4B, 0x05, 0x06]);
      const result = filetypeinfo(emptyZip);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('zip');
    });

    it('should detect GZIP', () => {
      const gzip = Buffer.from([0x1F, 0x8B, 0x08]);
      const result = filetypeinfo(gzip);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('gzip');
    });

    it('should detect RAR', () => {
      const rar = Buffer.from([0x52, 0x61, 0x72, 0x21]);
      const result = filetypeinfo(rar);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('rar');
    });

    it('should detect 7z', () => {
      const sevenZ = Buffer.from([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]);
      const result = filetypeinfo(sevenZ);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('7z');
    });

    it('should detect TAR (ustar at offset 257)', () => {
      // TAR file with ustar signature at offset 257
      const tar = Buffer.alloc(300);
      tar[257] = 0x75; // u
      tar[258] = 0x73; // s
      tar[259] = 0x74; // t
      tar[260] = 0x61; // a
      tar[261] = 0x72; // r
      const result = filetypeinfo(tar);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('tar');
    });
  });

  describe('documents', () => {
    it('should detect PDF', () => {
      const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2D]); // %PDF-
      const result = filetypeinfo(pdf);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('pdf');
    });
  });

  describe('executables', () => {
    it('should detect EXE (MZ header)', () => {
      const exe = Buffer.from([0x4D, 0x5A, 0x90, 0x00]);
      const result = filetypeinfo(exe);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('exe');
    });

    it('should detect ELF', () => {
      const elf = Buffer.from([0x7F, 0x45, 0x4C, 0x46]); // ELF
      const result = filetypeinfo(elf);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('elf');
    });

    it('should detect Mach-O', () => {
      const macho = Buffer.from([0xCA, 0xFE, 0xBA, 0xBE]);
      const result = filetypeinfo(macho);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('macho');
    });
  });

  describe('database', () => {
    it('should detect SQLite', () => {
      const sqlite = Buffer.from([0x53, 0x51, 0x4C, 0x69, 0x74, 0x65]); // SQLite
      const result = filetypeinfo(sqlite);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('sqlite');
    });
  });

  describe('edge cases', () => {
    it('should return empty array for empty buffer', () => {
      const result = filetypeinfo(Buffer.alloc(0));
      expect(result).toHaveLength(0);
    });

    it('should return empty array for unknown signature', () => {
      const unknown = Buffer.from([0x00, 0x00, 0x00, 0x00]);
      const result = filetypeinfo(unknown);
      expect(result).toHaveLength(0);
    });

    it('should return empty array for partial signature', () => {
      // PNG signature is 8 bytes, only provide 3
      const partial = Buffer.from([0x89, 0x50, 0x4E]);
      const result = filetypeinfo(partial);
      expect(result).toHaveLength(0);
    });

    it('should handle Uint8Array input', () => {
      const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      const result = filetypeinfo(png);
      expect(result).toHaveLength(1);
      expect(result[0].typename).toBe('png');
    });

    it('should distinguish WebP from WAV (both RIFF)', () => {
      // WebP
      const webp = Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
        0x57, 0x45, 0x42, 0x50,
      ]);
      expect(filetypeinfo(webp)[0].typename).toBe('webp');

      // WAV
      const wav = Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
        0x57, 0x41, 0x56, 0x45,
      ]);
      expect(filetypeinfo(wav)[0].typename).toBe('wav');
    });

    it('should return empty for RIFF without WEBP/WAVE', () => {
      const riff = Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
        0x58, 0x58, 0x58, 0x58, // Unknown format
      ]);
      const result = filetypeinfo(riff);
      expect(result).toHaveLength(0);
    });
  });
});