import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * Vitest configuration.
 *
 * This project had no test framework at all, and that turned out to be the
 * single most expensive omission in its history. Two separate audit passes
 * found the *same* bug class twice — server actions addressing a column that
 * did not exist — and both times it passed `tsc`, `eslint`, `next build` and
 * every route and status check. A test asserting "the follow count changes
 * after toggling" would have caught it in seconds.
 *
 * The `server` environment (Node) is used for the logic tests, which cover the
 * pure decision-making that broke most often: rate limiting, cursor
 * validation, input validation and the projection ladder. A `jsdom` project
 * covers the rendering and accessibility assertions.
 *
 * Tests must not reach the network. `@/lib/env` is stubbed in `setup.ts` with
 * dummy-but-valid values so importing a module never throws, and every database
 * interaction is asserted against a fake client rather than a live one.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    setupFiles: ['./src/tests/setup.ts'],
    environment: 'node',
    include: ['src/tests/**/*.test.ts', 'src/tests/**/*.test.tsx'],
    // Logic tests run in Node. Rendering/a11y tests opt into jsdom with a
    // `@vitest-environment jsdom` docblock, so a single include list cannot
    // silently drift out of sync with a second project's list.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/lib/**/*.ts', 'src/app/actions/**/*.ts'],
      exclude: ['src/lib/database.types.ts'],
    },
  },
});