import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // These suites hammer the filesystem with temp dirs; the default worker pool made runs
    // hang intermittently. Serial execution keeps them deterministic and is fast enough.
    fileParallelism: false,
    testTimeout: 20_000,
  },
})
