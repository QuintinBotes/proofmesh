import { describe, expect, it } from 'vitest'
import { visible } from '../src/visible'

describe('FR065 repository text shows every bidirectional control and invisible character as a visible token', () => {
  it('FR065 each bidirectional control becomes its code point', () => {
    expect(visible('a\u202Ab\u202Bc\u202Cd\u202De\u202Ef')).toBe('a⟨U+202A⟩b⟨U+202B⟩c⟨U+202C⟩d⟨U+202D⟩e⟨U+202E⟩f')
    expect(visible('\u2066x\u2067y\u2068z\u2069')).toBe('⟨U+2066⟩x⟨U+2067⟩y⟨U+2068⟩z⟨U+2069⟩')
    expect(visible('\u200Eleft\u200Fright\u061Carabic')).toBe('⟨U+200E⟩left⟨U+200F⟩right⟨U+061C⟩arabic')
  })

  it('FR065 invisible characters, including those valid inside identifiers, become their code points', () => {
    expect(visible('zero\u200Bwidth\u200Cnon\u200Djoin')).toBe('zero⟨U+200B⟩width⟨U+200C⟩non⟨U+200D⟩join')
    expect(visible('\uFEFFword\u2060joiner\u00ADsoft')).toBe('⟨U+FEFF⟩word⟨U+2060⟩joiner⟨U+00AD⟩soft')
    expect(visible('let \u3164 = \uFFA0\u115F')).toBe('let ⟨U+3164⟩ = ⟨U+FFA0⟩⟨U+115F⟩')
    expect(visible('tag\u{E0041}\u{E0042}')).toBe('tag⟨U+E0041⟩⟨U+E0042⟩')
  })

  it('FR065 ordinary text, markup and whitespace are left as they are, for React to render as text', () => {
    const plain = 'formatAmount(<img src=x onerror=alert(1)>)\n\tCafé 数字 Ωmega ✓'
    expect(visible(plain)).toBe(plain)
  })
})
