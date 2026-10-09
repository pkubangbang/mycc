import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    // Belt-and-braces: NOTHING outside src/tests is a test file. In particular
    // `scripts/tp-violation/` holds a MANUAL, live-provider diagnostic
    // (`main.mjs` / `probe.mjs` / `deepseek.mjs` / `ollama.mjs`) that posts
    // real requests. It is run by hand, never by `pnpm test`; this exclude makes
    // that invariant explicit so a future include-glob edit cannot silently
    // sweep it in.
    exclude: ['**/node_modules/**', '**/dist/**', 'scripts/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/tests/**', 'src/index.ts', 'src/lead.ts'],
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});