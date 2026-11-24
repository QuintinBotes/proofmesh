import { describe, expect, it } from 'vitest'
import { share } from '../src/share'

describe('A4 percentages need at least 20 sites', () => {
  it('shows the count alone below 20 sites and the rounded percentage from 20 on', () => {
    expect([share(1, 6), share(1, 19), share(5, 20), share(316644, 482436)]).toEqual(['1', '1', '5 (25%)', '316,644 (66%)'])
  })
})
