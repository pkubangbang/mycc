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
      // Ratchet: these floors only guard against a test deletion that
      // silently drops coverage. They are deliberately set below the
      // measured baseline and must be raised (never lowered) once a higher
      // baseline is established — see TESTING_STANDARDS.md.
      // Requires `@vitest/coverage-v8` (`pnpm add -D @vitest/coverage-v8`);
      // it is in pnpm-lock.yaml but not declared in package.json yet.
      // thresholds: { lines: 0, branches: 0, functions: 0 },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});