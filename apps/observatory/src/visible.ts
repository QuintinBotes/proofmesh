/** Bidirectional controls and invisible (default-ignorable) characters become visible tokens, so repository text cannot disguise itself. */
export const visible = (s: string): string =>
  s.replace(/[\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/gu, (c) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`)
