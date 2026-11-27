import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    globalSetup: ['packages/proofmesh/test/global-setup.ts'],
    testTimeout: 60000,
    hookTimeout: 180000,
    pool: 'forks',
    // Tests commit to throwaway repositories; the person's own git hooks (a global core.hooksPath) would run on each commit, seconds apiece under load (#186).
    env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' },
  },
})
