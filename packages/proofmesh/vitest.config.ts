import { defineConfig } from 'vitest/config'
import repo from '../../vitest.config'

// vitest looks for a config only in the directory it starts in. Started here without one, a test got vitest's 5 s timeout
// and git ran the person's hooks on each fixture commit, seconds apiece on a busy machine, so the aider parity tests timed out (#225).
export default defineConfig({ ...repo, root: import.meta.dirname, test: { ...repo.test, include: ['test/**/*.test.ts'], globalSetup: ['test/global-setup.ts'] } })
