import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  outputDir: 'test-results',
  reporter: [['list']],
  timeout: 60000,
  workers: 1,
  use: { ...(process.env.PROOFMESH_E2E_CHANNEL ? { channel: process.env.PROOFMESH_E2E_CHANNEL } : {}), headless: true, viewport: { width: 1400, height: 900 } },
})
