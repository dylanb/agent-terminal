import { describe, expect, it } from 'vitest'
import { stepLabel } from '../../src/shared/stepLabel'

describe('stepLabel', () => {
  it('turns an id into a sentence-case label', () => {
    expect(stepLabel('groom')).toBe('Groom')
    expect(stepLabel('plan-approve')).toBe('Plan approve')
    expect(stepLabel('integration-slice')).toBe('Integration slice')
    expect(stepLabel('dev')).toBe('Dev')
    expect(stepLabel('')).toBe('')
  })
})
