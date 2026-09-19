import { defineConfig } from 'vitest/config';

// Force Vitest to run everything inside the main Node process so they inherit
// provided Node flags and don't complicate memory tests.
export default defineConfig({
  test: {
    pool: 'threads',
    isolate: false,
  },
  poolOptions: {
    threads: {
      singleThread: true,
    },
  },
});
