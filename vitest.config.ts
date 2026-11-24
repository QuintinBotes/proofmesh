import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    globalSetup: ['packages/proofmesh/test/global-setup.ts'],
    testTimeout: 60000,
    hookTimeout: 180000,
    pool: 'forks',
  },
})
